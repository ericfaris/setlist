# Setlist

A real-time multiplayer party game: a Jeopardy-style board of **categories ×
point values**, where each category is one of your own **YouTube Music
playlists** and each square is a song from it. The board lives on a TV (a real
Chromecast, or just a browser tab), a clip plays through an embedded YouTube
player, and everyone buzzes in on their own phone. The **first buzz the server
receives** wins — no client timing is trusted. A designated host then marks the
answer right or wrong for the song title and the artist, and scores update
everywhere at once.

## Architecture

A TypeScript monorepo (npm workspaces):

| Package | What |
|---|---|
| `@setlist/shared` | Canonical game-state data model, wire protocol, spectator-safe projection types, and the question-bank schema + validator. |
| `@setlist/server` | Node + Socket.IO. Server-authoritative game engine (pure, deterministic), question-bank loader with a bundled sample fallback, room registry. |
| `@setlist/client` | React + Vite. Two builds from one codebase — the **player** UI (`index.html`) and the TV **receiver** UI (`receiver.html`). |

The server is the single source of truth. Clients send *intents*; the server
validates them against the engine and broadcasts spectator-safe projections.
Three things are never sent to a client that shouldn't see them:

- the **answer** (song title + artist) — host only, until the reveal;
- the **YouTube video id** — the TV receiver only (a player who saw it could
  simply look the song up);
- **unplayed squares' song data** — nobody, ever.

The Chromecast receiver is a read-only WebSocket client rendering a TV view.

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

In a browser tab the first clip may need one tap — the receiver shows a
**"▶ Tap to enable audio"** cover, because browsers block unmuted autoplay until
a user gesture. On a real Chromecast this generally never appears.

The app ships with a **sample question bank**, so it is fully playable with no
YouTube Music credentials at all.

## How the game works

- **Board** — 5 categories × 5 rows. Row *n* is worth `(n + 1) × 100`, i.e.
  100 / 200 / 300 / 400 / 500. Categories are the first playlists in your bank
  that have at least 5 songs; the 5 songs per column are drawn with the room's
  seeded RNG, so a rematch reshuffles. A smaller bank makes a narrower board
  rather than refusing to start.
- **Clip** — plays from `CLIP_START_SECONDS` (default 30s) for
  `CLIP_DURATION_SECONDS` (default 20s). 30 seconds is a dumb constant that lands
  in the body of most songs; starting at 0:00 usually gets you silence or an
  intro. A question may override it with its own `startSeconds` in the bank
  (hand-edited). There is no hook detection and there isn't going to be.
- **Buzz** — first message the server processes wins the lock, full stop. The
  music pauses; everyone else's button shows "🔒 *name* buzzed in".
- **Scoring** — for a square worth *V*: correct title = **+V/2**, correct artist
  = **+V/2**, so a fully correct answer is exactly *V*. Wrong on both costs
  **−V/2** (a deterrent against blind buzzing); that penalty is a lobby setting,
  `Penalise a wrong answer`, on by default. A wrong answer locks that player out
  of the current question and re-arms everyone else — the clip resumes. When
  everybody has missed, or the clip runs out, the answer is revealed.
- **Host** — the first player to join a room is the host (normally whoever set
  the TV up). The host picks squares, judges answers, skips, replays and
  advances. The crown can be handed to anyone with **Make host** in the lobby,
  and moves automatically if the host disconnects — preferring a device that can
  cast. There's exactly one host at a time.

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
squares share an answer. Playlists with too few usable songs are dropped with a
warning.

Output goes to `question-bank/bank.json` (gitignored — it's your data). The
server reads `QUESTION_BANK_PATH` and falls back to the bundled sample bank,
logging a warning, if the file is missing or invalid.

### Community playlists and AI categories

Pull songs from playlists you don't own, and let Claude invent the board
categories instead of using one category per playlist.

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
song. `--categories N` (default 5, matching the board's 5 columns) sets how many
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

**Embeddable pre-check**: some official/label-uploaded videos have embedding
disabled by the rights holder — they can't play in *any* embedded player,
anywhere, on any site (not a bug, a per-video YouTube setting). Set
`YOUTUBE_API_KEY` (a plain Google/YouTube Data API v3 key, separate from the
`ytmusicapi` OAuth/browser auth above) and the builder checks every pooled
song's real embeddable status before it ever reaches the board, dropping any
that would fail. `YOUTUBE_API_KEY` is read by both the builder and the Node
server (see below) — it is not builder-only. Without the key this step is
skipped and a bad video instead surfaces as an in-game "Embedding disabled"
error the host can Skip past.

**Runtime song substitution**: the `status.embeddable` flag cannot see
per-domain embed allowlists, so some videos still fail live with error 101/150.
When that happens the Node server (which now also reads `YOUTUBE_API_KEY`)
searches the YouTube Data API v3 for an alternate upload of the same song,
verifies the title/artist plausibly match, and plays it — up to 3 attempts, with
a "finding another version…" indicator and buzzers disabled throughout. If all
three also fail, the question auto-skips (reveals) with no host action needed —
there's nothing left to usefully Skip past. If `YOUTUBE_API_KEY` is unset,
substitution never kicks in and a failure falls straight to the host's manual
Skip, exactly as before this feature existed. Costs 100 quota units per failed
song against the 10,000/day default.

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
- `value` is a **suggestion**. The engine assigns the authoritative value from
  the board row when it lays the game out — don't "fix" the redundancy.
- `startSeconds: null` means "use `CLIP_START_SECONDS`". Hand-editable per song.
- `durationSeconds` may be `null`; it is only used to clamp the clip offset so a
  short track doesn't start past its own end.
- `videoId` is the only field the receiver needs, and the one field never sent
  to a player.

## Test

```bash
npm test    # engine unit tests + WebSocket integration + client screen tests
scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v
```

The server suite covers the buzz race (including 50 rooms × 4 simultaneous
buzzes over real sockets, asserting exactly one winner each), the scoring
matrix at every point value, board layout, phase transitions, the host role,
and the spectator-safe rule — asserted after every mutation, so a projection
that leaked a video id or an early answer would fail the build. The Python
tests mock the `YTMusic` client entirely; nothing here touches the network.

## Build & run (production)

```bash
npm run build
node packages/server/dist/index.js   # serves client + Socket.IO on $PORT
```

## Deployment

Not set up yet. It will follow the sibling `pinpoint` project's pattern —
self-hosted Docker container behind a Cloudflare Tunnel, configured from a local
`.env` — as a separate, later step. In production `PUBLIC_BASE_URL` must point
at the public hostname so the QR join link on the TV is reachable from phones.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP/WebSocket port. |
| `CAST_RECEIVER_APP_ID` | *(empty)* | Google Cast custom receiver app id. Empty is fine for dev — register your own in the Cast SDK Developer Console; pinpoint's cannot be reused. |
| `PUBLIC_BASE_URL` | `http://localhost:5173` | Base URL used to build the QR join link shown on the TV. |
| `QUESTION_BANK_PATH` | `question-bank/bank.json` | Bank file, relative to the repo root. Falls back to the bundled sample. |
| `CLIP_START_SECONDS` | `30` | Where each clip starts. |
| `CLIP_DURATION_SECONDS` | `20` | How long each clip plays. |
