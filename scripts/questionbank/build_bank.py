#!/usr/bin/env python3
"""Build a Music Trivia question bank from YouTube Music.

Run this by hand, offline. It is never invoked by the Node server — the server
just reads the JSON file this writes (default: <repo>/question-bank/bank.json).

Two modes:

  taxonomy  (default)  Build the fixed, curated ~61-category taxonomy defined
                       in this file. Each category aggregates several large
                       community playlists (fetched in FULL) and dedupes by
                       videoId within the category.
  playlists (legacy)   One category per source playlist (your library and/or
                       --community-playlist/--community-search).

Each song becomes a question carrying its title, artist and YouTube video id.

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
import json
import os
import random
import re
import sys
import time
import urllib.parse
from dataclasses import dataclass
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

# YouTube Data API v3 — used only to pre-filter songs with embedding disabled
# by the rights holder (common on major-label official videos). Those videos
# can't play in ANY embedded player, on any site — this is a per-video
# publisher setting, not a bug. Without this check they'd only surface as an
# in-game "Embedding disabled" error the host has to Skip past.
YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3/videos"
YOUTUBE_BATCH_SIZE = 50


class BuildError(Exception):
    """A fatal, user-actionable problem."""


# --------------------------------------------------------------------------
# The curated category taxonomy. THIS is the config the user edits — a handful
# of small tables that get expanded into CategoryDefs by the _*_defs() helpers
# below. There is deliberately no if/elif chain anywhere in here: adding "Pop
# sub-genres" later is a two-line edit to a table plus one expander.
#
# `key` and `group` are IDENTIFIERS (they derive the bank category id
# `cat_tax_<group>__<key>`); renaming either orphans the category in banks
# built earlier. `title` may be changed freely.
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class CategoryDef:
    key: str  # stable slug; drives the bank id. e.g. "90s_grunge"
    title: str  # display title. e.g. "90s Grunge"
    group: str  # taxonomy group slug. e.g. "rock_sub"
    queries: tuple[str, ...] = ()  # community-playlist search queries, priority order
    playlist_ids: tuple[str, ...] = ()  # optional hand-pinned playlist ids/URLs
    max_playlists: int = 4  # how many distinct playlists to aggregate
    enabled: bool = True  # flip False to park a category without deleting it


def slugify(value: str) -> str:
    """Lowercase [a-z0-9_] slug. Never emits a double underscore, which is what
    keeps `cat_tax_<group>__<key>` unambiguously splittable."""
    # Apostrophes are dropped rather than turned into separators, so "Today's"
    # slugs to "todays" and not "today_s".
    slug = re.sub(r"[^a-z0-9]+", "_", value.lower().replace("'", "")).strip("_")
    return re.sub(r"_+", "_", slug) or "category"


# (slug, display title, search token). The search token exists because a couple
# of display names are poor queries ("Hip-Hop/Rap" searches badly; "hip hop"
# does not).
PLAIN_GENRES: tuple[tuple[str, str, str], ...] = (
    ("pop", "Pop", "pop"),
    ("rock", "Rock", "rock"),
    ("hiphop", "Hip-Hop/Rap", "hip hop"),
    ("rnb", "R&B/Soul", "r&b soul"),
    ("country", "Country", "country"),
)

DECADES: tuple[str, ...] = ("50s", "60s", "70s", "80s", "90s", "2000s", "2010s", "Today's")

# Only where the genre has meaningful real content that era. Hip-Hop didn't
# meaningfully exist as a charting genre before the 80s.
GENRE_DECADES: dict[str, tuple[str, ...]] = {
    "pop": DECADES,
    "rock": DECADES,
    "rnb": DECADES,
    "country": DECADES,
    "hiphop": ("80s", "90s", "2000s", "2010s", "Today's"),
}

ROCK_SUBGENRES: tuple[str, ...] = (
    "Grunge",
    "Classic Rock",
    "Hard Rock",
    "Alternative Rock",
    "Indie Rock",
    "Southern Rock",
    "Psychedelic Rock",
    "Garage Rock",
    "Yacht Rock",
)

# (key, display title, era search token). The key is spelled out rather than
# derived from the title because "2000s Pop" exists twice in the agreed
# taxonomy — once as Pop × 2000s, once as a cross-genre era category — and keys
# must stay globally unique. "50s & 60s Oldies" gets hand-written queries
# instead of the era template — see _era_defs().
ERA_CATEGORIES: tuple[tuple[str, str, str], ...] = (
    ("50s_60s_oldies", "50s & 60s Oldies", ""),
    ("70s_hits", "70s Hits", "70s"),
    ("80s_throwbacks", "80s Throwbacks", "80s"),
    ("90s_nostalgia", "90s Nostalgia", "90s"),
    ("2000s_pop_hits", "2000s Pop", "2000s"),
    ("2010s_chart_toppers", "2010s Chart Toppers", "2010s"),
    ("todays_hits", "Today's Hits", "2020s"),
)

OLDIES_QUERIES: tuple[str, ...] = (
    "oldies 50s 60s",
    "60s oldies",
    "50s and 60s hits",
    "oldies party playlist",
)

SPECIAL_CATEGORIES: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "Boy Bands/Girl Groups",
        (
            "boy band hits",
            "girl group hits",
            "best boy bands playlist",
            "90s boy bands and girl groups",
        ),
    ),
    (
        "Solo Artists",
        (
            "biggest solo artist hits",
            "solo pop stars playlist",
            "greatest solo hits of all time",
            "iconic solo artists",
        ),
    ),
    (
        "One-Hit Wonders",
        (
            "one hit wonders",
            "best one hit wonders playlist",
            "80s one hit wonders",
            "90s one hit wonders",
        ),
    ),
)


def _genre_defs() -> tuple[CategoryDef, ...]:
    return tuple(
        CategoryDef(
            key=slug,
            title=title,
            group="genre",
            queries=(
                f"best {token} songs",
                f"{token} hits playlist",
                f"ultimate {token} playlist",
                f"top {token} songs of all time",
            ),
        )
        for slug, title, token in PLAIN_GENRES
    )


def _decade_queries(decade: str, token: str) -> tuple[str, ...]:
    # A literal "Today's" search returns junk, so that decade gets its own
    # templates rather than a special case buried in the loop.
    if decade == "Today's":
        return (
            f"2020s {token} hits",
            f"todays {token} hits",
            f"new {token} hits 2020s",
            f"current {token} hits",
        )
    return (
        f"{decade} {token} hits",
        f"best {decade} {token} songs",
        f"{decade} {token} playlist",
        f"ultimate {decade} {token}",
    )


def _genre_decade_defs() -> tuple[CategoryDef, ...]:
    defs: list[CategoryDef] = []
    for slug, title, token in PLAIN_GENRES:
        for decade in GENRE_DECADES.get(slug, ()):
            defs.append(
                CategoryDef(
                    key=f"{slugify(decade)}_{slug}",
                    title=f"{decade} {title}",
                    group=f"decade_{slug}",
                    queries=_decade_queries(decade, token),
                )
            )
    return tuple(defs)


def _rock_sub_defs() -> tuple[CategoryDef, ...]:
    return tuple(
        CategoryDef(
            key=slugify(sub),
            title=sub,
            group="rock_sub",
            queries=(
                f"{sub.lower()} songs",
                f"best {sub.lower()} songs",
                f"{sub.lower()} hits playlist",
                f"ultimate {sub.lower()} playlist",
            ),
        )
        for sub in ROCK_SUBGENRES
    )


def _era_defs() -> tuple[CategoryDef, ...]:
    defs: list[CategoryDef] = []
    for key, title, token in ERA_CATEGORIES:
        queries = (
            OLDIES_QUERIES
            if not token
            else (
                f"{token} hits",
                f"{token} classics",
                f"best songs of the {token}",
                f"{token} party playlist",
            )
        )
        defs.append(CategoryDef(key=key, title=title, group="era", queries=queries))
    return tuple(defs)


def _special_defs() -> tuple[CategoryDef, ...]:
    return tuple(
        CategoryDef(key=slugify(title), title=title, group="special", queries=queries)
        for title, queries in SPECIAL_CATEGORIES
    )


TAXONOMY: tuple[CategoryDef, ...] = (
    *_genre_defs(),
    *_genre_decade_defs(),
    *_rock_sub_defs(),
    *_era_defs(),
    *_special_defs(),
)


def make_taxonomy_category_id(cat: CategoryDef) -> str:
    """`cat_tax_<group>__<key>`. Derived from the config, so a rebuild is stable
    and the shared `parseCategoryGroup()` can recover the group client-side."""
    return f"cat_tax_{cat.group}__{cat.key}"


def taxonomy_categories(filters: Sequence[str] = ()) -> list[CategoryDef]:
    """Enabled taxonomy entries, optionally narrowed by case-insensitive
    key/title substring (that's what `--category` passes in)."""
    cats = [c for c in TAXONOMY if c.enabled]
    needles = [f.strip().lower() for f in filters if f and f.strip()]
    if not needles:
        return cats
    return [
        c for c in cats if any(n in c.key.lower() or n in c.title.lower() for n in needles)
    ]


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


def search_community_playlists(
    client: Any, query: str, log: Any, max_results: int = 1
) -> list[dict[str, Any]]:
    """Search YT Music's community playlists and return up to `max_results`
    usable hits, in YT Music's own relevance order.

    No ranking: YT Music's own relevance order is the ranking, and any heuristic
    we layered on top would be unexplainable to the user. Each pick is logged
    instead so it can be sanity-checked.
    """
    try:
        results = client.search(query, filter="community_playlists", limit=20) or []
    except Exception as exc:  # unofficial API — one bad query must not abort the run
        log(f"  skip: community search {query!r} failed: {exc}")
        return []

    hits: list[dict[str, Any]] = []
    for entry in results:
        if len(hits) >= max_results:
            break
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
        hits.append(hit)

    if not hits:
        log(f"  skip: community search {query!r} returned no usable playlist")
    return hits


def search_community_playlist(client: Any, query: str, log: Any) -> dict[str, Any] | None:
    """First usable hit, or None. The legacy --community-search entry point."""
    hits = search_community_playlists(client, query, log, max_results=1)
    return hits[0] if hits else None


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
        youtube_api_key: str | None = None,
        no_library: bool = False,
        mode: str = "taxonomy",
        category_filters: Sequence[str] = (),
        max_playlists_per_category: int = 4,
        per_query_results: int = 2,
        min_category_songs: int = 25,
        max_songs_per_category: int = 0,
        sleep_ms: int = 250,
    ) -> None:
        # ---- legacy "playlists" mode ----
        self.playlists = list(playlists)
        # Caps how many *source playlists* are read.
        self.max_categories = max_categories
        self.songs_per_category = songs_per_category
        self.min_songs = min_songs
        self.community_playlists = list(community_playlists)
        self.community_searches = list(community_searches)
        # Community sources are additive by default; this opts OUT of the
        # library entirely (e.g. "just build from these community playlists").
        self.no_library = no_library

        # ---- shared ----
        self.seed = seed
        self.youtube_api_key = youtube_api_key
        # "taxonomy" (the curated ~61 categories) or "playlists" (legacy).
        self.mode = mode

        # ---- taxonomy mode ----
        self.category_filters = list(category_filters)
        self.max_playlists_per_category = max_playlists_per_category
        self.per_query_results = per_query_results
        self.min_category_songs = min_category_songs
        # 0 = unlimited (the normal case — we WANT hundreds per category).
        self.max_songs_per_category = max_songs_per_category
        self.sleep_ms = sleep_ms


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
            # limit=None fetches the COMPLETE track list (ytmusicapi 1.12.1:
            # `limit: int | None = 100` — "None retrieves them all"). A 200-song
            # cap would silently truncate the best sources.
            detail = client.get_playlist(pid, limit=None) or {}
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
# Taxonomy mode: a new *orchestration* layer over the ingestion primitives
# above (parse_playlist_id / search_community_playlists / get_playlist /
# usable_track). No new low-level YouTube Music code lives here.
# --------------------------------------------------------------------------


def collect_category_playlists(
    client: Any, cat: CategoryDef, opts: BuildOptions, log: Any
) -> list[tuple[str, str]]:
    """Candidate `(playlistId, knownTitle)` pairs for one category.

    Pinned `cat.playlist_ids` are consumed FIRST (that's the hand-tuning escape
    hatch: paste two URLs into a CategoryDef and a badly-searching category is
    fixed without touching code), then each query in order contributes up to
    `opts.per_query_results` hits, stopping at `max_playlists` distinct ids.
    A pinned entry yields an empty known title so the playlist's own title wins.
    """
    cap = min(cat.max_playlists, opts.max_playlists_per_category)
    out: list[tuple[str, str]] = []
    seen: set[str] = set()

    for raw in cat.playlist_ids:
        if len(out) >= cap:
            return out
        try:
            pid = parse_playlist_id(raw)
        except BuildError as exc:
            log(f"  skip: pinned playlist {raw!r}: {exc}")
            continue
        if pid in seen:
            continue
        seen.add(pid)
        out.append((pid, ""))

    for query in cat.queries:
        if len(out) >= cap:
            break
        hits = search_community_playlists(client, query, log, max_results=opts.per_query_results)
        for hit in hits:
            if len(out) >= cap:
                break
            pid = str(hit["playlistId"])
            if pid in seen:
                continue
            seen.add(pid)
            out.append((pid, str(hit["title"])))
    return out


def collect_category_songs(
    client: Any, cat: CategoryDef, opts: BuildOptions, log: Any, sleep: Any = None
) -> list[dict[str, Any]]:
    """Fetch every candidate playlist IN FULL and return the category's songs.

    Deduped by videoId WITHIN THIS CATEGORY ONLY: the same track legitimately
    belongs to "Rock", "90s Rock" and "90s Grunge", and a global dedupe would
    gut every category after the first. (The engine's per-game "never play the
    same song twice" guarantee is enforced separately, by videoId, at draw
    time.)
    """
    sleeper = time.sleep if sleep is None else sleep
    candidates = collect_category_playlists(client, cat, opts, log)

    songs: list[dict[str, Any]] = []
    seen_video_ids: set[str] = set()
    n_playlists = 0

    for i, (pid, known_title) in enumerate(candidates):
        if i > 0:
            # Rate-limit courtesy on an unofficial API; a full run is ~500 calls.
            sleeper(opts.sleep_ms / 1000.0)
        try:
            detail = client.get_playlist(pid, limit=None) or {}
        except Exception as exc:  # one bad playlist must never abort a 30min run
            log(f"  skip: could not read playlist {pid}: {exc}")
            continue
        title = known_title or detail.get("title") or pid
        tracks: Iterable[Any] = detail.get("tracks") or []

        usable = 0
        skipped = 0
        dupes = 0
        for entry in tracks:
            q = usable_track(entry)
            if q is None:
                skipped += 1
                continue
            if q["videoId"] in seen_video_ids:
                dupes += 1
                continue
            seen_video_ids.add(q["videoId"])
            songs.append(q)
            usable += 1

        n_playlists += 1
        dupe_note = f" ({dupes} dupes)" if dupes else ""
        log(
            f"  + {title!r} ({pid}): {usable} usable, {skipped} skipped{dupe_note}"
            f" — category total {len(songs)}"
        )

    log(f"  {cat.title}: {len(songs)} songs from {n_playlists} playlists")
    return songs


def categories_from_taxonomy(
    client: Any,
    opts: BuildOptions,
    rng: random.Random,
    log: Any,
    sleep: Any = None,
    dropped: list[tuple[str, int]] | None = None,
) -> list[dict[str, Any]]:
    """Build one bank category per enabled taxonomy entry.

    Categories below `--min-category-songs` are dropped with a warning and
    appended to `dropped` (title, count) for the end-of-run summary. Only a
    completely empty result is fatal.
    """
    defs = taxonomy_categories(opts.category_filters)
    if not defs:
        raise BuildError(
            "No taxonomy category matched --category. Run --list-categories to see them all."
        )

    categories: list[dict[str, Any]] = []
    total = len(defs)
    for i, cat in enumerate(defs, start=1):
        log(f"[{i}/{total}] {cat.title}")
        songs = collect_category_songs(client, cat, opts, log, sleep=sleep)
        if len(songs) < opts.min_category_songs:
            log(
                f"  drop: {cat.title!r} has only {len(songs)} songs "
                f"(need {opts.min_category_songs})"
            )
            if dropped is not None:
                dropped.append((cat.title, len(songs)))
            continue
        if opts.max_songs_per_category and len(songs) > opts.max_songs_per_category:
            songs = rng.sample(songs, opts.max_songs_per_category)
        # Flat value: the engine assigns the authoritative SONG_POINT_VALUE.
        for q in songs:
            q["value"] = POINT_VALUES[0]
        categories.append(
            {
                "id": make_taxonomy_category_id(cat),
                "title": cat.title,
                "playlistId": None,
                "questions": songs,
            }
        )

    if not categories:
        raise BuildError(
            f"No taxonomy category reached {opts.min_category_songs} songs. "
            "Lower --min-category-songs, or check that YT Music auth is working."
        )
    return categories


def merge_bank(existing: dict[str, Any], bank: dict[str, Any]) -> dict[str, Any]:
    """Merge freshly-built categories into an existing bank: same-id categories
    are replaced in place, everything else is preserved, and genuinely new
    categories are appended. Makes `--category "Yacht Rock" --merge` cheap."""
    new_by_id = {str(c.get("id")): c for c in bank.get("categories") or []}
    merged: list[dict[str, Any]] = []
    replaced: set[str] = set()
    for cat in existing.get("categories") or []:
        cid = str(cat.get("id"))
        if cid in new_by_id:
            merged.append(new_by_id[cid])
            replaced.add(cid)
        else:
            merged.append(cat)
    for cat in bank.get("categories") or []:
        if str(cat.get("id")) not in replaced:
            merged.append(cat)
    return {**bank, "categories": merged}


def build_bank(
    client: Any,
    opts: BuildOptions,
    log: Any = print,
    youtube_session: Any = None,
    sleep: Any = None,
    dropped: list[tuple[str, int]] | None = None,
) -> dict[str, Any]:
    """Read YouTube Music via `client` and return a QuestionBank dict.

    `client` is anything with ytmusicapi's `get_library_playlists(limit=...)`,
    `get_playlist(playlistId, limit=...)` and `search(query, filter=..., limit=...)`
    methods — the tests pass a fake.

    `opts.mode`:
      "taxonomy"  — the curated categories (§ categories_from_taxonomy). The
                    library, the embeddable pre-check and `collect_sources()`
                    are all bypassed entirely.
      "playlists" — the legacy one-category-per-source-playlist path, verbatim.

    `youtube_session` is optional and duck-typed: an object exposing
    `.get(url, params=..., timeout=...)` returning an object with `.json()` —
    i.e. a `requests.Session`. Combined with `opts.youtube_api_key`, it gates
    the embeddable pre-check (§ filter_embeddable); either being absent skips
    it entirely. Legacy mode only.

    `sleep` is injected purely so tests don't wait; `dropped` collects
    (title, count) for taxonomy categories that came in too thin.

    build_bank() never constructs a client itself, so no test can reach the
    network or pick up a real key.
    """
    rng = random.Random(opts.seed)

    if opts.mode == "taxonomy":
        categories = categories_from_taxonomy(client, opts, rng, log, sleep=sleep, dropped=dropped)
        return {
            "version": BANK_VERSION,
            "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "ytmusicapi",
            "categories": categories,
        }

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
        "--mode",
        choices=("taxonomy", "playlists"),
        default="taxonomy",
        help="taxonomy: the curated ~61 categories (default). playlists: legacy one-per-playlist",
    )
    parser.add_argument(
        "--category",
        action="append",
        default=[],
        metavar="KEY_OR_TITLE",
        dest="category_filters",
        help="repeatable: build only taxonomy categories matching this substring",
    )
    parser.add_argument(
        "--list-categories",
        action="store_true",
        help="print the taxonomy (group / key / title / #queries) and exit — no network",
    )
    parser.add_argument(
        "--max-playlists-per-category",
        type=int,
        default=4,
        help="how many distinct community playlists to aggregate per category (default: 4)",
    )
    parser.add_argument(
        "--per-query-results",
        type=int,
        default=2,
        help="how many usable hits to take from each community search (default: 2)",
    )
    parser.add_argument(
        "--min-category-songs",
        type=int,
        default=25,
        help="drop a taxonomy category with fewer usable songs than this (default: 25)",
    )
    parser.add_argument(
        "--max-songs-per-category",
        type=int,
        default=0,
        help="cap songs per taxonomy category (default: 0 = unlimited)",
    )
    parser.add_argument(
        "--sleep-ms",
        type=int,
        default=250,
        help="pause between playlist fetches, in ms (default: 250)",
    )
    parser.add_argument(
        "--merge",
        action="store_true",
        help="merge into the existing --out bank: same-id categories are replaced, the rest kept",
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


def print_taxonomy(out: Any = print) -> None:
    """`--list-categories`: the whole taxonomy, no network, no auth."""
    cats = taxonomy_categories()
    gw = max((len(c.group) for c in cats), default=0)
    kw = max((len(c.key) for c in cats), default=0)
    tw = max((len(c.title) for c in cats), default=0)
    for cat in cats:
        out(
            f"{cat.group:<{gw}}  {cat.key:<{kw}}  {cat.title:<{tw}}  "
            f"{len(cat.queries)} queries"
        )
    out(f"{len(cats)} categories")


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)

    if args.list_categories:
        print_taxonomy()
        return 0

    auth_file = args.auth_file or SCRIPT_DIR / f"{args.auth_mode}.json"
    dropped: list[tuple[str, int]] = []
    started = time.monotonic()

    try:
        client = make_client(args.auth_mode, auth_file, args.client_id, args.client_secret)
        youtube_session = make_youtube_session(print) if args.youtube_api_key else None
        print(f"Reading from YouTube Music ({args.auth_mode} auth, --mode {args.mode})…")
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
                youtube_api_key=args.youtube_api_key,
                no_library=args.no_library,
                mode=args.mode,
                category_filters=args.category_filters,
                max_playlists_per_category=args.max_playlists_per_category,
                per_query_results=args.per_query_results,
                min_category_songs=args.min_category_songs,
                max_songs_per_category=args.max_songs_per_category,
                sleep_ms=args.sleep_ms,
            ),
            youtube_session=youtube_session,
            dropped=dropped,
        )
    except BuildError as exc:
        print(f"\nerror: {exc}", file=sys.stderr)
        return 1

    elapsed = time.monotonic() - started

    total = sum(len(c["questions"]) for c in bank["categories"])
    print("\nCategory summary:")
    width = max((len(c["title"]) for c in bank["categories"]), default=0)
    for cat in bank["categories"]:
        print(f"  {cat['title']:<{width}}  {len(cat['questions'])} songs")
    print(f"  {'TOTAL':<{width}}  {total} songs in {len(bank['categories'])} categories")

    if dropped:
        print(f"\nDropped {len(dropped)} category/categories below --min-category-songs "
              f"({args.min_category_songs}):")
        dwidth = max(len(t) for t, _ in dropped)
        for title, count in dropped:
            print(f"  {title:<{dwidth}}  {count} songs — not enough real content found")

    print(f"\nMode: {args.mode}")
    if args.mode == "playlists":
        print(
            f"Embeddable pre-check: {'ran' if args.youtube_api_key else 'skipped (not requested)'}"
        )
    print(f"Elapsed: {elapsed:.1f}s")

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return 0

    if args.merge and args.out.exists():
        try:
            existing = json.loads(args.out.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"\nerror: --merge could not read {os.fspath(args.out)}: {exc}", file=sys.stderr)
            return 1
        before = len(existing.get("categories") or [])
        bank = merge_bank(existing, bank)
        print(
            f"\n--merge: {before} existing categories + this run "
            f"-> {len(bank['categories'])} categories"
        )

    write_bank(bank, args.out)
    print(f"\nWrote {os.fspath(args.out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
