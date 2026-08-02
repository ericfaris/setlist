"""Unit tests for build_bank.py. Pure stdlib, no network, no ytmusicapi, no
anthropic, and no real API key — ever.

Both injected dependencies (the YTMusic client and the Anthropic client) are
passed into build_bank() as fakes returning canned responses. Run them with the
venv's interpreter:

    scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from build_bank import (
    DEFAULT_CATEGORIES,
    POINT_VALUES,
    AIUnavailable,
    BuildError,
    BuildOptions,
    build_ai_prompt,
    build_bank,
    check_embeddable,
    filter_embeddable,
    make_ai_client,
    make_category_id,
    make_youtube_session,
    parse_ai_response,
    parse_playlist_id,
    usable_track,
    write_bank,
)

AI_ID_RE = re.compile(r"^cat_ai_[a-z0-9_]+_[0-9a-f]{6}$")


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
    """

    def __init__(
        self,
        playlists: list[dict],
        tracks_by_id: dict[str, list[Any]],
        search_results: list[Any] | None = None,
        titles: dict[str, str] | None = None,
    ):
        self._playlists = playlists
        self._tracks = tracks_by_id
        self._search_results = search_results if search_results is not None else []
        self._titles = titles or {}
        self.calls: list[str] = []
        self.search_calls: list[dict] = []

    def get_library_playlists(self, limit: int = 25) -> list[dict]:
        self.calls.append(f"library:{limit}")
        return self._playlists

    def get_playlist(self, playlist_id: str, limit: int = 100) -> dict:
        self.calls.append(f"playlist:{playlist_id}")
        return {
            "id": playlist_id,
            "title": self._titles.get(playlist_id),
            "tracks": self._tracks.get(playlist_id, []),
        }

    def search(self, query: str, filter: str | None = None, limit: int = 20) -> list[Any]:
        self.search_calls.append({"query": query, "filter": filter, "limit": limit})
        return self._search_results


class _Block:
    def __init__(self, text: str) -> None:
        self.type = "text"
        self.text = text


class _Response:
    def __init__(self, text: str | None, stop_reason: str) -> None:
        self.stop_reason = stop_reason
        self.content = [] if text is None else [_Block(text)]


class _Messages:
    def __init__(self, parent: "FakeAnthropic") -> None:
        self._parent = parent

    def create(self, **kwargs: Any) -> _Response:
        self._parent.calls.append(kwargs)
        if self._parent.raises is not None:
            raise self._parent.raises
        return _Response(self._parent.text, self._parent.stop_reason)


class FakeAnthropic:
    """Stands in for anthropic.Anthropic — no network. `text` is the reply body;
    pass raises=<Exception> to simulate an API failure."""

    def __init__(
        self,
        text: str | None = "",
        stop_reason: str = "end_turn",
        raises: Exception | None = None,
    ) -> None:
        self.text = text
        self.stop_reason = stop_reason
        self.raises = raises
        self.calls: list[dict] = []
        self.messages = _Messages(self)

    @property
    def prompt(self) -> str:
        return self.calls[0]["messages"][0]["content"]


def simple_client(n_playlists: int = 2, per_playlist: int = 8) -> FakeYTMusic:
    playlists = [
        {"playlistId": f"PL{i}", "title": f"Playlist {i}"} for i in range(n_playlists)
    ]
    tracks = {
        f"PL{i}": [track(f"vid{i}_{j}", title=f"Song {i}-{j}") for j in range(per_playlist)]
        for i in range(n_playlists)
    }
    return FakeYTMusic(playlists, tracks)


def ai_reply(categories: list[tuple[str, list[int]]], blocked: list[int] | None = None) -> str:
    """Canned model reply, in the 1-based shape the prompt asks for."""
    payload: dict[str, Any] = {
        "categories": [{"title": title, "songs": songs} for title, songs in categories]
    }
    if blocked is not None:
        payload["blocked"] = blocked
    return json.dumps(payload)


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

    def test_an_explicit_track_never_reaches_the_ai_prompt(self):
        client = FakeYTMusic(
            [{"playlistId": "PL0", "title": "Mixed"}],
            {
                "PL0": [track(f"clean{i}", title=f"Clean Song {i}") for i in range(6)]
                + [track("naughty", title="A Very Rude Song", isExplicit=True)]
            },
        )
        ai = FakeAnthropic(ai_reply([("Clean Fun", [1, 2, 3, 4, 5])]))
        bank = build_bank(client, BuildOptions(seed=1), log=quiet, ai_client=ai)
        self.assertNotIn("A Very Rude Song", ai.prompt)
        self.assertIn("Clean Song 0", ai.prompt)
        all_ids = [q["videoId"] for c in bank["categories"] for q in c["questions"]]
        self.assertNotIn("naughty", all_ids)


class BuildBankTests(unittest.TestCase):
    def test_builds_a_category_per_playlist(self):
        bank = build_bank(simple_client(3, 8), BuildOptions(seed=1), log=quiet)
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
        bank = build_bank(client, BuildOptions(seed=1, songs_per_category=99), log=quiet)
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
        bank = build_bank(client, BuildOptions(seed=1, songs_per_category=99), log=quiet)
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
        bank = build_bank(client, BuildOptions(seed=1, min_songs=5), log=quiet)
        self.assertEqual([c["title"] for c in bank["categories"]], ["Full"])

    def test_assigns_point_values_by_index(self):
        bank = build_bank(
            simple_client(1, 8), BuildOptions(seed=1, songs_per_category=8), log=quiet
        )
        values = [q["value"] for q in bank["categories"][0]["questions"]]
        expected = [POINT_VALUES[min(i, len(POINT_VALUES) - 1)] for i in range(8)]
        self.assertEqual(values, expected)

    def test_same_seed_gives_the_same_output(self):
        a = build_bank(simple_client(2, 20), BuildOptions(seed=7), log=quiet)
        b = build_bank(simple_client(2, 20), BuildOptions(seed=7), log=quiet)
        c = build_bank(simple_client(2, 20), BuildOptions(seed=8), log=quiet)
        ids = lambda bank: [q["videoId"] for cat in bank["categories"] for q in cat["questions"]]
        self.assertEqual(ids(a), ids(b))
        self.assertNotEqual(ids(a), ids(c))

    def test_honours_max_categories(self):
        bank = build_bank(simple_client(6, 8), BuildOptions(seed=1, max_categories=2), log=quiet)
        self.assertEqual(len(bank["categories"]), 2)

    def test_honours_songs_per_category(self):
        bank = build_bank(
            simple_client(1, 20), BuildOptions(seed=1, songs_per_category=6), log=quiet
        )
        self.assertEqual(len(bank["categories"][0]["questions"]), 6)

    def test_filters_playlists_by_id_or_title_substring(self):
        client = simple_client(3, 8)
        by_id = build_bank(client, BuildOptions(seed=1, playlists=["PL1"]), log=quiet)
        self.assertEqual([c["playlistId"] for c in by_id["categories"]], ["PL1"])
        by_title = build_bank(client, BuildOptions(seed=1, playlists=["playlist 2"]), log=quiet)
        self.assertEqual([c["playlistId"] for c in by_title["categories"]], ["PL2"])

    def test_errors_when_nothing_matches(self):
        with self.assertRaises(BuildError):
            build_bank(simple_client(2, 8), BuildOptions(playlists=["nope"]), log=quiet)

    def test_errors_when_every_playlist_is_thin(self):
        with self.assertRaises(BuildError):
            build_bank(simple_client(2, 2), BuildOptions(min_songs=5), log=quiet)

    def test_applies_embeddable_filter_when_key_and_session_given(self):
        client = simple_client(1, 8)
        session = FakeSession(status_by_id={"vid0_0": False})
        bank = build_bank(
            client,
            BuildOptions(seed=1, youtube_api_key="key"),
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
            BuildOptions(seed=1),  # no youtube_api_key
            log=logs.append,
            youtube_session=session,
        )
        all_ids = [q["videoId"] for c in bank["categories"] for q in c["questions"]]
        self.assertIn("vid0_0", all_ids)
        self.assertEqual(session.calls, [])
        self.assertTrue([line for line in logs if "YOUTUBE_API_KEY not set" in line], logs)

    def test_skips_embeddable_filter_without_a_session(self):
        logs: list[str] = []
        bank = build_bank(
            simple_client(1, 8),
            BuildOptions(seed=1, youtube_api_key="key"),
            log=logs.append,
            youtube_session=None,
        )
        self.assertEqual(len(bank["categories"]), 1)
        self.assertTrue([line for line in logs if "YOUTUBE_API_KEY not set" in line], logs)

    def test_raises_when_everything_becomes_unembeddable(self):
        client = simple_client(1, 8)
        session = FakeSession(status_by_id={f"vid0_{i}": False for i in range(8)})
        with self.assertRaises(BuildError):
            build_bank(
                client,
                BuildOptions(seed=1, youtube_api_key="key"),
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
            BuildOptions(seed=1, community_playlists=["PLcommunity1"]),
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
            BuildOptions(seed=1, community_playlists=["PLcommunity1"], no_library=True),
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
            BuildOptions(seed=1, community_searches=["80s hits"], no_library=True),
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


class AICategoryTests(unittest.TestCase):
    def test_builds_ai_themed_categories_instead_of_one_per_playlist(self):
        client = simple_client(2, 6)
        ai = FakeAnthropic(
            ai_reply(
                [
                    ("Songs About Cars", [1, 2, 3, 4, 5]),
                    ("One-Hit Wonders", [7, 8, 9, 10, 11]),
                ]
            )
        )
        bank = build_bank(client, BuildOptions(seed=1), log=quiet, ai_client=ai)
        self.assertEqual(
            [c["title"] for c in bank["categories"]],
            ["Songs About Cars", "One-Hit Wonders"],
        )
        for cat in bank["categories"]:
            self.assertIsNone(cat["playlistId"])
            self.assertRegex(cat["id"], AI_ID_RE)
        self.assertNotIn("Playlist 0", [c["title"] for c in bank["categories"]])

    def test_makes_exactly_one_batch_call(self):
        client = simple_client(4, 20)
        ai = FakeAnthropic(
            ai_reply([("Big Theme", list(range(1, 30))), ("Other", list(range(30, 50)))])
        )
        build_bank(client, BuildOptions(seed=1), log=quiet, ai_client=ai)
        self.assertEqual(len(ai.calls), 1)

    def test_categories_flag_sets_the_prompt_and_caps_the_output(self):
        reply = ai_reply(
            [
                ("A", [1, 2, 3, 4, 5]),
                ("B", [7, 8, 9, 10, 11]),
                ("C", [13, 14, 15, 16, 17]),
                ("D", [19, 20, 21, 22, 23]),
            ]
        )
        ai = FakeAnthropic(reply)
        bank = build_bank(
            simple_client(4, 6), BuildOptions(seed=1, categories=3), log=quiet, ai_client=ai
        )
        self.assertIn("exactly 3", ai.prompt)
        self.assertEqual(len(bank["categories"]), 3)

        default_ai = FakeAnthropic(reply)
        build_bank(simple_client(4, 6), BuildOptions(seed=1), log=quiet, ai_client=default_ai)
        self.assertIn(f"exactly {DEFAULT_CATEGORIES}", default_ai.prompt)

    def test_a_blocked_index_is_excluded_even_when_also_categorised(self):
        client = simple_client(2, 6)
        ai = FakeAnthropic(ai_reply([("Mixed Bag", [1, 2, 3, 4, 5, 6])], blocked=[3]))
        logs: list[str] = []
        bank = build_bank(client, BuildOptions(seed=1), log=logs.append, ai_client=ai)
        ids = [q["videoId"] for c in bank["categories"] for q in c["questions"]]
        self.assertNotIn("vid0_2", ids)  # 1-based 3 -> the third pooled song
        self.assertEqual(len(ids), 5)
        self.assertTrue([line for line in logs if "content pass" in line], logs)

    def test_tolerates_odd_indices(self):
        client = simple_client(2, 6)
        ai = FakeAnthropic(ai_reply([("Odd Ones", [1, 1, "2", 3, 999, 4, 5, None])]))
        bank = build_bank(client, BuildOptions(seed=1), log=quiet, ai_client=ai)
        ids = sorted(q["videoId"] for q in bank["categories"][0]["questions"])
        self.assertEqual(ids, ["vid0_0", "vid0_1", "vid0_2", "vid0_3", "vid0_4"])

    def test_a_song_in_two_categories_lands_only_in_the_first(self):
        client = simple_client(2, 6)
        ai = FakeAnthropic(
            ai_reply([("First", [1, 2, 3, 4, 5]), ("Second", [1, 7, 8, 9, 10, 11])])
        )
        bank = build_bank(client, BuildOptions(seed=1), log=quiet, ai_client=ai)
        first = [q["videoId"] for q in bank["categories"][0]["questions"]]
        second = [q["videoId"] for q in bank["categories"][1]["questions"]]
        self.assertIn("vid0_0", first)
        self.assertNotIn("vid0_0", second)

    def test_drops_an_ai_category_below_min_songs(self):
        client = simple_client(2, 6)
        ai = FakeAnthropic(ai_reply([("Too Thin", [1, 2]), ("Full", [7, 8, 9, 10, 11])]))
        logs: list[str] = []
        bank = build_bank(client, BuildOptions(seed=1), log=logs.append, ai_client=ai)
        self.assertEqual([c["title"] for c in bank["categories"]], ["Full"])
        self.assertTrue([line for line in logs if "Too Thin" in line], logs)


class AIParseTests(unittest.TestCase):
    def test_parses_clean_json(self):
        cats, blocked = parse_ai_response(
            '{"categories": [{"title": "Cars", "songs": [1, 5]}], "blocked": [3]}'
        )
        self.assertEqual(cats, [{"title": "Cars", "songs": [0, 4]}])
        self.assertEqual(blocked, [2])

    def test_parses_fenced_json(self):
        raw = '```json\n{"categories": [{"title": "Cars", "songs": [1]}]}\n```'
        cats, blocked = parse_ai_response(raw)
        self.assertEqual(cats[0]["title"], "Cars")
        self.assertEqual(blocked, [])

    def test_parses_json_with_leading_prose(self):
        raw = 'Here\'s your board:\n{"categories": [{"title": "Cars", "songs": [2]}]}\nHope that helps!'
        cats, _ = parse_ai_response(raw)
        self.assertEqual(cats, [{"title": "Cars", "songs": [1]}])

    def test_parses_json_with_trailing_commas(self):
        raw = '{"categories": [{"title": "Cars", "songs": [1, 2,],},], "blocked": [],}'
        cats, blocked = parse_ai_response(raw)
        self.assertEqual(cats, [{"title": "Cars", "songs": [0, 1]}])
        self.assertEqual(blocked, [])

    def test_accepts_key_aliases(self):
        raw = '{"groups": [{"name": "Cars", "indices": [1, 2]}], "flagged": ["4"]}'
        cats, blocked = parse_ai_response(raw)
        self.assertEqual(cats, [{"title": "Cars", "songs": [0, 1]}])
        self.assertEqual(blocked, [3])

    def test_raises_on_unparseable_garbage(self):
        for raw in ("", "I'm afraid I can't do that.", "{{{", "[1, 2, 3]"):
            with self.assertRaises(AIUnavailable):
                parse_ai_response(raw)

    def test_derives_stable_ids_and_breaks_collisions(self):
        used: set[str] = set()
        first = make_category_id("80s Power Ballads", used)
        self.assertEqual(first, "cat_ai_80s_power_ballads_05b5b0")
        self.assertRegex(first, AI_ID_RE)
        self.assertEqual(make_category_id("80s Power Ballads", used), first + "_2")
        self.assertTrue(make_category_id("♪♫", set()).startswith("cat_ai_category_"))

    def test_prompt_asks_for_decade_diversity(self):
        prompt = build_ai_prompt(
            [{"title": "Song", "artist": "Artist"}], n_categories=5, min_songs=5
        )
        self.assertIn("DECADE DIVERSITY", prompt)
        self.assertIn("1960s", prompt)
        self.assertIn("1970s", prompt)


class AIFallbackTests(unittest.TestCase):
    def assert_fell_back(self, bank: dict, logs: list[str]) -> None:
        self.assertEqual([c["id"] for c in bank["categories"]], ["cat_PL0", "cat_PL1"])
        self.assertEqual([c["playlistId"] for c in bank["categories"]], ["PL0", "PL1"])
        self.assertTrue([line for line in logs if "falling back" in line], logs)

    def test_no_ai_client_gives_one_category_per_playlist(self):
        logs: list[str] = []
        bank = build_bank(simple_client(2, 8), BuildOptions(seed=1), log=logs.append)
        self.assert_fell_back(bank, logs)

    def test_an_api_error_never_escapes(self):
        logs: list[str] = []
        bank = build_bank(
            simple_client(2, 8),
            BuildOptions(seed=1),
            log=logs.append,
            ai_client=FakeAnthropic(raises=RuntimeError("boom")),
        )
        self.assert_fell_back(bank, logs)
        self.assertTrue([line for line in logs if "boom" in line], logs)

    def test_a_refusal_falls_back(self):
        logs: list[str] = []
        bank = build_bank(
            simple_client(2, 8),
            BuildOptions(seed=1),
            log=logs.append,
            ai_client=FakeAnthropic("", stop_reason="refusal"),
        )
        self.assert_fell_back(bank, logs)

    def test_a_truncated_reply_falls_back(self):
        logs: list[str] = []
        bank = build_bank(
            simple_client(2, 8),
            BuildOptions(seed=1),
            log=logs.append,
            ai_client=FakeAnthropic('{"categories": [', stop_reason="max_tokens"),
        )
        self.assert_fell_back(bank, logs)

    def test_a_reply_with_no_usable_categories_falls_back(self):
        logs: list[str] = []
        bank = build_bank(
            simple_client(2, 8),
            BuildOptions(seed=1),
            log=logs.append,
            ai_client=FakeAnthropic('{"categories": [], "blocked": []}'),
        )
        self.assert_fell_back(bank, logs)

    def test_no_ai_flag_skips_the_client_entirely(self):
        ai = FakeAnthropic(ai_reply([("Never Used", [1, 2, 3, 4, 5])]))
        logs: list[str] = []
        bank = build_bank(
            simple_client(2, 8),
            BuildOptions(seed=1, no_ai=True),
            log=logs.append,
            ai_client=ai,
        )
        self.assertEqual(ai.calls, [])
        self.assert_fell_back(bank, logs)

    def test_make_ai_client_returns_none_without_a_key(self):
        logs: list[str] = []
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(make_ai_client(logs.append))
        self.assertTrue([line for line in logs if "ANTHROPIC_API_KEY" in line], logs)


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
        bank = build_bank(simple_client(3, 8), BuildOptions(seed=3), log=quiet)
        self.assert_valid(bank)

    def test_written_file_round_trips(self):
        bank = build_bank(simple_client(2, 8), BuildOptions(seed=3), log=quiet)
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "nested" / "bank.json"
            write_bank(bank, out)
            self.assertTrue(out.exists())
            reloaded = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(reloaded, bank)
            self.assert_valid(reloaded)

    def test_an_ai_bank_validates_and_round_trips_with_null_playlist_ids(self):
        ai = FakeAnthropic(
            ai_reply([("Songs About Cars", [1, 2, 3, 4, 5]), ("Deep Cuts", [7, 8, 9, 10, 11])])
        )
        bank = build_bank(simple_client(2, 6), BuildOptions(seed=3), log=quiet, ai_client=ai)
        self.assert_valid(bank)
        self.assertTrue(all(c["playlistId"] is None for c in bank["categories"]))
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "bank.json"
            write_bank(bank, out)
            text = out.read_text(encoding="utf-8")
            self.assertIn('"playlistId": null', text)
            reloaded = json.loads(text)
            self.assertEqual(reloaded, bank)
            self.assert_valid(reloaded)


if __name__ == "__main__":
    unittest.main()
