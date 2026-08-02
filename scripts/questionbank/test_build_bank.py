"""Unit tests for build_bank.py. Pure stdlib, no network, no ytmusicapi.

The YTMusic client is injected into build_bank(), so these tests pass a fake
object returning canned responses. Run them with the venv's interpreter:

    scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from build_bank import (
    POINT_VALUES,
    BuildError,
    BuildOptions,
    build_bank,
    usable_track,
    write_bank,
)


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
    """Stands in for ytmusicapi.YTMusic — no network."""

    def __init__(self, playlists: list[dict], tracks_by_id: dict[str, list[Any]]):
        self._playlists = playlists
        self._tracks = tracks_by_id
        self.calls: list[str] = []

    def get_library_playlists(self, limit: int = 25) -> list[dict]:
        self.calls.append(f"library:{limit}")
        return self._playlists

    def get_playlist(self, playlist_id: str, limit: int = 100) -> dict:
        self.calls.append(f"playlist:{playlist_id}")
        return {"id": playlist_id, "tracks": self._tracks.get(playlist_id, [])}


def simple_client(n_playlists: int = 2, per_playlist: int = 8) -> FakeYTMusic:
    playlists = [
        {"playlistId": f"PL{i}", "title": f"Playlist {i}"} for i in range(n_playlists)
    ]
    tracks = {
        f"PL{i}": [track(f"vid{i}_{j}", title=f"Song {i}-{j}") for j in range(per_playlist)]
        for i in range(n_playlists)
    }
    return FakeYTMusic(playlists, tracks)


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


class SchemaTests(unittest.TestCase):
    """Mirrors the field checks validateQuestionBank() performs in TypeScript."""

    def assert_valid(self, bank: dict) -> None:
        self.assertEqual(bank["version"], 1)
        self.assertIn(bank["source"], ("ytmusicapi", "fixture"))
        self.assertTrue(bank["generatedAt"])
        self.assertGreater(len(bank["categories"]), 0)
        for cat in bank["categories"]:
            for field in ("id", "title", "playlistId"):
                self.assertIsInstance(cat[field], str)
                self.assertTrue(cat[field].strip())
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


if __name__ == "__main__":
    unittest.main()
