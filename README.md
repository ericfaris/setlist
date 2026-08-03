# Setlist

A real-time multiplayer party game and, deliberately, not much more than a
**scorekeeper with a fair buzz race**. The host browses a themed **setlist**
built from their own **YouTube Music playlists**, taps a song to get a native
`music.youtube.com` link, plays it out loud on their own device (phone speaker,
Bluetooth speaker, whatever), then arms the buzzers. Everyone else buzzes in on
their own phone; the **first buzz the server receives** wins — no client timing
is trusted. The host marks the answer right or wrong for the song title and the
artist, and scores update everywhere at once.

Our app never embeds or plays any media. That is the whole design: YouTube's
per-domain embed allowlist makes embedded playback unreliable for a large share
of real music content, while YouTube's own app has no such restriction. The TV
(a real Chromecast, or just a browser tab) shows the room code, join QR, live
scoreboard and buzz-lock status — and nothing else.

## Architecture

A TypeScript monorepo (npm workspaces):

| Package | What |
|---|---|
| `@setlist/shared` | Canonical game-state data model, wire protocol, spectator-safe projection types, and the question-bank schema + validator. |
| `@setlist/server` | Node + Socket.IO. Server-authoritative game engine (pure, deterministic), question-bank loader with a bundled sample fallback, room registry. |
| `@setlist/client` | React + Vite. Two builds from one codebase — the **player** UI (`index.html`) and the TV **receiver** UI (`receiver.html`). |

The server is the single source of truth. Clients send *intents*; the server
validates them against the engine and broadcasts spectator-safe projections.
Two things are never sent to a client that shouldn't see them:

- the **answer** (song title + artist) — the host's own socket only, until the
  reveal;
- the **catalog's song data** (titles, artists, video ids) — the host's own
  socket only, and only for the single song the server has put on deck. The host
  has to play it, so they legitimately know it; nobody else may. The upcoming
  song's **category name** *is* public — that is the on-deck preview, and it is
  the only song-adjacent thing the TV or a guest ever sees before the reveal.

The Chromecast receiver is a read-only WebSocket client rendering a TV view. It
plays no media and is now the **least privileged surface in the system** — its
private state is empty.

## Develop

```bash
npm install
cp .env.example .env
npm run dev            # server on :3001, client on :5173 (proxied)
```

Open <http://localhost:5173>.

Casting to a real Chromecast needs **Chrome on desktop or Android** and a
registered receiver app id in `CAST_RECEIVER_APP_ID`. You don't need either for
local play: the host screen has an **"Open TV view"** button that opens
`/receiver.html?code=NNNN` in a browser tab. That is the supported no-Chromecast
path and the way everything here is normally tested.

The app ships with a **sample question bank**, so it is fully playable with no
YouTube Music credentials at all.

## How the game works

- **Rounds** — after the lobby, play runs as **3 fixed rounds**. At the start of
  each round the host picks **5 / 4 / 3 categories** (round 1 / 2 / 3) from a
  grouped, searchable picker on their phone. The server then samples **up to 5
  not-yet-used songs** from each picked category and sequences them
  **round-robin by category** — A B C D E A B C D E … — fully automatically.
  Nobody browses a song list; there is no way for anyone to choose an individual
  song. After round 3's last song is revealed and the host advances, the game
  ends at **GAME_OVER** on its own.
- **Used songs** — a song is marked used the moment it is *drawn* into a round,
  not when it is played, so a category re-picked in a later round can never
  repeat an earlier song. Because the curated taxonomy legitimately puts one
  track in several categories (Rock **and** 90s Rock **and** 90s Grunge), the
  catalog dedupes by video id only *within* a category, and marking a song used
  marks every catalog entry sharing that video id. A category with fewer than 5
  unused songs contributes what it has left (the picker labels it `only N left`);
  one with none is shown disabled (`all played`).
- **Category preview** — before every song, the upcoming **category name** is
  shown to everyone, on the phones and on the TV ("Next up: 90s Grunge"), along
  with `Round n · song i of N`. That is the only new public information: the
  song's title, artist and video id stay host-only, exactly as before.
- **Host playback** — on the on-deck screen the host — and only the host — sees
  the song's title, artist and **▶ Open in YouTube Music** (a native
  `music.youtube.com/watch?v=…` link, which has no embed restrictions). Play it
  however you like, then tap **🔔 Start round — arm buzzers**. The server has
  already chosen the song, so the host's only decision is *when* to arm. There is
  **no timer of any kind** — the host reveals manually when they decide the round
  is over.
- **Buzz** — first message the server processes wins the lock, full stop.
  Everyone else's button shows "🔒 *name* buzzed in".
- **Scoring** — a flat **100 points** per song: correct title = **+50**, correct
  artist = **+50**, both = **+100**. Wrong on both costs **−50** (a deterrent
  against blind buzzing); that penalty is a lobby setting, `Penalise a wrong
  answer`, on by default. A wrong answer locks that player out of the current
  song and re-arms everyone else; when nobody eligible is left the answer is
  revealed automatically.
- **Host** — the first player to join a room is the host (normally whoever set
  the TV up). The host **never buzzes** — they picked and played the song, so
  they're the facilitator and judge, not a contestant. They pick each round's
  categories, arm songs, judge answers, reveal, advance, and can end the game at
  any time with **🏁 End game & show scores**. The crown can be handed to anyone
  with **Make host** in the lobby and moves automatically if the host
  disconnects, preferring a device that can cast — but note that whoever holds it
  becomes a permanent non-player for as long as they hold it, and anyone who has
  ever held it has seen the answers to the songs armed while they held it. Don't
  rotate the host mid-game unless you're happy with both. There's exactly one host at a time, and a game needs at least **2
  players**.

## Question bank

The bank is built **offline**, by hand, from your own YouTube Music playlists.
The Node server never calls Python; it just reads the JSON.

### One-time setup

```bash
/usr/bin/python3 -m venv scripts/questionbank/.venv
scripts/questionbank/.venv/bin/pip install --upgrade pip
scripts/questionbank/.venv/bin/pip install -r scripts/questionbank/requirements.txt
```

Always use the venv's interpreter explicitly (`scripts/questionbank/.venv/bin/python`,
`scripts/questionbank/.venv/bin/pip`) — never a bare `python`/`pip`.

### One-time auth (OAuth)

`ytmusicapi` needs credentials for your account. **OAuth** is the path used
here: its token refreshes and keeps working for months, whereas browser-cookie
auth expires in days and forces you to re-scrape request headers every time.

As of `ytmusicapi` ≥ 1.6 you must supply your **own** OAuth client:

1. In the [Google Cloud Console](https://console.cloud.google.com/), create (or
   pick) a project and enable the **YouTube Data API v3**.
2. Create an **OAuth client ID** of application type
   **"TVs and Limited Input devices"**.
3. Run, with that client's id and secret:

   ```bash
   scripts/questionbank/.venv/bin/ytmusicapi oauth \
       --client-id <YOUR_CLIENT_ID> \
       --client-secret <YOUR_CLIENT_SECRET> \
       --file scripts/questionbank/oauth.json
   ```

   It prints a URL and a code; approve it in a browser.

That's an interactive, browser-based step, and it is required only to build a
bank from your real account — never to run, test or develop the app.

`oauth.json` (and `browser.json`) are gitignored.

<details>
<summary>Browser-cookie auth instead</summary>

```bash
scripts/questionbank/.venv/bin/ytmusicapi browser --file scripts/questionbank/browser.json
# then pass --auth-mode browser to build_bank.py
```
Simpler to set up, but expires often.
</details>

### Build it

```bash
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py --dry-run
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py
```

This runs the default **taxonomy** mode (see below) and takes **tens of
minutes** — it prints per-category progress and an elapsed time at the end.

Songs with no `videoId`, no title or no artist are skipped, as are unavailable
tracks, and anything YT Music flags `isExplicit` is dropped outright. A video id
appearing in two playlists of the *same* category is kept once; the same track
appearing in two *different* categories is kept in both, deliberately — the
engine's per-game "used" tracking is what stops it playing twice.

Output goes to `question-bank/bank.json` (gitignored — it's your data). The
server reads `QUESTION_BANK_PATH` and falls back to the bundled sample bank,
logging a warning, if the file is missing or invalid.

### Curated category taxonomy

The builder's default mode (`--mode taxonomy`) ignores your library entirely and
builds a fixed, **config-driven** set of ~61 categories from large community
playlists. No LLM is involved: the category names and their search queries live
in editable tables at the top of `build_bank.py`.

| Group | Count | Examples |
|---|---|---|
| `genre` — Genres | 5 | Pop, Rock, Hip-Hop/Rap, R&B/Soul, Country |
| `decade_pop` / `decade_rock` / `decade_hiphop` / `decade_rnb` / `decade_country` | 37 | 80s Rock, 90s Pop, Today's Country |
| `rock_sub` — Rock sub-genres | 9 | 90s Grunge, Yacht Rock, Garage Rock |
| `era` — Hits by era | 7 | 50s & 60s Oldies, 80s Throwbacks, 2010s Chart Toppers |
| `special` — Special | 3 | Boy Bands/Girl Groups, Solo Artists, One-Hit Wonders |

Each category issues several community-playlist searches in priority order
(`"best {genre} songs"`, `"{decade} {genre} hits"`, `"{sub} songs"`,
`"{era} hits"`, …), takes the top `--per-query-results` usable hits from each
until `--max-playlists-per-category` distinct playlists are collected, fetches
**every** track of each playlist (no 200-item cap), dedupes by video id within
the category, and writes hundreds of songs per category.

```bash
# the taxonomy itself — no network at all
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py --list-categories

# one narrow category end to end (~a minute, real network)
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py \
    --category "Yacht Rock" --dry-run

# the full build (tens of minutes) — watch the per-category progress
time scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py

# a category came in thin: rebuild just that one and merge it back in
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py \
    --category "Garage Rock" --merge
```

Flags: `--mode {taxonomy,playlists}` (default `taxonomy`), `--category`
(repeatable substring filter on key or title), `--list-categories`,
`--max-playlists-per-category` (4), `--per-query-results` (2),
`--min-category-songs` (25 — thinner categories are dropped and named in the
build summary), `--max-songs-per-category` (0 = unlimited), `--sleep-ms` (250,
between playlist fetches), `--merge` (merge into an existing `--out`, replacing
same-id categories and keeping the rest).

**Adding or editing a category** is a one- or two-line edit to the tables in
`build_bank.py` — `PLAIN_GENRES`, `GENRE_DECADES`, `ROCK_SUBGENRES`,
`ERA_CATEGORIES`, `SPECIAL_CATEGORIES`. The ~61-entry `TAXONOMY` is derived from
them. A category's `key` and `group` are **identifiers** (they form its bank id);
change them and you orphan the category in any bank built earlier. `title` is
free to change. If a category searches badly, paste two playlist ids or share
URLs into its `playlist_ids` — pinned ids are consumed before any search.

The build prints a per-category table, a **dropped categories** section
explaining every category that fell below `--min-category-songs`, and the
wall-clock elapsed. Report the real counts; the builder makes no per-category
guarantee beyond that threshold.

### Legacy playlist mode

`--mode playlists` keeps the original behaviour: one bank category per source
playlist, drawn from your own library plus any community sources.

```bash
# a public playlist by id or pasted share URL (repeatable)
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py \
    --mode playlists --community-playlist PLxxxxxxxx

# search YT Music's community playlists and take the top match (repeatable)
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py \
    --mode playlists --community-search "80s power ballads"
```

Flags for this mode: `--playlists` (repeatable; a playlist id or a
case-insensitive title substring), `--community-playlist`, `--community-search`,
`--no-library`, `--max-categories` (8), `--songs-per-category` (8),
`--min-songs` (5), `--seed`.

`--community-playlist` accepts a bare id (`PLxxxx`, `OLAK5uy_xxxx`, …) or any of
the usual URL forms: `music.youtube.com/playlist?list=…`,
`youtube.com/playlist?list=…`, `…/watch?v=…&list=…`, `youtu.be/…?list=…`, and
`music.youtube.com/browse/VLPL…`. A leading `VL` is stripped — YT Music's browse
ids are `VL` + the playlist id, and the API wants the bare id.

`--community-search` takes the **first** usable result in YT Music's own
relevance order — no extra ranking — and logs which playlist it picked (title,
author, id, item count) so you can sanity-check it. A search that finds nothing
logs a warning and the run continues with the other sources.

**Your library is always included alongside any community sources** in this mode
— the two are additive, not either/or. Pass `--no-library` to build from
community sources only.

**Content filtering**: anything YT Music flags `isExplicit` is dropped, in both
modes. That is the whole filter now — there is no second AI pass, because there
is no AI. The **AI categorisation step has been removed entirely**;
`ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are no longer read by anything in this
repo.

**Embeddable pre-check (legacy, off by default)**: `--youtube-api-key` runs an
optional pass that drops songs whose *embedding* is disabled by the rights
holder. It is **no longer needed** — the game plays songs through native YouTube
Music links, which have no embed restrictions at all — so it no longer defaults
to `YOUTUBE_API_KEY` and only runs when you pass the flag explicitly. It applies
to `--mode playlists` only. The Node server never reads `YOUTUBE_API_KEY`.

### Schema

```json
{
  "version": 1,
  "generatedAt": "2026-08-02T21:14:05Z",
  "source": "ytmusicapi",
  "categories": [
    {
      "id": "cat_tax_rock_sub__90s_grunge",
      "title": "90s Grunge",
      "playlistId": null,
      "questions": [
        {
          "id": "q_dQw4w9WgXcQ",
          "title": "Never Gonna Give You Up",
          "artist": "Rick Astley",
          "videoId": "dQw4w9WgXcQ",
          "album": "Whenever You Need Somebody",
          "durationSeconds": 213,
          "value": 100,
          "startSeconds": null
        }
      ]
    }
  ]
}
```

- `id`s are derived so a rebuild doesn't churn them. A taxonomy category is
  `cat_tax_<group>__<key>` straight from its config record; legacy playlist-mode
  categories are `cat_<playlistId>`; questions are always `q_<videoId>`. The
  `<group>` half is what the host's picker groups by — any id that isn't a
  `cat_tax_*` id (a legacy bank, an old `cat_ai_*` bank, the bundled sample)
  falls into **All categories** and stays fully playable.
- `playlistId` is the single source playlist a category came from, or `null` for
  a taxonomy category (which aggregates several playlists at once).
- `value` is **ignored by the engine** — scoring is a flat 100 per song. It
  stays in the file because the builder writes it and the validator still
  requires it; the on-disk format is deliberately unchanged. Don't "fix" the
  redundancy.
- `startSeconds` and `durationSeconds` are **unused by the app** (there are no
  clips any more). The builder still writes them and the validator still accepts
  them.
- `videoId` is the field the **host** needs to build the YouTube Music link, and
  the one field never sent to another player or to the TV.

## Test

```bash
npm test    # engine unit tests + WebSocket integration + client screen tests
scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v
```

The server suite covers the buzz race (including 50 rooms × 4 simultaneous
buzzes over real sockets, asserting exactly one winner among the non-hosts each
time and that the host is always rejected), the flat scoring matrix, catalog
construction (including the per-category video-id dedupe and its counterpart,
"marking a drawn song used marks every entry with that video id"), the whole
round structure — 5/4/3 categories, 5 songs each, round-robin ordering, clamped
counts on a small bank, no cross-round repeats, automatic `GAME_OVER` after
round 3 — phase transitions, the host role and its exclusion from buzzing
(including the 2-player deadlock case where the host drops mid-round), and the
spectator-safe rule, asserted after every mutation: the whole `PublicRoom` is
stringified and checked, so a projection that leaked a video id, a song title or
an early answer would fail the build. The category *name* is public from the
on-deck preview onwards; nothing else about the song ever is. The client suite
covers the buzz button, the round-setup picker, the on-deck preview (including
explicit "a non-host sees no song data at all" tests) and the host judging
panel. The Python tests cover the taxonomy config, the full-playlist fetch, the
per-category aggregation and `--merge`, and mock the `YTMusic` client entirely;
nothing here touches the network.

## Build & run (production)

```bash
npm run build
node packages/server/dist/index.js   # serves client + Socket.IO on $PORT
```

## Deployment

Self-hosted Docker behind a Cloudflare Tunnel:

```bash
docker compose up -d --build
```

Image `ericfaris/setlist:latest`, container `setlist-app-1`, bound to
`127.0.0.1:8900`, publicly reachable at <https://setlist.mooseflip.com>. In
production `PUBLIC_BASE_URL` must point at the public hostname so the QR join
link on the TV is reachable from phones. Deploys wipe in-memory rooms — expected;
the version tag in the UI corner tells you which build is live.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP/WebSocket port. |
| `CAST_RECEIVER_APP_ID` | *(empty)* | Google Cast custom receiver app id. Empty is fine for dev — register your own in the Cast SDK Developer Console; pinpoint's cannot be reused. |
| `PUBLIC_BASE_URL` | `http://localhost:5173` | Base URL used to build the QR join link shown on the TV. |
| `QUESTION_BANK_PATH` | `question-bank/bank.json` | Bank file, relative to the repo root. Falls back to the bundled sample. |
| `YOUTUBE_API_KEY` | *(empty)* | **Builder only, optional.** Legacy embeddable pre-check, and only when `--youtube-api-key` is passed explicitly. The Node server never reads it. |
| `ANTHROPIC_API_KEY` | *(empty)* | **Unused.** The AI categorisation step was removed with the curated taxonomy. Nothing in this repo reads it; it is left in `.env`/`.env.example` only because removing it isn't worth a deploy. |
