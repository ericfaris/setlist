#!/usr/bin/env python3
"""Build a Music Trivia question bank from the user's YouTube Music playlists.

Run this by hand, offline. It is never invoked by the Node server — the server
just reads the JSON file this writes (default: <repo>/question-bank/bank.json).

Each playlist becomes a board category; each song becomes a question carrying
its title, artist and YouTube video id.

One-time setup (see the repo README for the long version):

    /usr/bin/python3 -m venv scripts/questionbank/.venv
    scripts/questionbank/.venv/bin/pip install -r scripts/questionbank/requirements.txt
    scripts/questionbank/.venv/bin/ytmusicapi oauth \\
        --client-id <ID> --client-secret <SECRET> \\
        --file scripts/questionbank/oauth.json

Then:

    scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py

Never use a bare `python`/`pip` — always the venv's interpreter.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent

# Mirrors POINT_VALUES in packages/shared/src/types.ts. The value written here
# is only a *suggestion* — the engine assigns the authoritative value from the
# board row when it lays out the game. It's kept so a hand-edited bank reads
# sensibly.
POINT_VALUES = [100, 200, 300, 400, 500]

BANK_VERSION = 1

# Mirrors BOARD_COLUMNS in packages/shared/src/types.ts. Hardcoded rather than
# parsed out of the TS source: the builder already mirrors POINT_VALUES the same
# way, and a 5-line TS parser is more fragile than a constant with a comment.
DEFAULT_CATEGORIES = 5

# Anthropic defaults. Same env var name and default model as the sibling
# pinpoint project (/home/eric/projects/pinpoint/.env.example).
DEFAULT_MODEL = "claude-haiku-4-5-20251001"

# Upper bound on how many songs go into the AI prompt, to bound tokens.
AI_POOL_LIMIT = 300

# YouTube Data API v3 — used only to pre-filter songs with embedding disabled
# by the rights holder (common on major-label official videos). Those videos
# can't play in ANY embedded player, on any site — this is a per-video
# publisher setting, not a bug. Without this check they'd only surface as an
# in-game "Embedding disabled" error the host has to Skip past.
YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3/videos"
YOUTUBE_BATCH_SIZE = 50


class BuildError(Exception):
    """A fatal, user-actionable problem."""


class AIUnavailable(Exception):
    """The AI pass could not be used. Never fatal — the caller falls back to
    one category per playlist, which is the builder's original behaviour."""


# --------------------------------------------------------------------------
# Parsing helpers. ytmusicapi is unofficial and its response shapes drift
# between versions, so every field is treated as optional and odd entries are
# skipped with a count rather than crashing the run.
# --------------------------------------------------------------------------


def artist_string(track: dict[str, Any]) -> str:
    artists = track.get("artists") or []
    names = []
    for a in artists:
        if isinstance(a, dict):
            name = a.get("name")
        else:
            name = a
        if isinstance(name, str) and name.strip():
            names.append(name.strip())
    return ", ".join(names)


def album_string(track: dict[str, Any]) -> str | None:
    album = track.get("album")
    if isinstance(album, dict):
        name = album.get("name")
        return name if isinstance(name, str) and name.strip() else None
    if isinstance(album, str) and album.strip():
        return album
    return None


def duration_seconds(track: dict[str, Any]) -> int | None:
    raw = track.get("duration_seconds")
    if isinstance(raw, int) and raw > 0:
        return raw
    if isinstance(raw, str) and raw.isdigit():
        return int(raw)
    return None


def usable_track(track: Any) -> dict[str, Any] | None:
    """Return a normalised question dict, or None if the entry is unusable.

    Skips unavailable tracks, podcast episodes and video-type entries with no
    playable videoId, anything missing a title or an artist, and anything YT
    Music itself flags `isExplicit`.
    """
    if not isinstance(track, dict):
        return None
    video_id = track.get("videoId")
    title = track.get("title")
    if not isinstance(video_id, str) or not video_id.strip():
        return None
    if not isinstance(title, str) or not title.strip():
        return None
    artist = artist_string(track)
    if not artist:
        return None
    if track.get("isAvailable") is False:
        return None
    # Authoritative, non-negotiable content filter: YT Music's own flag. Applied
    # here so every ingestion path (library, community, AI, fallback) gets it, and
    # so no explicit track can ever reach the AI prompt. `is True` is deliberate —
    # a missing/None/unknown value must not drop the track.
    if track.get("isExplicit") is True:
        return None
    return {
        "id": f"q_{video_id}",
        "title": title.strip(),
        "artist": artist,
        "videoId": video_id,
        "album": album_string(track),
        "durationSeconds": duration_seconds(track),
        "value": POINT_VALUES[0],
        "startSeconds": None,
    }


def playlist_matches(playlist: dict[str, Any], selectors: Sequence[str]) -> bool:
    if not selectors:
        return True
    pid = str(playlist.get("playlistId") or "")
    title = str(playlist.get("title") or "").lower()
    for sel in selectors:
        if sel == pid:
            return True
        if sel.lower() in title:
            return True
    return False


# --------------------------------------------------------------------------
# Community / public playlist ingestion. Pure-ish helpers, kept above
# build_bank() so they are testable without a build.
# --------------------------------------------------------------------------

# Prefixes YT Music uses for the various playlist-ish browse ids.
_PLAYLIST_ID_PREFIXES = ("PL", "OLAK5uy_", "RD", "VL", "MPREb")
_PLAYLIST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,}$")


def parse_playlist_id(value: str) -> str:
    """Extract a bare playlist id from a raw id or a pasted YT Music URL.

    Supported forms:

      PLxxxxxxxxxx                                        (bare id)
      VLPLxxxxxxxxxx                                      (browse id; VL stripped)
      https://music.youtube.com/playlist?list=PLxxxxxxxxxx
      https://www.youtube.com/playlist?list=PLxxxxxxxxxx
      https://music.youtube.com/watch?v=abc&list=PLxxxxxxxxxx
      https://youtu.be/abc?list=PLxxxxxxxxxx
      https://music.youtube.com/browse/VLPLxxxxxxxxxx

    Raises BuildError with the offending string when nothing usable is found.
    """
    raw = (value or "").strip()
    if not raw:
        raise BuildError("Empty --community-playlist value.")

    lowered = raw.lower()
    if not lowered.startswith(("http://", "https://")) and "/" not in raw:
        candidate = raw
    else:
        parsed = urllib.parse.urlparse(raw)
        query = urllib.parse.parse_qs(parsed.query)
        segments = [s for s in parsed.path.split("/") if s]
        candidate = ""
        if query.get("list"):
            candidate = query["list"][0].strip()
        elif "browse" in segments:
            idx = segments.index("browse")
            if idx + 1 < len(segments):
                candidate = segments[idx + 1]
        if not candidate and segments and segments[-1].startswith(_PLAYLIST_ID_PREFIXES):
            candidate = segments[-1]

    # YT Music browse ids are "VL" + playlistId; get_playlist() wants the bare
    # id and re-adds the prefix itself.
    if candidate.startswith("VL"):
        candidate = candidate[2:]

    if not _PLAYLIST_ID_RE.match(candidate):
        raise BuildError(
            f"Could not read a playlist id out of {value!r}. Pass the id itself "
            "(PL…) or a music.youtube.com playlist URL."
        )
    return candidate


def search_community_playlist(client: Any, query: str, log: Any) -> dict[str, Any] | None:
    """Search YT Music's community playlists and return the first usable hit.

    No ranking: YT Music's own relevance order is the ranking, and any heuristic
    we layered on top would be unexplainable to the user. The pick is logged
    instead so it can be sanity-checked.
    """
    try:
        results = client.search(query, filter="community_playlists", limit=20) or []
    except Exception as exc:  # unofficial API — one bad query must not abort the run
        log(f"  skip: community search {query!r} failed: {exc}")
        return None

    for entry in results:
        if not isinstance(entry, dict):
            continue
        result_type = entry.get("resultType")
        if result_type is not None and result_type != "playlist":
            continue
        pid = entry.get("playlistId") or entry.get("browseId")
        if not isinstance(pid, str) or not pid.strip():
            continue
        try:
            pid = parse_playlist_id(pid)
        except BuildError:
            continue
        hit = {
            "playlistId": pid,
            "title": entry.get("title") or pid,
            "author": entry.get("author"),
            "itemCount": entry.get("itemCount"),
        }
        author = hit["author"]
        if isinstance(author, dict):
            author = author.get("name")
        by = f" by {author}" if author else ""
        count = f", {hit['itemCount']} items" if hit["itemCount"] else ""
        log(f"  community search {query!r} -> {hit['title']!r}{by} ({pid}{count})")
        return hit

    log(f"  skip: community search {query!r} returned no usable playlist")
    return None


# --------------------------------------------------------------------------
# YouTube embeddable pre-check. Optional: needs a Google/YouTube Data API v3
# key (separate from the ytmusicapi OAuth used above — a plain API key, no
# OAuth flow). `session` is anything with a `.get(url, params=...)` method
# returning an object with `.json()` — i.e. a `requests.Session`, or a fake in
# tests. Never constructed by build_bank() itself, so no test can reach the
# network or pick up a real key.
# --------------------------------------------------------------------------


def check_embeddable(session: Any, api_key: str, video_ids: Iterable[str], log: Any) -> dict[str, bool]:
    """Return {videoId: embeddable} for every id YouTube's API actually
    returns. An id it doesn't return at all (deleted/private, or dropped by a
    failed batch) is simply absent from the result — the caller treats that as
    "unknown", not "not embeddable", so a network hiccup can't silently nuke
    songs that are actually fine.
    """
    result: dict[str, bool] = {}
    ids = list(dict.fromkeys(video_ids))  # de-dupe, keep order
    for i in range(0, len(ids), YOUTUBE_BATCH_SIZE):
        batch = ids[i : i + YOUTUBE_BATCH_SIZE]
        try:
            resp = session.get(
                YOUTUBE_API_BASE,
                params={"part": "status", "id": ",".join(batch), "key": api_key},
                timeout=15,
            )
            data = resp.json()
        except Exception as exc:  # network error, bad response, anything
            log(f"  warning: YouTube embeddable check failed for a batch of {len(batch)}: {exc}")
            continue
        if isinstance(data, dict) and "error" in data:
            err = data["error"]
            message = err.get("message", err) if isinstance(err, dict) else err
            log(f"  warning: YouTube API error: {message}")
            continue
        items = data.get("items") if isinstance(data, dict) else None
        for item in items or []:
            if not isinstance(item, dict):
                continue
            vid = item.get("id")
            status = item.get("status")
            embeddable = status.get("embeddable") if isinstance(status, dict) else None
            if isinstance(vid, str) and isinstance(embeddable, bool):
                result[vid] = embeddable
    return result


def filter_embeddable(
    session: Any, api_key: str, sources: Sequence[dict], opts: "BuildOptions", log: Any
) -> list[dict]:
    """Drop tracks the YouTube Data API reports as not embeddable, from every
    source uniformly. A source that falls below `min_songs` afterwards is
    dropped entirely, same as during collection."""
    all_ids = [q["videoId"] for src in sources for q in src["questions"]]
    if not all_ids:
        return list(sources)

    log(f"Checking embeddable status for {len(all_ids)} video(s) via the YouTube Data API…")
    status = check_embeddable(session, api_key, all_ids, log)

    dropped = 0
    filtered: list[dict] = []
    for src in sources:
        # Unknown (id absent from the API response) defaults to KEEP — the
        # opposite default from the isExplicit content filter, deliberately:
        # a false negative here just means an occasional in-game Skip, while
        # over-dropping here would quietly starve a category for no reason.
        kept = [q for q in src["questions"] if status.get(q["videoId"], True)]
        dropped += len(src["questions"]) - len(kept)
        if len(kept) < opts.min_songs:
            log(
                f"  skip: {src['title']!r} dropped below {opts.min_songs} songs "
                "after the embeddable check"
            )
            continue
        filtered.append({**src, "questions": kept})

    if dropped:
        log(f"  dropped {dropped} track(s) with embedding disabled by the owner")
    return filtered


# --------------------------------------------------------------------------
# The build itself, against an injected client so tests can mock it entirely.
# --------------------------------------------------------------------------


class BuildOptions:
    def __init__(
        self,
        playlists: Sequence[str] = (),
        max_categories: int = 8,
        songs_per_category: int = 8,
        min_songs: int = 5,
        seed: int | None = None,
        community_playlists: Sequence[str] = (),
        community_searches: Sequence[str] = (),
        categories: int = DEFAULT_CATEGORIES,
        no_ai: bool = False,
        youtube_api_key: str | None = None,
        no_library: bool = False,
    ) -> None:
        self.playlists = list(playlists)
        # Caps how many *source playlists* are read.
        self.max_categories = max_categories
        self.songs_per_category = songs_per_category
        self.min_songs = min_songs
        self.seed = seed
        self.community_playlists = list(community_playlists)
        self.community_searches = list(community_searches)
        # Caps how many *AI categories* come out. Unused on the fallback path.
        self.categories = categories
        self.no_ai = no_ai
        self.youtube_api_key = youtube_api_key
        # Community sources are additive by default; this opts OUT of the
        # library entirely (e.g. "just build from these community playlists").
        self.no_library = no_library


def collect_sources(client: Any, opts: BuildOptions, rng: random.Random, log: Any) -> list[dict]:
    """Read every requested playlist and return usable source dicts.

    Each source is `{"playlistId": str, "title": str, "questions": [...]}`.
    Video ids are deduped globally across sources.
    """
    # Community sources are ADDITIVE: your library is included by default no
    # matter what community flags are given (--playlists still narrows it to a
    # subset, same as before). Only --no-library drops it. Community flags used
    # to silently *replace* the library instead of adding to it — a real bug,
    # not the intended "diverse broad genres" behaviour.
    use_library = not opts.no_library

    candidates: list[tuple[str, str | None]] = []

    if use_library:
        playlists = client.get_library_playlists(limit=100) or []
        selected = [
            p for p in playlists if isinstance(p, dict) and playlist_matches(p, opts.playlists)
        ]
        if not selected:
            raise BuildError(
                "No playlists matched. Check --playlists, or run without it to use them all."
            )
        for playlist in selected:
            pid = playlist.get("playlistId")
            title = playlist.get("title") or "Untitled playlist"
            if not isinstance(pid, str) or not pid:
                log(f"  skip: playlist {title!r} has no playlistId")
                continue
            candidates.append((pid, str(title)))

    for value in opts.community_playlists:
        candidates.append((parse_playlist_id(value), None))

    for query in opts.community_searches:
        hit = search_community_playlist(client, query, log)
        if hit is not None:
            candidates.append((hit["playlistId"], hit["title"]))

    seen_video_ids: set[str] = set()
    seen_playlist_ids: set[str] = set()
    sources: list[dict[str, Any]] = []

    for pid, known_title in candidates:
        if len(sources) >= opts.max_categories:
            break
        if pid in seen_playlist_ids:
            continue
        seen_playlist_ids.add(pid)

        try:
            detail = client.get_playlist(pid, limit=200) or {}
        except Exception as exc:  # unofficial API — one bad playlist isn't fatal
            log(f"  skip: could not read playlist {pid}: {exc}")
            continue
        tracks: Iterable[Any] = detail.get("tracks") or []
        title = known_title or detail.get("title") or pid

        questions: list[dict[str, Any]] = []
        skipped = 0
        for track in tracks:
            q = usable_track(track)
            if q is None:
                skipped += 1
                continue
            # Global dedupe: the same song in two playlists would otherwise
            # become two board cells sharing one answer.
            if q["videoId"] in seen_video_ids:
                skipped += 1
                continue
            seen_video_ids.add(q["videoId"])
            questions.append(q)

        if len(questions) < opts.min_songs:
            log(
                f"  skip: {title!r} has only {len(questions)} usable songs "
                f"(need {opts.min_songs})"
            )
            # Release its ids so a later playlist can still use those songs.
            for q in questions:
                seen_video_ids.discard(q["videoId"])
            continue

        sources.append({"playlistId": pid, "title": str(title), "questions": questions})
        log(f"  {title}: {len(questions)} songs ({skipped} skipped)")

    if not sources:
        raise BuildError(
            f"No playlist had at least {opts.min_songs} usable songs. "
            "Lower --min-songs or pick fuller playlists."
        )
    return sources


def categories_from_sources(
    sources: Sequence[dict], opts: BuildOptions, rng: random.Random
) -> list[dict[str, Any]]:
    """One category per source playlist — the builder's original behaviour, and
    the fallback whenever the AI pass is unavailable."""
    categories: list[dict[str, Any]] = []
    for source in sources:
        questions = list(source["questions"])
        if len(questions) > opts.songs_per_category:
            questions = rng.sample(questions, opts.songs_per_category)
        for i, q in enumerate(questions):
            q["value"] = POINT_VALUES[min(i, len(POINT_VALUES) - 1)]
        categories.append(
            {
                "id": f"cat_{source['playlistId']}",
                "title": source["title"],
                "playlistId": source["playlistId"],
                "questions": questions,
            }
        )
    return categories


# --------------------------------------------------------------------------
# AI categorisation. One batch call per run; the model only groups, titles and
# flags songs ytmusicapi already returned — it never names or invents one.
#
# Tradeoff, deliberately taken: categorisation and the content-safety pass
# share a single request. One request means one song enumeration, so "song 17
# is blocked" and "song 17 is in category 2" refer to the same track by
# construction. Two calls would isolate parse failures (a malformed
# categorisation reply could still yield usable safety flags) and each reply
# would be simpler to parse — but they would also mean two enumerations that
# must stay byte-identical, and any drift silently mis-targets the *safety*
# verdicts. With one call a parse failure loses both and we fall back to one
# category per playlist with no AI safety pass; that is acceptable because
# `isExplicit` is the authoritative filter and always runs before the AI is
# consulted, and the fallback is exactly today's shipped behaviour. Anything
# the AI does flag is always dropped.
# --------------------------------------------------------------------------


def build_ai_prompt(songs: Sequence[dict], n_categories: int, min_songs: int) -> str:
    """Build the single user message. Only titles and artists go in — never a
    videoId — and the model answers in 1-based indices into this list."""
    lines = []
    for i, song in enumerate(songs):
        # 1-based in the prompt (models are more reliable with it); converted
        # back to 0-based on the way in, in parse_ai_response().
        lines.append('{}. "{}" — {}'.format(i + 1, song["title"], song["artist"]))
    listing = "\n".join(lines)
    return (
        "You are helping build a family-friendly music trivia game board.\n\n"
        "Below is a numbered list of real songs. Do TWO things:\n\n"
        f"1. Group them into exactly {n_categories} fun, cross-cutting trivia "
        'categories with short, punchy titles (e.g. "Songs About Cars", '
        '"One-Hit Wonders", "80s Power Ballads"). Titles must be 40 characters '
        "or fewer. Use only the numbers below — never invent, rename, or "
        "substitute a song. Each song belongs to at most one category. It is "
        "fine to leave songs out if they fit nowhere. Aim for at least "
        f"{min_songs} songs per category. Favor DECADE DIVERSITY: if the list "
        "has enough recognizable songs from the 1960s and/or 1970s (using what "
        "you know about each song's actual release era), make sure at least "
        "one category highlights that music — e.g. \"60s Classics\" or \"70s "
        "Gold\" — rather than letting every category cluster into the eras "
        "that happen to be most common in the list.\n\n"
        "2. Separately, flag any song whose title or artist name alone looks "
        "inappropriate for a family party setting (sexual content, slurs, "
        "graphic violence, drug glorification). Be conservative: when in doubt, "
        "flag it. Flagged songs must NOT also appear in any category.\n\n"
        f"Songs:\n{listing}\n\n"
        "Respond with ONLY a JSON object of this exact shape and nothing else:\n"
        '{"categories": [{"title": "...", "songs": [1, 5, 9]}], "blocked": [3, 7]}'
    )


def _balanced_json_slice(text: str) -> str | None:
    """Return the brace-balanced substring starting at the first '{'.

    Better than a greedy /\\{[\\s\\S]*\\}/ here: a truncated reply's trailing
    prose would otherwise poison the match.
    """
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def _strip_fences(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    lines = stripped.splitlines()
    lines = lines[1:]  # drop the ```json / ``` opener
    while lines and lines[-1].strip().startswith("```"):
        lines.pop()
    return "\n".join(lines).strip()


def _first_list(obj: dict, *keys: str) -> list:
    for key in keys:
        value = obj.get(key)
        if isinstance(value, list):
            return value
    return []


def _as_index(value: Any) -> int | None:
    """Coerce a 1-based index (int or numeric string) to 0-based, or None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        n = value
    elif isinstance(value, str) and value.strip().lstrip("+-").isdigit():
        n = int(value.strip())
    else:
        return None
    return n - 1 if n >= 1 else None


def parse_ai_response(raw: str) -> tuple[list[dict], list[int]]:
    """Parse the model's reply into (categories, blocked), 0-based.

    Mirrors pinpoint's extractNames() philosophy — prefer JSON, degrade
    permissively — but for a nested payload line-parsing is meaningless, so the
    permissive layer is fence-stripping, brace-slicing and per-field tolerance.
    Never raises on a weird field; it just skips it.
    """
    parsed: Any = None
    attempts: list[str] = [raw.strip() if raw else ""]
    fenced = _strip_fences(raw or "")
    attempts.append(fenced)
    sliced = _balanced_json_slice(fenced) or _balanced_json_slice(raw or "")
    if sliced:
        attempts.append(sliced)
        attempts.append(re.sub(r",\s*([}\]])", r"\1", sliced))
    for attempt in attempts:
        if not attempt:
            continue
        try:
            candidate = json.loads(attempt)
        except (ValueError, TypeError):
            continue
        if isinstance(candidate, dict):
            parsed = candidate
            break
    if parsed is None:
        raise AIUnavailable("could not parse the model's reply as JSON")

    blocked: list[int] = []
    for value in _first_list(parsed, "blocked", "flagged", "excluded"):
        idx = _as_index(value)
        if idx is not None and idx not in blocked:
            blocked.append(idx)

    categories: list[dict] = []
    claimed: set[int] = set()
    for entry in _first_list(parsed, "categories", "groups"):
        if not isinstance(entry, dict):
            continue
        title = entry.get("title")
        if not isinstance(title, str) or not title.strip():
            title = entry.get("name")
        if not isinstance(title, str) or not title.strip():
            continue
        indices: list[int] = []
        for value in _first_list(entry, "songs", "indices", "tracks", "items"):
            idx = _as_index(value)
            if idx is None or idx in claimed:
                continue
            claimed.add(idx)
            indices.append(idx)
        categories.append({"title": title.strip()[:60], "songs": indices})

    if not categories:
        raise AIUnavailable("the model returned no usable categories")
    return categories, blocked


def call_ai(ai_client: Any, prompt: str, model: str, log: Any) -> str:
    """Make the one request and return the reply text. Every failure mode — an
    API error, a refusal, a truncation, a reply with no text — becomes
    AIUnavailable, so the caller can fall back instead of crashing."""
    try:
        response = ai_client.messages.create(
            model=model,
            max_tokens=8000,
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as exc:  # APIError, timeout, auth — anything at all
        raise AIUnavailable(f"the API call failed: {exc}") from exc

    stop_reason = getattr(response, "stop_reason", None)
    if stop_reason == "refusal":
        raise AIUnavailable("the model declined the request")
    if stop_reason == "max_tokens":
        raise AIUnavailable("the reply was truncated (max_tokens)")

    for block in getattr(response, "content", None) or []:
        if getattr(block, "type", None) == "text":
            text = getattr(block, "text", None)
            if isinstance(text, str) and text.strip():
                return text
    raise AIUnavailable("the reply contained no text")


def make_category_id(title: str, used_ids: set[str]) -> str:
    """`cat_ai_<slug>_<hash6>` — derived, not random, so a rebuild with the same
    AI titles yields the same ids. Collisions (identical titles) get _2, _3, …"""
    slug = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")[:40] or "category"
    digest = hashlib.sha1(title.encode("utf-8")).hexdigest()[:6]
    base = f"cat_ai_{slug}_{digest}"
    candidate = base
    n = 2
    while candidate in used_ids:
        candidate = f"{base}_{n}"
        n += 1
    used_ids.add(candidate)
    return candidate


def categories_from_ai(
    ai_client: Any,
    sources: Sequence[dict],
    opts: BuildOptions,
    rng: random.Random,
    log: Any,
) -> list[dict[str, Any]]:
    """Pool every source's songs, send them to Claude in one call, and build
    cross-cutting categories out of what comes back."""
    pool: list[dict[str, Any]] = [q for source in sources for q in source["questions"]]
    if len(pool) > AI_POOL_LIMIT:
        log(f"AI: pooling a sample of {AI_POOL_LIMIT} of {len(pool)} songs")
        pool = rng.sample(pool, AI_POOL_LIMIT)

    model = os.environ.get("ANTHROPIC_MODEL") or DEFAULT_MODEL
    prompt = build_ai_prompt(pool, opts.categories, opts.min_songs)
    ai_categories, blocked = parse_ai_response(call_ai(ai_client, prompt, model, log))

    blocked_set = {i for i in blocked if 0 <= i < len(pool)}
    if blocked_set:
        log(f"AI: dropped {len(blocked_set)} track(s) flagged by the content pass")

    used_ids: set[str] = set()
    assigned: set[int] = set()
    categories: list[dict[str, Any]] = []
    for entry in ai_categories:
        if len(categories) >= opts.categories:
            break
        picked = [
            i
            for i in entry["songs"]
            if 0 <= i < len(pool) and i not in blocked_set and i not in assigned
        ]
        if len(picked) < opts.min_songs:
            log(
                f"  skip: AI category {entry['title']!r} has only {len(picked)} "
                f"usable songs (need {opts.min_songs})"
            )
            continue
        assigned.update(picked)
        questions = [pool[i] for i in picked]
        if len(questions) > opts.songs_per_category:
            questions = rng.sample(questions, opts.songs_per_category)
        for i, q in enumerate(questions):
            q["value"] = POINT_VALUES[min(i, len(POINT_VALUES) - 1)]
        categories.append(
            {
                "id": make_category_id(entry["title"], used_ids),
                "title": entry["title"],
                "playlistId": None,
                "questions": questions,
            }
        )

    if not categories:
        raise AIUnavailable("the model returned no usable categories")

    leftover = len(pool) - len(assigned) - len(blocked_set)
    if leftover > 0:
        log(f"AI: {leftover} pooled song(s) went unassigned (normal — not every song fits a theme)")
    return categories


def build_bank(
    client: Any,
    opts: BuildOptions,
    log: Any = print,
    ai_client: Any = None,
    youtube_session: Any = None,
) -> dict[str, Any]:
    """Read playlists via `client` and return a QuestionBank dict.

    `client` is anything with ytmusicapi's `get_library_playlists(limit=...)`,
    `get_playlist(playlistId, limit=...)` and `search(query, filter=..., limit=...)`
    methods — the tests pass a fake.

    `ai_client` is optional and duck-typed: an object exposing
    `.messages.create(model=..., max_tokens=..., messages=[...])` returning an
    object with `.stop_reason` and `.content` (a list of blocks with `.type` and
    `.text`) — i.e. the `anthropic.Anthropic` surface. `None` (the default, and
    what `--no-ai` and a missing ANTHROPIC_API_KEY produce) means one category
    per playlist.

    `youtube_session` is optional and duck-typed: an object exposing
    `.get(url, params=..., timeout=...)` returning an object with `.json()` —
    i.e. a `requests.Session`. Combined with `opts.youtube_api_key`, it gates
    the embeddable pre-check (§ filter_embeddable); either being absent skips
    it entirely — no key, no check, same as today's behaviour.

    build_bank() never constructs either client itself, so no test can reach
    the network or pick up a real key.
    """
    rng = random.Random(opts.seed)

    sources = collect_sources(client, opts, rng, log)

    if opts.youtube_api_key and youtube_session is not None:
        sources = filter_embeddable(youtube_session, opts.youtube_api_key, sources, opts, log)
        if not sources:
            raise BuildError(
                "No playlist had enough embeddable songs after the YouTube check. "
                "Lower --min-songs or pick different playlists."
            )
    else:
        log(
            "Embeddable pre-check not requested; skipping it. "
            "The game plays songs via native YouTube Music links, which have no "
            "embed restrictions, so this filter is no longer needed."
        )

    if ai_client is not None and not opts.no_ai:
        try:
            categories = categories_from_ai(ai_client, sources, opts, rng, log)
        except AIUnavailable as exc:
            log(f"AI categorisation skipped ({exc}); falling back to one category per playlist.")
            categories = categories_from_sources(sources, opts, rng)
    else:
        reason = "--no-ai" if opts.no_ai else "no AI client"
        log(f"AI categorisation skipped ({reason}); falling back to one category per playlist.")
        categories = categories_from_sources(sources, opts, rng)

    return {
        "version": BANK_VERSION,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "ytmusicapi",
        "categories": categories,
    }


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def make_client(
    auth_mode: str,
    auth_file: Path,
    client_id: str | None = None,
    client_secret: str | None = None,
) -> Any:
    """Construct the real YTMusic client for `main()`.

    oauth mode needs the *same* client id/secret used to create `auth_file` —
    ytmusicapi refreshes the token against them, it doesn't just replay it —
    so a bare `YTMusic(auth_file)` raises `YTMusicUserError` on any modern
    ytmusicapi version even with a perfectly valid oauth.json. browser mode has
    no such requirement (cookie-based, nothing to refresh).
    """
    if not auth_file.exists():
        raise BuildError(
            f"Auth file not found: {auth_file}\n\n"
            + (
                "Create one (one-time, needs a Google Cloud OAuth client of type\n"
                '"TVs and Limited Input devices" — see the README "Question bank"\n'
                "section):\n\n"
                f"  {SCRIPT_DIR}/.venv/bin/ytmusicapi oauth \\\n"
                "      --client-id <YOUR_CLIENT_ID> \\\n"
                "      --client-secret <YOUR_CLIENT_SECRET> \\\n"
                f"      --file {auth_file}\n"
                if auth_mode == "oauth"
                else "Create one with:\n\n"
                f"  {SCRIPT_DIR}/.venv/bin/ytmusicapi browser --file {auth_file}\n\n"
                "(paste the request headers from music.youtube.com devtools)\n"
            )
        )
    try:
        from ytmusicapi import YTMusic  # imported late so --help works uninstalled
    except ImportError as exc:  # pragma: no cover - environment problem
        raise BuildError(
            "ytmusicapi is not installed. Run:\n"
            f"  {SCRIPT_DIR}/.venv/bin/pip install -r {SCRIPT_DIR}/requirements.txt"
        ) from exc

    if auth_mode == "oauth":
        if not client_id or not client_secret:
            raise BuildError(
                "OAuth mode needs the client id/secret used to create oauth.json — "
                "pass --client-id/--client-secret, or set YTMUSIC_CLIENT_ID/"
                "YTMUSIC_CLIENT_SECRET."
            )
        from ytmusicapi.auth.oauth import OAuthCredentials

        return YTMusic(
            str(auth_file),
            oauth_credentials=OAuthCredentials(client_id=client_id, client_secret=client_secret),
        )
    return YTMusic(str(auth_file))


def make_ai_client(log: Any = print) -> Any | None:
    """Build an Anthropic client, or return None (with a reason) if we can't.

    Never raises: no key and no package are both ordinary, non-fatal states that
    simply mean "one category per playlist". The env var is read here rather
    than at import time so no test can pick up a real key.
    """
    if not os.environ.get("ANTHROPIC_API_KEY"):
        log(
            "ANTHROPIC_API_KEY not set; using one category per playlist. "
            "Set it to get AI-generated categories."
        )
        return None
    try:
        import anthropic  # imported late so --help works uninstalled
    except ImportError:
        log(
            "the `anthropic` package is not installed "
            f"(pip install -r {SCRIPT_DIR}/requirements.txt); "
            "using one category per playlist."
        )
        return None
    try:
        return anthropic.Anthropic()
    except Exception as exc:  # pragma: no cover - environment problem
        log(f"could not create the Anthropic client ({exc}); using one category per playlist.")
        return None


def make_youtube_session(log: Any = print) -> Any | None:
    """Build a `requests.Session` for the embeddable check, or None if the
    `requests` package is somehow missing. Never raises — no session just
    means the check is skipped, same as no API key.
    """
    try:
        import requests  # imported late so --help works uninstalled
    except ImportError:
        log(
            "the `requests` package is not installed "
            f"(pip install -r {SCRIPT_DIR}/requirements.txt); "
            "skipping the embeddable pre-check."
        )
        return None
    return requests.Session()


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a Music Trivia question bank from YouTube Music playlists.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--auth-mode",
        choices=("oauth", "browser"),
        default="oauth",
        help="ytmusicapi auth method (default: oauth, the durable one)",
    )
    parser.add_argument(
        "--auth-file",
        type=Path,
        default=None,
        help="auth JSON (default: oauth.json / browser.json next to this script)",
    )
    parser.add_argument(
        "--client-id",
        default=os.environ.get("YTMUSIC_CLIENT_ID"),
        metavar="ID",
        help="oauth mode only: the OAuth client id used to create oauth.json (or set YTMUSIC_CLIENT_ID)",
    )
    parser.add_argument(
        "--client-secret",
        default=os.environ.get("YTMUSIC_CLIENT_SECRET"),
        metavar="SECRET",
        help="oauth mode only: the OAuth client secret used to create oauth.json (or set YTMUSIC_CLIENT_SECRET)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=REPO_ROOT / "question-bank" / "bank.json",
        help="output path (default: <repo>/question-bank/bank.json)",
    )
    parser.add_argument(
        "--playlists",
        action="append",
        default=[],
        metavar="ID_OR_TITLE",
        help="repeatable: playlist id, or a case-insensitive title substring",
    )
    parser.add_argument(
        "--community-playlist",
        action="append",
        default=[],
        metavar="ID_OR_URL",
        dest="community_playlists",
        help="repeatable: a public playlist you don't own, by id or share URL",
    )
    parser.add_argument(
        "--community-search",
        action="append",
        default=[],
        metavar="QUERY",
        dest="community_searches",
        help="repeatable: search YT Music's community playlists, take the first hit",
    )
    parser.add_argument(
        "--no-library",
        action="store_true",
        help=(
            "exclude your own library playlists entirely — by default it's always "
            "included alongside any --community-playlist/--community-search"
        ),
    )
    parser.add_argument(
        "--categories",
        type=int,
        default=DEFAULT_CATEGORIES,
        help=f"how many AI categories to ask for (default: {DEFAULT_CATEGORIES}, the board's columns)",
    )
    parser.add_argument(
        "--no-ai",
        action="store_true",
        help="skip the AI call; force one category per source playlist",
    )
    parser.add_argument(
        "--youtube-api-key",
        default=None,
        metavar="KEY",
        help=(
            "Google/YouTube Data API v3 key — optional legacy pre-filter that drops "
            "songs with embedding disabled. No longer needed: the game plays songs via "
            "native YouTube Music links, which have no embed restrictions."
        ),
    )
    parser.add_argument(
        "--max-categories", type=int, default=8, help="how many source playlists to read (default: 8)"
    )
    parser.add_argument("--songs-per-category", type=int, default=8)
    parser.add_argument("--min-songs", type=int, default=5)
    parser.add_argument("--seed", type=int, default=None, help="reproducible song sampling")
    parser.add_argument(
        "--dry-run", action="store_true", help="print a summary, write nothing"
    )
    return parser.parse_args(argv)


def write_bank(bank: dict[str, Any], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        json.dump(bank, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    auth_file = args.auth_file or SCRIPT_DIR / f"{args.auth_mode}.json"

    try:
        client = make_client(args.auth_mode, auth_file, args.client_id, args.client_secret)
        ai_client = None if args.no_ai else make_ai_client(print)
        youtube_session = make_youtube_session(print) if args.youtube_api_key else None
        print(f"Reading playlists from YouTube Music ({args.auth_mode} auth)…")
        bank = build_bank(
            client,
            BuildOptions(
                playlists=args.playlists,
                max_categories=args.max_categories,
                songs_per_category=args.songs_per_category,
                min_songs=args.min_songs,
                seed=args.seed,
                community_playlists=args.community_playlists,
                community_searches=args.community_searches,
                categories=args.categories,
                no_ai=args.no_ai,
                youtube_api_key=args.youtube_api_key,
                no_library=args.no_library,
            ),
            ai_client=ai_client,
            youtube_session=youtube_session,
        )
    except BuildError as exc:
        print(f"\nerror: {exc}", file=sys.stderr)
        return 1

    total = sum(len(c["questions"]) for c in bank["categories"])
    print("\nCategory summary:")
    width = max((len(c["title"]) for c in bank["categories"]), default=0)
    for cat in bank["categories"]:
        print(f"  {cat['title']:<{width}}  {len(cat['questions'])} songs")
    print(f"  {'TOTAL':<{width}}  {total} songs in {len(bank['categories'])} categories")

    ai_used = any(str(c.get("id", "")).startswith("cat_ai_") for c in bank["categories"])
    if ai_used:
        print(f"Categories: AI-generated ({os.environ.get('ANTHROPIC_MODEL') or DEFAULT_MODEL})")
    else:
        print("Categories: one per playlist (no AI)")
    print(f"Embeddable pre-check: {'ran' if args.youtube_api_key else 'skipped (not requested)'}")

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return 0

    write_bank(bank, args.out)
    print(f"\nWrote {os.fspath(args.out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
