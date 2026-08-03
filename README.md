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
- the **setlist's song data** (titles, artists, video ids) — the host's own
  socket only, and only while they're browsing. The host has to pick and play
  the songs, so they legitimately know them; nobody else may.

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

- **Setlist** — every bank category becomes a **section**, every song a row, in
  bank order (no shuffle — the host is deliberately browsing). The host's phone
  shows section headers with a remaining count, a search box that filters across
  titles and artists, and dims songs already played (`✓ played`) so nothing gets
  picked twice. Songs are deduped by video id while flattening, so a track the AI
  categoriser put in two themes only appears once.
- **Host playback** — tap a song → see its title, artist and section, plus
  **▶ Open in YouTube Music** (a native `music.youtube.com/watch?v=…` link, which
  has no embed restrictions). Play it however you like, then tap
  **🔔 Start round — arm buzzers**. Tapping a song is purely local to the host's
  browser; the server learns nothing until Start, so buzzing can never be live
  merely because a song was tapped. There is **no timer of any kind** — the host
  reveals manually when they decide the round is over.
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
  they're the facilitator and judge, not a contestant. They browse the setlist,
  arm rounds, judge answers, reveal, advance, and can end the game at any time
  with **🏁 End game & show scores** (with a 36–64-song bank, "all songs used" is
  effectively unreachable). The crown can be handed to anyone with **Make host**
  in the lobby and moves automatically if the host disconnects, preferring a
  device that can cast — but note that whoever holds it becomes a permanent
  non-player for as long as they hold it, and anyone who has ever held it has
  seen the whole setlist. Don't rotate the host mid-game unless you're happy with
  both. There's exactly one host at a time, and a game needs at least **2
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

Useful flags: `--playlists` (repeatable; a playlist id or a case-insensitive
title substring, default: all of them), `--max-categories` (8),
`--songs-per-category` (8), `--min-songs` (5), `--seed`, `--out`,
`--auth-mode {oauth,browser}`, `--auth-file`.

Songs with no `videoId`, no title or no artist are skipped, as are unavailable
tracks; a video id appearing in two playlists is kept only once, so no two
setlist rows share an answer. Playlists with too few usable songs are dropped with a
warning.

Output goes to `question-bank/bank.json` (gitignored — it's your data). The
server reads `QUESTION_BANK_PATH` and falls back to the bundled sample bank,
logging a warning, if the file is missing or invalid.

### Community playlists and AI categories

Pull songs from playlists you don't own, and let Claude invent the setlist
sections instead of using one category per playlist.

```bash
# a public playlist by id or pasted share URL (repeatable)
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py \
    --community-playlist PLxxxxxxxx
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py \
    --community-playlist "https://music.youtube.com/playlist?list=PLxxxxxxxx"

# search YT Music's community playlists and take the top match (repeatable)
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py \
    --community-search "80s power ballads"

# your library PLUS community sources, several decades, 8 AI categories
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py \
    --community-search "60s classics" --community-search "70s classic rock" \
    --categories 8 --max-categories 15
```

`--community-playlist` accepts a bare id (`PLxxxx`, `OLAK5uy_xxxx`, …) or any of
the usual URL forms: `music.youtube.com/playlist?list=…`,
`youtube.com/playlist?list=…`, `…/watch?v=…&list=…`, `youtu.be/…?list=…`, and
`music.youtube.com/browse/VLPL…`. A leading `VL` is stripped — YT Music's browse
ids are `VL` + the playlist id, and the API wants the bare id.

`--community-search` takes the **first** usable result in YT Music's own
relevance order — no extra ranking — and logs which playlist it picked (title,
author, id, item count) so you can sanity-check it. A search that finds nothing
logs a warning and the run continues with the other sources.

**Your library is always included alongside any community sources** — the two
are additive, not either/or. `--playlists` still narrows *which* of your own
playlists are used; pass `--no-library` if you want to build from community
sources only, excluding your library entirely.

**AI categories** need `ANTHROPIC_API_KEY`; the model comes from
`ANTHROPIC_MODEL` (default `claude-haiku-4-5-20251001`). It's one batch call per
run, sending only song titles and artists — never video ids — and the AI only
groups, titles and flags songs `ytmusicapi` already returned. It never invents a
song. `--categories N` (default 5) sets how many
categories to ask for; `--max-categories` still caps how many *source playlists*
are read. The prompt also asks the model to favor **decade diversity** — if
enough 1960s/1970s songs are in the pool, it's told to carve out a category for
them rather than letting everything cluster into whichever decades happen to
dominate your library — so pairing this with `--community-search "60s hits"` /
`"70s classics"` (or similar) actually surfaces that era instead of it getting
diluted into a "Classic Rock" catch-all.

**Content filtering** is two-layer. Anything YT Music flags `isExplicit` is
dropped before the AI ever sees it — that's the authoritative, non-negotiable
filter. The AI then does a second conservative pass over titles and artists, and
anything it flags is dropped too.

**Fallback**: no key, no `anthropic` package, an API error, or an unparseable
reply → the builder prints why and falls back to one category per playlist. It
never fails the run. `--no-ai` forces that path.

Both env vars are read by the **Python builder only** — the Node server has no
Anthropic dependency.

**Embeddable pre-check (legacy, off by default)**: `--youtube-api-key` runs an
optional pass that drops songs whose *embedding* is disabled by the rights
holder. It is **no longer needed** — the game plays songs through native YouTube
Music links, which have no embed restrictions at all — so it no longer defaults
to `YOUTUBE_API_KEY` and only runs when you pass the flag explicitly. The code
and its tests are kept because they're harmless and self-contained. The Node
server never reads `YOUTUBE_API_KEY`.

### Schema

```json
{
  "version": 1,
  "generatedAt": "2026-08-02T21:14:05Z",
  "source": "ytmusicapi",
  "categories": [
    {
      "id": "cat_PLxxxxxxxxxxxx",
      "title": "80s Bangers",
      "playlistId": "PLxxxxxxxxxxxx",
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

- `id`s are derived (`cat_<playlistId>`, `q_<videoId>`) so a rebuild doesn't
  churn them. An AI-generated category is `cat_ai_<slug>_<hash>` instead, from a
  slug of its title plus a short SHA-1 of it — also derived, also stable.
- `playlistId` is the single source playlist a category came from, or `null` for
  an AI-generated category (which pulls from many playlists at once).
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
time and that the host is always rejected), the flat scoring matrix, setlist
construction and `used` tracking, phase transitions, the host role and its
exclusion from buzzing (including the 2-player deadlock case where the host
drops mid-round), and the spectator-safe rule — asserted after every mutation,
so a projection that leaked a video id, a setlist title or an early answer would
fail the build. The client suite covers the buzz button, the setlist browser
(including an explicit "a non-host sees no song titles at all" test) and the
host judging panel. The Python tests mock the `YTMusic` client entirely; nothing
here touches the network.

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
