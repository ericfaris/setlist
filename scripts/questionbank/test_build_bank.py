"""Unit tests for build_bank.py. Pure stdlib, no network, no ytmusicapi, and no
real API key — ever.

The one injected dependency (the YTMusic client) is passed into build_bank() as
a fake returning canned responses. NO TEST MAY PERFORM A LIVE BUILD: there is no
network access in this suite and there must never be. Run it with the venv's
interpreter:

    scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v
"""

from __future__ import annotations

import io
import json
import re
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

from build_bank import (
    POINT_VALUES,
    TAXONOMY,
    BuildError,
    BuildOptions,
    CategoryDef,
    build_bank,
    categories_from_taxonomy,
    check_embeddable,
    collect_category_playlists,
    collect_category_songs,
    filter_embeddable,
    main,
    make_taxonomy_category_id,
    make_youtube_session,
    merge_bank,
    parse_playlist_id,
    taxonomy_categories,
    usable_track,
    write_bank,
)

TAX_ID_RE = re.compile(r"^cat_tax_[a-z0-9_]+__[a-z0-9_]+$")

LEGACY = dict(mode="playlists")


def track(video_id: str, title: str = "Song", artist: str = "Artist", **extra: Any) -> dict:
    t: dict[str, Any] = {
        "videoId": video_id,
        "title": title,
        "artists": [{"name": artist, "id": "UC1"}],
        "album": {"name": "An Album", "id": "AL1"},
        "duration_seconds": 210,
    }
    t.update(extra)
    return t


class FakeYTMusic:
    """Stands in for ytmusicapi.YTMusic — no network.

    `tracks_by_id` may carry ids that are not in `playlists` at all, which is how
    community/public playlists are simulated.

    `search_results` may be either a flat list (returned for every query) or a
    `dict[query, list]` so a taxonomy category's several queries can return
    different playlists. `playlist_calls` records the `limit` each get_playlist
    was called with — that is the no-truncation guard.
    """

    def __init__(
        self,
        playlists: list[dict],
        tracks_by_id: dict[str, list[Any]],
        search_results: list[Any] | dict[str, list[Any]] | None = None,
        titles: dict[str, str] | None = None,
        raises_for: set[str] | None = None,
    ):
        self._playlists = playlists
        self._tracks = tracks_by_id
        self._search_results = search_results if search_results is not None else []
        self._titles = titles or {}
        self._raises_for = raises_for or set()
        self.calls: list[str] = []
        self.search_calls: list[dict] = []
        self.playlist_calls: list[dict] = []

    def get_library_playlists(self, limit: int = 25) -> list[dict]:
        self.calls.append(f"library:{limit}")
        return self._playlists

    def get_playlist(self, playlist_id: str, limit: int | None = 100) -> dict:
        self.calls.append(f"playlist:{playlist_id}")
        self.playlist_calls.append({"playlistId": playlist_id, "limit": limit})
        if playlist_id in self._raises_for:
            raise RuntimeError(f"playlist {playlist_id} exploded")
        return {
            "id": playlist_id,
            "title": self._titles.get(playlist_id),
            "tracks": self._tracks.get(playlist_id, []),
        }

    def search(self, query: str, filter: str | None = None, limit: int = 20) -> list[Any]:
        self.search_calls.append({"query": query, "filter": filter, "limit": limit})
        if isinstance(self._search_results, dict):
            return self._search_results.get(query, [])
        return self._search_results


def simple_client(n_playlists: int = 2, per_playlist: int = 8) -> FakeYTMusic:
    playlists = [
        {"playlistId": f"PL{i}", "title": f"Playlist {i}"} for i in range(n_playlists)
    ]
    tracks = {
        f"PL{i}": [track(f"vid{i}_{j}", title=f"Song {i}-{j}") for j in range(per_playlist)]
        for i in range(n_playlists)
    }
    return FakeYTMusic(playlists, tracks)


def playlist_hit(pid: str, title: str | None = None) -> dict:
    """One community-search result row, in ytmusicapi's shape."""
    return {"resultType": "playlist", "playlistId": pid, "title": title or f"Mix {pid}"}


def quiet(*_args: Any, **_kwargs: Any) -> None:
    pass


class UsableTrackTests(unittest.TestCase):
    def test_accepts_a_normal_track(self):
        q = usable_track(track("abcdefghijk"))
        self.assertIsNotNone(q)
        assert q is not None
        self.assertEqual(q["videoId"], "abcdefghijk")
        self.assertEqual(q["id"], "q_abcdefghijk")
        self.assertEqual(q["artist"], "Artist")
        self.assertEqual(q["album"], "An Album")
        self.assertEqual(q["durationSeconds"], 210)
        self.assertIsNone(q["startSeconds"])

    def test_drops_tracks_without_a_video_id(self):
        self.assertIsNone(usable_track({"title": "X", "artists": [{"name": "A"}]}))
        self.assertIsNone(usable_track(track("")))
        self.assertIsNone(usable_track({**track("v"), "videoId": None}))

    def test_drops_tracks_without_a_title_or_artist(self):
        self.assertIsNone(usable_track({**track("v1"), "title": ""}))
        self.assertIsNone(usable_track({**track("v1"), "artists": []}))

    def test_drops_unavailable_tracks(self):
        self.assertIsNone(usable_track(track("v1", isAvailable=False)))

    def test_joins_multiple_artists(self):
        q = usable_track({**track("v1"), "artists": [{"name": "A"}, {"name": "B"}]})
        assert q is not None
        self.assertEqual(q["artist"], "A, B")

    def test_tolerates_a_missing_duration(self):
        q = usable_track({**track("v1"), "duration_seconds": None})
        assert q is not None
        self.assertIsNone(q["durationSeconds"])

    def test_ignores_non_dict_entries(self):
        self.assertIsNone(usable_track("not a track"))
        self.assertIsNone(usable_track(None))

    def test_drops_explicit_tracks(self):
        self.assertIsNone(usable_track(track("v1", isExplicit=True)))

    def test_keeps_tracks_that_are_not_flagged_explicit(self):
        self.assertIsNotNone(usable_track(track("v1", isExplicit=False)))
        self.assertIsNotNone(usable_track(track("v1", isExplicit=None)))
        self.assertIsNotNone(usable_track(track("v1")))

    def test_an_explicit_track_never_reaches_a_built_bank(self):
        client = FakeYTMusic(
            [{"playlistId": "PL0", "title": "Mixed"}],
            {
                "PL0": [track(f"clean{i}", title=f"Clean Song {i}") for i in range(6)]
                + [track("naughty", title="A Very Rude Song", isExplicit=True)]
            },
        )
        bank = build_bank(client, BuildOptions(seed=1, songs_per_category=99, **LEGACY), log=quiet)
        titles = [q["title"] for c in bank["categories"] for q in c["questions"]]
        all_ids = [q["videoId"] for c in bank["categories"] for q in c["questions"]]
        self.assertNotIn("A Very Rude Song", titles)
        self.assertIn("Clean Song 0", titles)
        self.assertNotIn("naughty", all_ids)


class BuildBankTests(unittest.TestCase):
    def test_builds_a_category_per_playlist(self):
        bank = build_bank(simple_client(3, 8), BuildOptions(seed=1, **LEGACY), log=quiet)
        self.assertEqual(bank["version"], 1)
        self.assertEqual(bank["source"], "ytmusicapi")
        self.assertEqual(len(bank["categories"]), 3)
        self.assertEqual(bank["categories"][0]["id"], "cat_PL0")
        self.assertEqual(bank["categories"][0]["playlistId"], "PL0")
        self.assertEqual(bank["categories"][0]["title"], "Playlist 0")

    def test_drops_unusable_tracks_but_keeps_the_rest(self):
        client = FakeYTMusic(
            [{"playlistId": "PL0", "title": "Mixed"}],
            {
                "PL0": [
                    track("v0"),
                    {"title": "no video id", "artists": [{"name": "A"}]},
                    track("v1"),
                    {"videoId": "v2", "title": "", "artists": [{"name": "A"}]},
                    track("v3"),
                    track("v4", isAvailable=False),
                    track("v5"),
                    track("v6"),
                ]
            },
        )
        bank = build_bank(client, BuildOptions(seed=1, **LEGACY, songs_per_category=99), log=quiet)
        ids = [q["videoId"] for q in bank["categories"][0]["questions"]]
        self.assertEqual(sorted(ids), ["v0", "v1", "v3", "v5", "v6"])

    def test_dedupes_a_video_id_across_categories(self):
        shared = track("SHARED", title="Shared Song")
        client = FakeYTMusic(
            [
                {"playlistId": "PL0", "title": "First"},
                {"playlistId": "PL1", "title": "Second"},
            ],
            {
                "PL0": [shared] + [track(f"a{i}") for i in range(5)],
                "PL1": [shared] + [track(f"b{i}") for i in range(5)],
            },
        )
        bank = build_bank(client, BuildOptions(seed=1, **LEGACY, songs_per_category=99), log=quiet)
        all_ids = [q["videoId"] for c in bank["categories"] for q in c["questions"]]
        self.assertEqual(len(all_ids), len(set(all_ids)))
        self.assertEqual(all_ids.count("SHARED"), 1)

    def test_excludes_a_thin_category(self):
        client = FakeYTMusic(
            [
                {"playlistId": "PL0", "title": "Full"},
                {"playlistId": "PL1", "title": "Thin"},
            ],
            {
                "PL0": [track(f"a{i}") for i in range(8)],
                "PL1": [track(f"b{i}") for i in range(3)],
            },
        )
        bank = build_bank(client, BuildOptions(seed=1, **LEGACY, min_songs=5), log=quiet)
        self.assertEqual([c["title"] for c in bank["categories"]], ["Full"])

    def test_assigns_point_values_by_index(self):
        bank = build_bank(
            simple_client(1, 8), BuildOptions(seed=1, **LEGACY, songs_per_category=8), log=quiet
        )
        values = [q["value"] for q in bank["categories"][0]["questions"]]
        expected = [POINT_VALUES[min(i, len(POINT_VALUES) - 1)] for i in range(8)]
        self.assertEqual(values, expected)

    def test_same_seed_gives_the_same_output(self):
        a = build_bank(simple_client(2, 20), BuildOptions(seed=7, **LEGACY), log=quiet)
        b = build_bank(simple_client(2, 20), BuildOptions(seed=7, **LEGACY), log=quiet)
        c = build_bank(simple_client(2, 20), BuildOptions(seed=8, **LEGACY), log=quiet)
        ids = lambda bank: [q["videoId"] for cat in bank["categories"] for q in cat["questions"]]
        self.assertEqual(ids(a), ids(b))
        self.assertNotEqual(ids(a), ids(c))

    def test_honours_max_categories(self):
        bank = build_bank(simple_client(6, 8), BuildOptions(seed=1, **LEGACY, max_categories=2), log=quiet)
        self.assertEqual(len(bank["categories"]), 2)

    def test_honours_songs_per_category(self):
        bank = build_bank(
            simple_client(1, 20), BuildOptions(seed=1, **LEGACY, songs_per_category=6), log=quiet
        )
        self.assertEqual(len(bank["categories"][0]["questions"]), 6)

    def test_filters_playlists_by_id_or_title_substring(self):
        client = simple_client(3, 8)
        by_id = build_bank(client, BuildOptions(seed=1, **LEGACY, playlists=["PL1"]), log=quiet)
        self.assertEqual([c["playlistId"] for c in by_id["categories"]], ["PL1"])
        by_title = build_bank(client, BuildOptions(seed=1, **LEGACY, playlists=["playlist 2"]), log=quiet)
        self.assertEqual([c["playlistId"] for c in by_title["categories"]], ["PL2"])

    def test_errors_when_nothing_matches(self):
        with self.assertRaises(BuildError):
            build_bank(simple_client(2, 8), BuildOptions(playlists=["nope"], **LEGACY), log=quiet)

    def test_errors_when_every_playlist_is_thin(self):
        with self.assertRaises(BuildError):
            build_bank(simple_client(2, 2), BuildOptions(min_songs=5, **LEGACY), log=quiet)

    def test_applies_embeddable_filter_when_key_and_session_given(self):
        client = simple_client(1, 8)
        session = FakeSession(status_by_id={"vid0_0": False})
        bank = build_bank(
            client,
            BuildOptions(seed=1, **LEGACY, youtube_api_key="key"),
            log=quiet,
            youtube_session=session,
        )
        all_ids = [q["videoId"] for c in bank["categories"] for q in c["questions"]]
        self.assertNotIn("vid0_0", all_ids)
        self.assertTrue(session.calls)

    def test_skips_embeddable_filter_without_a_key(self):
        session = FakeSession(status_by_id={"vid0_0": False})
        logs: list[str] = []
        bank = build_bank(
            simple_client(1, 8),
            BuildOptions(seed=1, **LEGACY),  # no youtube_api_key
            log=logs.append,
            youtube_session=session,
        )
        all_ids = [q["videoId"] for c in bank["categories"] for q in c["questions"]]
        self.assertIn("vid0_0", all_ids)
        self.assertEqual(session.calls, [])
        self.assertTrue([line for line in logs if "Embeddable pre-check not requested" in line], logs)

    def test_skips_embeddable_filter_without_a_session(self):
        logs: list[str] = []
        bank = build_bank(
            simple_client(1, 8),
            BuildOptions(seed=1, **LEGACY, youtube_api_key="key"),
            log=logs.append,
            youtube_session=None,
        )
        self.assertEqual(len(bank["categories"]), 1)
        self.assertTrue([line for line in logs if "Embeddable pre-check not requested" in line], logs)

    def test_raises_when_everything_becomes_unembeddable(self):
        client = simple_client(1, 8)
        session = FakeSession(status_by_id={f"vid0_{i}": False for i in range(8)})
        with self.assertRaises(BuildError):
            build_bank(
                client,
                BuildOptions(seed=1, **LEGACY, youtube_api_key="key"),
                log=quiet,
                youtube_session=session,
            )


class PlaylistIdTests(unittest.TestCase):
    def test_passes_a_bare_id_through(self):
        self.assertEqual(parse_playlist_id("PLabcdefghij"), "PLabcdefghij")

    def test_reads_a_music_youtube_playlist_url(self):
        self.assertEqual(
            parse_playlist_id("https://music.youtube.com/playlist?list=PLabcdefghij"),
            "PLabcdefghij",
        )
        self.assertEqual(
            parse_playlist_id("https://www.youtube.com/playlist?list=PLabcdefghij"),
            "PLabcdefghij",
        )

    def test_reads_a_watch_url_with_a_list_param(self):
        self.assertEqual(
            parse_playlist_id("https://www.youtube.com/watch?v=abc&list=PLabcdefghij"),
            "PLabcdefghij",
        )
        self.assertEqual(
            parse_playlist_id("https://youtu.be/abc?list=PLabcdefghij"), "PLabcdefghij"
        )

    def test_reads_a_browse_url_and_strips_the_vl_prefix(self):
        self.assertEqual(
            parse_playlist_id("https://music.youtube.com/browse/VLPLabcdefghij"),
            "PLabcdefghij",
        )

    def test_strips_a_leading_vl_from_a_bare_id(self):
        self.assertEqual(parse_playlist_id("VLPLabcdefghij"), "PLabcdefghij")

    def test_rejects_garbage(self):
        for bad in ("not a playlist", "", "   ", "https://example.com/", "PLshort"):
            with self.assertRaises(BuildError):
                parse_playlist_id(bad)


class CommunityTests(unittest.TestCase):
    def community_client(self, pid: str = "PLcommunity1", n: int = 8) -> FakeYTMusic:
        return FakeYTMusic(
            [{"playlistId": "PL0", "title": "Mine"}],
            {
                "PL0": [track(f"mine{i}") for i in range(8)],
                pid: [track(f"pub{i}", title=f"Public Song {i}") for i in range(n)],
            },
            titles={pid: "Somebody Else's Mix"},
        )

    def test_community_playlist_is_additive_to_the_library_by_default(self):
        """Community flags used to silently replace the library instead of
        adding to it — a real bug (a user asking for diverse genres got back
        only the two community playlists they searched for, with their whole
        47-playlist library dropped). Fixed: both are included unless
        --no-library says otherwise."""
        client = self.community_client()
        bank = build_bank(
            client,
            BuildOptions(seed=1, **LEGACY, community_playlists=["PLcommunity1"]),
            log=quiet,
        )
        self.assertIn("playlist:PLcommunity1", client.calls)
        self.assertTrue([c for c in client.calls if c.startswith("library:")])
        self.assertEqual(
            sorted(c["playlistId"] for c in bank["categories"]), ["PL0", "PLcommunity1"]
        )

    def test_no_library_excludes_the_library(self):
        client = self.community_client()
        bank = build_bank(
            client,
            BuildOptions(seed=1, **LEGACY, community_playlists=["PLcommunity1"], no_library=True),
            log=quiet,
        )
        self.assertFalse([c for c in client.calls if c.startswith("library:")])
        self.assertEqual([c["playlistId"] for c in bank["categories"]], ["PLcommunity1"])
        self.assertEqual(bank["categories"][0]["title"], "Somebody Else's Mix")

    def test_community_playlist_url_reaches_the_same_id(self):
        client = self.community_client()
        bank = build_bank(
            client,
            BuildOptions(
                seed=1,
                **LEGACY,
                community_playlists=[
                    "https://music.youtube.com/playlist?list=PLcommunity1"
                ],
                no_library=True,
            ),
            log=quiet,
        )
        self.assertIn("playlist:PLcommunity1", client.calls)
        self.assertEqual([c["playlistId"] for c in bank["categories"]], ["PLcommunity1"])

    def test_community_search_picks_and_logs_the_first_usable_result(self):
        client = self.community_client()
        client._search_results = [
            "not a dict",
            {"resultType": "song", "playlistId": "PLnope1234567"},
            {
                "resultType": "playlist",
                "playlistId": "PLcommunity1",
                "title": "Ultimate 80s",
                "author": "Tate Henderson",
                "itemCount": 174,
            },
            {"resultType": "playlist", "playlistId": "PLlater1234567"},
        ]
        logs: list[str] = []
        bank = build_bank(
            client,
            BuildOptions(seed=1, **LEGACY, community_searches=["80s hits"], no_library=True),
            log=logs.append,
        )
        self.assertEqual(client.search_calls[0]["filter"], "community_playlists")
        self.assertEqual(client.search_calls[0]["query"], "80s hits")
        self.assertIn("playlist:PLcommunity1", client.calls)
        self.assertNotIn("playlist:PLlater1234567", client.calls)
        picked = [line for line in logs if "Ultimate 80s" in line]
        self.assertTrue(picked, logs)
        self.assertIn("Tate Henderson", picked[0])
        ids = [q["videoId"] for c in bank["categories"] for q in c["questions"]]
        self.assertTrue(all(i.startswith("pub") for i in ids), ids)

    def test_a_fruitless_search_warns_but_does_not_abort(self):
        client = self.community_client()
        client._search_results = []
        logs: list[str] = []
        bank = build_bank(
            client,
            BuildOptions(
                seed=1,
                **LEGACY,
                community_searches=["nothing at all"],
                community_playlists=["PLcommunity1"],
                no_library=True,
            ),
            log=logs.append,
        )
        self.assertTrue([line for line in logs if "no usable playlist" in line], logs)
        self.assertEqual([c["playlistId"] for c in bank["categories"]], ["PLcommunity1"])

    def test_community_and_library_sources_dedupe_a_shared_video_id(self):
        shared = track("SHARED", title="Shared Song")
        client = FakeYTMusic(
            [{"playlistId": "PL0", "title": "Mine"}],
            {
                "PL0": [shared] + [track(f"a{i}") for i in range(5)],
                "PLcommunity1": [shared] + [track(f"b{i}") for i in range(5)],
            },
        )
        bank = build_bank(
            client,
            BuildOptions(
                seed=1,
                **LEGACY,
                songs_per_category=99,
                playlists=["PL0"],
                community_playlists=["PLcommunity1"],
            ),
            log=quiet,
        )
        all_ids = [q["videoId"] for c in bank["categories"] for q in c["questions"]]
        self.assertEqual(len(all_ids), len(set(all_ids)))
        self.assertEqual(all_ids.count("SHARED"), 1)
        self.assertEqual(len(bank["categories"]), 2)


class _HttpResponse:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class FakeSession:
    """Stands in for requests.Session — no network.

    `status_by_id` maps videoId -> True/False; an id absent from it is
    "unknown" (the fake API response simply omits it, matching a real
    deleted/private video). `raises`, if set, is raised on every .get() call.
    `error`, if set, makes every response look like a YouTube API error body.
    """

    def __init__(
        self,
        status_by_id: dict[str, bool] | None = None,
        raises: Exception | None = None,
        error: str | None = None,
    ) -> None:
        self.status_by_id = status_by_id or {}
        self.raises = raises
        self.error = error
        self.calls: list[dict] = []

    def get(self, url: str, params: dict, timeout: float) -> _HttpResponse:
        self.calls.append({"url": url, "params": params, "timeout": timeout})
        if self.raises is not None:
            raise self.raises
        if self.error is not None:
            return _HttpResponse({"error": {"message": self.error}})
        ids = (params.get("id") or "").split(",")
        items = [
            {"id": vid, "status": {"embeddable": self.status_by_id[vid]}}
            for vid in ids
            if vid in self.status_by_id
        ]
        return _HttpResponse({"items": items})


class YoutubeEmbeddableTests(unittest.TestCase):
    def test_check_embeddable_marks_known_ids_and_omits_unknown(self):
        session = FakeSession(status_by_id={"v1": True, "v2": False})
        result = check_embeddable(session, "key", ["v1", "v2", "v3"], quiet)
        self.assertEqual(result, {"v1": True, "v2": False})

    def test_check_embeddable_batches_in_chunks_of_50(self):
        ids = [f"vid{i}" for i in range(120)]
        session = FakeSession(status_by_id={vid: True for vid in ids})
        check_embeddable(session, "key", ids, quiet)
        self.assertEqual(len(session.calls), 3)
        for call in session.calls[:-1]:
            self.assertEqual(len(call["params"]["id"].split(",")), 50)

    def test_check_embeddable_survives_a_network_error(self):
        logs: list[str] = []
        session = FakeSession(raises=RuntimeError("connection refused"))
        result = check_embeddable(session, "key", ["v1"], logs.append)
        self.assertEqual(result, {})
        self.assertTrue([line for line in logs if "connection refused" in line], logs)

    def test_check_embeddable_survives_an_api_error_payload(self):
        logs: list[str] = []
        session = FakeSession(error="quota exceeded")
        result = check_embeddable(session, "key", ["v1"], logs.append)
        self.assertEqual(result, {})
        self.assertTrue([line for line in logs if "quota exceeded" in line], logs)

    def test_filter_embeddable_drops_flagged_keeps_unknown(self):
        sources = [
            {
                "playlistId": "PL0",
                "title": "Mine",
                "questions": [track(f"v{i}")["videoId"] and {"videoId": f"v{i}"} for i in range(6)],
            }
        ]
        session = FakeSession(status_by_id={"v0": False})
        logs: list[str] = []
        out = filter_embeddable(session, "key", sources, BuildOptions(min_songs=3), logs.append)
        remaining_ids = [q["videoId"] for q in out[0]["questions"]]
        self.assertNotIn("v0", remaining_ids)
        # v1..v5 are "unknown" (absent from the fake API) and must be kept.
        self.assertEqual(set(remaining_ids), {f"v{i}" for i in range(1, 6)})
        self.assertTrue([line for line in logs if "dropped 1 track" in line], logs)

    def test_filter_embeddable_drops_a_source_below_min_songs(self):
        sources = [
            {"playlistId": "PL0", "title": "Thin", "questions": [{"videoId": "v0"}, {"videoId": "v1"}]}
        ]
        session = FakeSession(status_by_id={"v0": False})
        logs: list[str] = []
        out = filter_embeddable(session, "key", sources, BuildOptions(min_songs=2), logs.append)
        self.assertEqual(out, [])
        self.assertTrue([line for line in logs if "Thin" in line and "dropped below" in line], logs)

    def test_filter_embeddable_no_ids_returns_unchanged(self):
        self.assertEqual(filter_embeddable(FakeSession(), "key", [], BuildOptions(), quiet), [])

    def test_make_youtube_session_returns_something_with_get(self):
        session = make_youtube_session(quiet)
        self.assertIsNotNone(session)
        self.assertTrue(hasattr(session, "get"))


class SchemaTests(unittest.TestCase):
    """Mirrors the field checks validateQuestionBank() performs in TypeScript."""

    def assert_valid(self, bank: dict) -> None:
        self.assertEqual(bank["version"], 1)
        self.assertIn(bank["source"], ("ytmusicapi", "fixture"))
        self.assertTrue(bank["generatedAt"])
        self.assertGreater(len(bank["categories"]), 0)
        for cat in bank["categories"]:
            for field in ("id", "title"):
                self.assertIsInstance(cat[field], str)
                self.assertTrue(cat[field].strip())
            # Relaxed to mirror validateQuestionBank: a non-empty string when the
            # category maps to one playlist, None for an AI-generated one.
            self.assertIn(type(cat["playlistId"]), (str, type(None)))
            if isinstance(cat["playlistId"], str):
                self.assertTrue(cat["playlistId"].strip())
            self.assertGreater(len(cat["questions"]), 0)
            for q in cat["questions"]:
                for field in ("id", "title", "artist", "videoId"):
                    self.assertIsInstance(q[field], str)
                    self.assertTrue(q[field].strip())
                self.assertIsInstance(q["value"], int)
                self.assertIn(type(q["album"]), (str, type(None)))
                self.assertIn(type(q["durationSeconds"]), (int, type(None)))
                self.assertIn(type(q["startSeconds"]), (int, type(None)))

    def test_generated_bank_matches_the_documented_schema(self):
        bank = build_bank(simple_client(3, 8), BuildOptions(seed=3, **LEGACY), log=quiet)
        self.assert_valid(bank)

    def test_written_file_round_trips(self):
        bank = build_bank(simple_client(2, 8), BuildOptions(seed=3, **LEGACY), log=quiet)
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "nested" / "bank.json"
            write_bank(bank, out)
            self.assertTrue(out.exists())
            reloaded = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(reloaded, bank)
            self.assert_valid(reloaded)

    def test_a_taxonomy_bank_validates_and_round_trips_with_null_playlist_ids(self):
        bank = build_bank(
            taxonomy_client(),
            taxonomy_opts(category_filters=["Yacht Rock", "Grunge"]),
            log=quiet,
            sleep=quiet,
        )
        self.assert_valid(bank)
        self.assertTrue(all(c["playlistId"] is None for c in bank["categories"]))
        self.assertTrue(all(TAX_ID_RE.match(c["id"]) for c in bank["categories"]))
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "bank.json"
            write_bank(bank, out)
            text = out.read_text(encoding="utf-8")
            self.assertIn('"playlistId": null', text)
            reloaded = json.loads(text)
            self.assertEqual(reloaded, bank)
            self.assert_valid(reloaded)


# --------------------------------------------------------------------------
# The curated taxonomy. Every one of these runs against FakeYTMusic — no test
# here (or anywhere in this file) performs a live build.
# --------------------------------------------------------------------------


def taxonomy_opts(**kw: Any) -> BuildOptions:
    """Taxonomy BuildOptions tuned for tests: no sleeping, a low song floor."""
    defaults: dict[str, Any] = dict(
        mode="taxonomy", seed=1, sleep_ms=0, min_category_songs=3, per_query_results=1
    )
    defaults.update(kw)
    return BuildOptions(**defaults)


def taxonomy_client(
    playlists: dict[str, int] | None = None, **kw: Any
) -> FakeYTMusic:
    """A fake whose every community search returns the same playlists, each with
    its own distinct tracks. `playlists` maps playlistId -> track count."""
    playlists = playlists or {"PLaaaaaaaaaa": 6, "PLbbbbbbbbbb": 5}
    tracks = {
        pid: [track(f"{pid}_{i}", title=f"{pid} Song {i}") for i in range(n)]
        for pid, n in playlists.items()
    }
    hits = [playlist_hit(pid) for pid in playlists]
    return FakeYTMusic([], tracks, search_results=hits, **kw)


class TaxonomyTests(unittest.TestCase):
    def test_the_taxonomy_has_61_enabled_categories_with_unique_keys_and_ids(self):
        cats = taxonomy_categories()
        self.assertEqual(len(cats), 61)
        self.assertEqual(len(TAXONOMY), 61)
        keys = [c.key for c in cats]
        ids = [make_taxonomy_category_id(c) for c in cats]
        self.assertEqual(len(set(keys)), len(keys))
        self.assertEqual(len(set(ids)), len(ids))

    def test_every_category_has_a_way_to_find_playlists(self):
        for cat in taxonomy_categories():
            self.assertTrue(cat.queries or cat.playlist_ids, cat.key)
            self.assertTrue(cat.title.strip(), cat.key)

    def test_ids_match_the_documented_shape_and_are_stable(self):
        first = [make_taxonomy_category_id(c) for c in taxonomy_categories()]
        second = [make_taxonomy_category_id(c) for c in taxonomy_categories()]
        self.assertEqual(first, second)
        for cid in first:
            self.assertRegex(cid, TAX_ID_RE)
            # exactly one "__", so parseCategoryGroup() can split it unambiguously
            self.assertEqual(cid.count("__"), 1)

    def test_list_categories_prints_every_title_and_exits_zero(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = main(["--list-categories"])
        self.assertEqual(code, 0)
        out = buf.getvalue()
        for cat in taxonomy_categories():
            self.assertIn(cat.title, out)
            self.assertIn(cat.key, out)
            self.assertIn(cat.group, out)

    def test_collect_category_playlists_prefers_pins_then_queries_and_stops(self):
        client = FakeYTMusic(
            [],
            {},
            search_results={
                "q1": [playlist_hit("PLquery1aaaa"), playlist_hit("PLquery1bbbb")],
                "q2": [playlist_hit("PLquery2aaaa")],
            },
        )
        cat = CategoryDef(
            key="k",
            title="T",
            group="genre",
            queries=("q1", "q2"),
            playlist_ids=("PLpinned0001",),
            max_playlists=3,
        )
        got = collect_category_playlists(client, cat, taxonomy_opts(per_query_results=2), quiet)
        self.assertEqual([pid for pid, _ in got], ["PLpinned0001", "PLquery1aaaa", "PLquery1bbbb"])
        # capped at max_playlists, so the second query was never even issued
        self.assertEqual([c["query"] for c in client.search_calls], ["q1"])

    def test_collect_category_songs_fetches_whole_playlists(self):
        """The no-truncation guard: limit=None is what makes a 500-song source
        actually contribute 500 songs."""
        client = taxonomy_client()
        cat = CategoryDef(key="k", title="T", group="genre", queries=("q",))
        collect_category_songs(client, cat, taxonomy_opts(per_query_results=2), quiet, sleep=quiet)
        self.assertTrue(client.playlist_calls)
        for call in client.playlist_calls:
            self.assertIsNone(call["limit"], call)

    def test_aggregates_across_playlists_and_dedupes_within_the_category(self):
        shared = track("SHAREDVIDEO", title="Shared Song")
        client = FakeYTMusic(
            [],
            {
                "PLaaaaaaaaaa": [shared] + [track(f"a{i}") for i in range(4)],
                "PLbbbbbbbbbb": [shared] + [track(f"b{i}") for i in range(4)],
            },
            search_results=[playlist_hit("PLaaaaaaaaaa"), playlist_hit("PLbbbbbbbbbb")],
        )
        cat = CategoryDef(key="k", title="T", group="genre", queries=("q",))
        songs = collect_category_songs(
            client, cat, taxonomy_opts(per_query_results=2), quiet, sleep=quiet
        )
        ids = [q["videoId"] for q in songs]
        # the union, not the sum, and strictly more than either single playlist
        self.assertEqual(len(ids), 9)
        self.assertEqual(len(set(ids)), len(ids))
        self.assertEqual(ids.count("SHAREDVIDEO"), 1)
        self.assertGreater(len(ids), 5)

    def test_an_exploding_playlist_is_skipped_and_the_rest_survive(self):
        client = taxonomy_client(raises_for={"PLaaaaaaaaaa"})
        cat = CategoryDef(key="k", title="T", group="genre", queries=("q",))
        logs: list[str] = []
        songs = collect_category_songs(
            client, cat, taxonomy_opts(per_query_results=2), logs.append, sleep=quiet
        )
        self.assertEqual(len(songs), 5)  # only PLbbbbbbbbbb's tracks
        self.assertTrue([line for line in logs if "could not read playlist" in line], logs)

    def test_explicit_tracks_are_dropped_on_the_taxonomy_path_too(self):
        client = FakeYTMusic(
            [],
            {
                "PLaaaaaaaaaa": [track(f"clean{i}") for i in range(4)]
                + [track("naughty", title="A Very Rude Song", isExplicit=True)]
            },
            search_results=[playlist_hit("PLaaaaaaaaaa")],
        )
        cat = CategoryDef(key="k", title="T", group="genre", queries=("q",))
        songs = collect_category_songs(client, cat, taxonomy_opts(), quiet, sleep=quiet)
        self.assertNotIn("naughty", [q["videoId"] for q in songs])
        self.assertEqual(len(songs), 4)

    def test_the_same_video_id_is_kept_in_two_different_categories(self):
        """The counterpart of the engine's per-section dedupe: a song
        legitimately belongs to Rock, 90s Rock AND 90s Grunge. A global dedupe
        here would gut every category after the first."""
        client = taxonomy_client()
        bank = build_bank(
            client,
            taxonomy_opts(category_filters=["Yacht Rock", "Garage Rock"]),
            log=quiet,
            sleep=quiet,
        )
        self.assertEqual(len(bank["categories"]), 2)
        first = {q["videoId"] for q in bank["categories"][0]["questions"]}
        second = {q["videoId"] for q in bank["categories"][1]["questions"]}
        self.assertTrue(first)
        self.assertEqual(first, second)

    def test_a_thin_category_is_dropped_and_named(self):
        client = taxonomy_client({"PLaaaaaaaaaa": 2})
        logs: list[str] = []
        dropped: list[tuple[str, int]] = []
        with self.assertRaises(BuildError):
            categories_from_taxonomy(
                client,
                taxonomy_opts(category_filters=["Yacht Rock"], min_category_songs=5),
                __import__("random").Random(1),
                logs.append,
                sleep=quiet,
                dropped=dropped,
            )
        self.assertEqual(dropped, [("Yacht Rock", 2)])
        self.assertTrue([line for line in logs if "Yacht Rock" in line and "drop" in line], logs)

    def test_a_thin_category_does_not_sink_the_run(self):
        client = FakeYTMusic(
            [],
            {"PLfat0000000": [track(f"f{i}") for i in range(6)], "PLthin000000": [track("t0")]},
            search_results={
                "yacht rock songs": [playlist_hit("PLfat0000000")],
                "garage rock songs": [playlist_hit("PLthin000000")],
            },
        )
        dropped: list[tuple[str, int]] = []
        bank = build_bank(
            client,
            taxonomy_opts(category_filters=["Yacht Rock", "Garage Rock"], min_category_songs=3),
            log=quiet,
            sleep=quiet,
            dropped=dropped,
        )
        self.assertEqual([c["title"] for c in bank["categories"]], ["Yacht Rock"])
        self.assertEqual(dropped, [("Garage Rock", 1)])

    def test_category_filter_narrows_the_run_to_just_those_categories(self):
        client = taxonomy_client()
        bank = build_bank(
            client, taxonomy_opts(category_filters=["Yacht Rock"]), log=quiet, sleep=quiet
        )
        self.assertEqual([c["title"] for c in bank["categories"]], ["Yacht Rock"])
        self.assertEqual(bank["categories"][0]["id"], "cat_tax_rock_sub__yacht_rock")
        # and nothing outside that category was ever searched for
        queries = [c["query"] for c in client.search_calls]
        self.assertTrue(queries)
        for q in queries:
            self.assertIn("yacht rock", q)

    def test_taxonomy_categories_filters_by_key_or_title_case_insensitively(self):
        self.assertEqual(len(taxonomy_categories()), 61)
        self.assertEqual([c.key for c in taxonomy_categories(["yacht"])], ["yacht_rock"])
        self.assertEqual([c.key for c in taxonomy_categories(["YACHT ROCK"])], ["yacht_rock"])
        self.assertEqual(taxonomy_categories(["nothing at all like this"]), [])

    def test_the_sleep_is_called_between_playlist_fetches(self):
        calls: list[float] = []
        client = taxonomy_client({"PL1111111111": 4, "PL2222222222": 4, "PL3333333333": 4})
        cat = CategoryDef(key="k", title="T", group="genre", queries=("q",))
        collect_category_songs(
            client,
            cat,
            taxonomy_opts(per_query_results=3, sleep_ms=250),
            quiet,
            sleep=calls.append,
        )
        # three playlists, so two gaps — never before the first fetch
        self.assertEqual(calls, [0.25, 0.25])

    def test_a_taxonomy_category_uses_the_flat_point_value(self):
        bank = build_bank(
            taxonomy_client(), taxonomy_opts(category_filters=["Yacht Rock"]), log=quiet, sleep=quiet
        )
        values = {q["value"] for q in bank["categories"][0]["questions"]}
        self.assertEqual(values, {POINT_VALUES[0]})

    def test_max_songs_per_category_truncates(self):
        bank = build_bank(
            taxonomy_client(),
            taxonomy_opts(category_filters=["Yacht Rock"], max_songs_per_category=4),
            log=quiet,
            sleep=quiet,
        )
        self.assertEqual(len(bank["categories"][0]["questions"]), 4)

    def test_a_filter_matching_nothing_is_a_build_error(self):
        with self.assertRaises(BuildError):
            build_bank(
                taxonomy_client(),
                taxonomy_opts(category_filters=["no such category anywhere"]),
                log=quiet,
                sleep=quiet,
            )


class MergeTests(unittest.TestCase):
    def cat(self, cid: str, n: int = 1) -> dict:
        return {"id": cid, "title": cid, "playlistId": None, "questions": [{"videoId": f"{cid}{n}"}]}

    def test_merge_replaces_same_id_categories_and_keeps_the_rest(self):
        existing = {"version": 1, "categories": [self.cat("a"), self.cat("b"), self.cat("c")]}
        fresh = {"version": 1, "categories": [self.cat("b", 99), self.cat("d")]}
        merged = merge_bank(existing, fresh)
        self.assertEqual([c["id"] for c in merged["categories"]], ["a", "b", "c", "d"])
        rebuilt = next(c for c in merged["categories"] if c["id"] == "b")
        self.assertEqual(rebuilt["questions"][0]["videoId"], "b99")
        # untouched categories come through byte-identical
        self.assertEqual(
            next(c for c in merged["categories"] if c["id"] == "a"), existing["categories"][0]
        )

    def test_merge_takes_the_fresh_banks_metadata(self):
        existing = {"version": 1, "generatedAt": "old", "categories": [self.cat("a")]}
        fresh = {"version": 1, "generatedAt": "new", "categories": [self.cat("a", 2)]}
        self.assertEqual(merge_bank(existing, fresh)["generatedAt"], "new")

    def test_merge_into_an_empty_bank_is_just_the_fresh_bank(self):
        fresh = {"version": 1, "categories": [self.cat("a")]}
        self.assertEqual(merge_bank({}, fresh), fresh)


if __name__ == "__main__":
    unittest.main()
