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
import json
import os
import random
import sys
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


class BuildError(Exception):
    """A fatal, user-actionable problem."""


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
    playable videoId, plus anything missing a title or an artist.
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
    ) -> None:
        self.playlists = list(playlists)
        self.max_categories = max_categories
        self.songs_per_category = songs_per_category
        self.min_songs = min_songs
        self.seed = seed


def build_bank(client: Any, opts: BuildOptions, log: Any = print) -> dict[str, Any]:
    """Read playlists via `client` and return a QuestionBank dict.

    `client` is anything with ytmusicapi's `get_library_playlists(limit=...)`
    and `get_playlist(playlistId, limit=...)` methods — the tests pass a fake.
    """
    rng = random.Random(opts.seed)

    playlists = client.get_library_playlists(limit=100) or []
    selected = [p for p in playlists if isinstance(p, dict) and playlist_matches(p, opts.playlists)]
    if not selected:
        raise BuildError(
            "No playlists matched. Check --playlists, or run without it to use them all."
        )

    seen_video_ids: set[str] = set()
    categories: list[dict[str, Any]] = []
    total_skipped = 0

    for playlist in selected:
        if len(categories) >= opts.max_categories:
            break
        pid = playlist.get("playlistId")
        title = playlist.get("title") or "Untitled playlist"
        if not isinstance(pid, str) or not pid:
            log(f"  skip: playlist {title!r} has no playlistId")
            continue

        detail = client.get_playlist(pid, limit=200) or {}
        tracks: Iterable[Any] = detail.get("tracks") or []

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

        total_skipped += skipped
        if len(questions) < opts.min_songs:
            log(
                f"  skip: {title!r} has only {len(questions)} usable songs "
                f"(need {opts.min_songs})"
            )
            # Release its ids so a later playlist can still use those songs.
            for q in questions:
                seen_video_ids.discard(q["videoId"])
            continue

        if len(questions) > opts.songs_per_category:
            questions = rng.sample(questions, opts.songs_per_category)
        for i, q in enumerate(questions):
            q["value"] = POINT_VALUES[min(i, len(POINT_VALUES) - 1)]

        categories.append(
            {
                "id": f"cat_{pid}",
                "title": str(title),
                "playlistId": pid,
                "questions": questions,
            }
        )
        log(f"  {title}: {len(questions)} songs ({skipped} skipped)")

    if not categories:
        raise BuildError(
            f"No playlist had at least {opts.min_songs} usable songs. "
            "Lower --min-songs or pick fuller playlists."
        )

    return {
        "version": BANK_VERSION,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "ytmusicapi",
        "categories": categories,
    }


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def make_client(auth_mode: str, auth_file: Path) -> Any:
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
    return YTMusic(str(auth_file))


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
    parser.add_argument("--max-categories", type=int, default=8)
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
        client = make_client(args.auth_mode, auth_file)
        print(f"Reading playlists from YouTube Music ({args.auth_mode} auth)…")
        bank = build_bank(
            client,
            BuildOptions(
                playlists=args.playlists,
                max_categories=args.max_categories,
                songs_per_category=args.songs_per_category,
                min_songs=args.min_songs,
                seed=args.seed,
            ),
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

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return 0

    write_bank(bank, args.out)
    print(f"\nWrote {os.fspath(args.out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
