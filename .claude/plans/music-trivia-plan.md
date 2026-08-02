# Music Trivia — Implementation Plan

> **Executor note:** You have this file and the repo at `/home/eric/projects/music-trivia`.
> The reference project `/home/eric/projects/pinpoint` **exists on this machine and is readable** —
> this plan cites exact paths in it. When a step says "port from pinpoint", open that file and read
> it before writing the equivalent here. Do not guess at pinpoint's contents; every path below is real.
>
> Concept brief: `/home/eric/projects/music-trivia/.claude/plans/music-trivia-brief.md` (read it too).

---

## 1. Summary

Build **Music Trivia**: a self-hosted, real-time multiplayer party game where a group plays
Jeopardy-style music trivia in one room. A TV (a real Chromecast, or a browser tab as a local
fallback) shows a board of **categories × point values**, where each category is one of the user's
own **YouTube Music playlists** and each cell is a song from it. Selecting a cell plays a clip of
the song through an embedded **YouTube IFrame player** on the TV. Every player has their phone open
to a big **buzz button**; the **first buzz the server receives** wins the lock (server-authoritative
race — no client timestamps trusted). A designated **host** phone then marks the answer
correct/incorrect for song title and artist, and scores update live on every screen. The question
bank is produced **offline** by a standalone Python script using `ytmusicapi` against the user's
real YT Music account, emitting a JSON file the Node server reads at startup; a committed **sample
bank fixture** makes the whole app runnable and testable with zero YT Music credentials. The
architecture is a deliberate re-use of the sibling project **pinpoint** — same npm-workspaces
monorepo shape, same Socket.IO server-authoritative engine + spectator-safe projection discipline,
same Chromecast sender/receiver handshake — so the two projects stay operationally identical.

---

## 2. Approach & key decisions

### 2.1 Architecture: clone pinpoint's shape, not just its spirit

Three workspaces, mirroring `/home/eric/projects/pinpoint/package.json`:

| Package | Contents |
|---|---|
| `@music-trivia/shared` | Canonical game-state types, wire protocol, spectator-safe projection types, question-bank types. |
| `@music-trivia/server` | Node + Express + Socket.IO. Pure deterministic game engine, question-bank loader, room registry. |
| `@music-trivia/client` | React + Vite. Two builds from one codebase: **player** (`index.html`) and **TV receiver** (`receiver.html`). |

Same discipline as pinpoint: **clients send intents; the server validates them against the engine
and broadcasts projections.** The engine (`packages/server/src/engine/engine.ts`) is pure and
deterministic given `{ rng, questionBank, now }` — all timers/sockets live outside it in
`packages/server/src/net/`. This is what makes the engine unit-testable, which acceptance criterion
#8 requires.

*Rejected:* a single-package app or a Next.js/tRPC stack. The whole point of the brief is
operational symmetry with pinpoint (same deploy story, same mental model, same Docker/Cloudflare
Tunnel path later).

### 2.2 Decision — ytmusicapi auth: **OAuth**, with browser-cookie documented as fallback

**Decision: OAuth is the primary and documented path.** `ytmusicapi`'s OAuth flow stores a
refreshable token in `oauth.json`, which keeps working for months; browser-cookie auth
(`browser.json`, copied from request headers in devtools) expires in days-to-weeks and forces the
user to re-scrape headers every time they want to rebuild the bank. Since the bank rebuild is an
occasional manual chore, the durable option wins.

**Important caveat the executor must document, not solve:** as of `ytmusicapi` ≥ 1.6, the OAuth
flow requires the user to create their **own** OAuth client in Google Cloud Console of type
**"TVs and Limited Input devices"**, and pass its client id/secret to `ytmusicapi oauth`. This is an
interactive, browser-based, one-time step **only the user can perform**. The plan must:

- Never block scaffolding, `npm run dev`, or tests on it.
- Ship `ytmusicapi setup` instructions in the README + a clear error message from the script when
  `oauth.json` is missing.
- Provide `--auth-file` / `--auth-mode {oauth,browser}` flags on the builder script so a user who
  prefers the quick-and-dirty browser-header path can use `browser.json` instead without editing code.

Auth files live at `scripts/questionbank/oauth.json` / `browser.json` and are **gitignored**.

### 2.3 Decision — clip playback strategy: **fixed offset, fixed duration, configurable, no intelligence**

**Default: start at 30 s into the track, play for 20 s** (`CLIP_START_SECONDS=30`,
`CLIP_DURATION_SECONDS=20` in `.env`). Rationale: starting at 0:00 frequently yields silence,
spoken intros, or a long instrumental build that makes the question unfairly hard; 30 s is a dumb
constant that lands in the body of most pop songs. It is explicitly **not** hook detection — no
analysis, no per-genre tuning (out of scope).

Precedence, resolved on the server and sent to the receiver only:
1. `question.startSeconds` if present in the bank (the builder leaves it `null`; a user may hand-edit).
2. Otherwise `CLIP_START_SECONDS`, clamped to `max(0, durationSeconds - clipDuration - 5)` when the
   bank knows the track duration, so short tracks don't start past the end.

The receiver stops playback when `CLIP_DURATION_SECONDS` elapses, or immediately when a buzz locks
the question (buzz pauses the music — that's the Jeopardy feel), and can resume/replay on host
command.

*Rejected:* Cast Default Media Receiver with a direct audio URL — there is no ToS-safe stream URL
for YT content (already settled in the brief).

### 2.4 Decision — point values: **classic Jeopardy ladder, 100–500, 5 rows × 5 categories**

Board is **5 categories × 5 rows**; row *n* (0-indexed) is worth `(n + 1) * 100`, i.e.
100/200/300/400/500. Constants live in `packages/shared/src/types.ts`:

```ts
export const BOARD_ROWS = 5;
export const BOARD_COLUMNS = 5;
export const POINT_VALUES = [100, 200, 300, 400, 500] as const;
```

- The engine selects the first `BOARD_COLUMNS` categories from the bank that have at least
  `BOARD_ROWS` questions, and picks `BOARD_ROWS` questions per category using the room's seeded RNG
  (so a rematch reshuffles). Cell value comes from the **row index**, not from the bank — the bank's
  per-question `value` field is a *suggestion* the engine overwrites when it lays out the board
  (documented in the schema).
- Scoring per question of value `V`: **title correct = +V/2, artist correct = +V/2** (so a fully
  correct answer is worth exactly `V`). If the host marks **both wrong**, the buzzer loses `V/2`
  (deterrent against blind buzzing). The penalty is a room setting, `penalizeWrongAnswers`,
  default `true`, so it can be switched off for a friendly game.
- If the bank has fewer than 5 qualifying categories the engine builds a smaller board (down to
  1×`BOARD_ROWS`) rather than refusing to start — important, because a user's first real bank may be
  small. If it has more, extras are ignored in v1.

### 2.5 Decision — the host role: **adapt pinpoint's existing precedent**

Pinpoint **does** have a host precedent — do not invent one. See
`/home/eric/projects/pinpoint/packages/server/src/engine/engine.ts`:

- `join()` (~line 163): `const noHostYet = !this.host();` … `isHost: noHostYet` — **the first player
  to join a room becomes host.**
- `private host()` / `private isHost(id)` (~lines 110–115) — every privileged op begins with
  `if (!this.isHost(hostId)) return err('Only the host can …')`.
- `transferHost(old)` (~line 675) — on disconnect the role moves to another connected player,
  **preferring one whose device reported Cast Sender support** (`canHostCast`).
- Invariant asserted in tests: exactly one host while the room is non-empty
  (`packages/server/src/engine/__tests__/harness.ts`, `checkInvariants`).

**Adopt all of that verbatim**, then extend it for this game's needs:

1. Host is the player who created the room / joined first (typically whoever cast to the TV).
2. Host powers here: `board:select` (pick a cell), `judge:answer` (mark title/artist correct),
   `question:skip`, `playback:replay`, `game:start`, `game:rematch`, `host:transfer`.
3. **New intent `host:transfer { playerId }`** — the current host can hand the crown to any
   connected player. Pinpoint has no explicit transfer intent (only automatic transfer on
   disconnect); add one because in this game the host is doing continuous judging work and may want
   to hand it off. Server-side rule: only the current host may call it; target must be connected.
4. Host identity is surfaced as `PublicPlayer.isHost` (public — everyone should see who judges) and
   `PrivateState.isHost` (drives whether the phone renders host controls).

*Rejected:* a separate non-playing "host device" that doesn't join as a player — more join flow, more
edge cases, and pinpoint's host plays too. *Rejected:* a host password/PIN — nothing here is worth
protecting in a living-room LAN game.

### 2.6 Spectator-safe discipline (what is hidden from whom)

Music trivia has less hidden state than pinpoint but it is not zero. Three secrets:

| Secret | Who may see it | Mechanism |
|---|---|---|
| The **answer** (song title + artist) of the active question | Host only, until reveal; everyone after reveal | `PrivateState.hostAnswer` (host socket only); `PublicActiveQuestion.answer` is `null` until `revealed === true` |
| The **YouTube video id** of the active question | The TV receiver only (a player who saw it could look it up) | `PrivateState.receiverPlayback` — populated only for sockets flagged `isReceiver` |
| Unplayed cells' song data | Nobody until selected | Public board cells carry only `{ categoryIndex, rowIndex, value, used }` |

This forces one signature change vs pinpoint: `toPrivateState(engine, playerId)` becomes
`toPrivateState(engine, playerId, opts: { isReceiver?: boolean })`. Pinpoint calls it with `null`
for receivers (`packages/server/src/net/server.ts` line ~53); here the receiver needs a real
payload, so pass the flag.

**A leak-check must be asserted in the engine test harness after every mutation**, exactly the way
pinpoint's `checkInvariants` asserts facedown clues are never projected.

### 2.7 Game state machine

```
LOBBY ──game:start──▶ BOARD ──board:select──▶ PLAYING ──(first buzz)──▶ LOCKED
                        ▲                        │                        │
                        │                        │ clip ends, no buzz     │ judge:answer
                        │                        ▼                        ▼
                        └──────────────── REVEAL ◀───────────────────────┘
                                            │ (host: next)
                                            ▼
                        all cells used ─▶ GAME_OVER
```

- `PLAYING` — clip is playing on the TV, all buzzers armed.
- `LOCKED` — `lockedPlayerId` set, music paused, only the host can act. Everyone else's buzz button
  shows "🔒 <name> buzzed in".
- On **incorrect** judgement: the buzzer is added to `lockedOutPlayerIds` for this question, and the
  room **returns to `PLAYING`** with the remaining players re-armed (music resumes). When every
  connected player is locked out, or the host skips, go to `REVEAL`.
- `REVEAL` — answer shown on TV and all phones; host taps "Next" → `BOARD`.
- `GAME_OVER` when all board cells are `used`. Winner = highest score (ties allowed, `winnerPlayerIds: string[]`).

### 2.8 Buzz race correctness

Node is single-threaded, so "first message the server processes wins" is naturally atomic — but be
deliberate about it:

- The engine method `buzz(playerId)` is the **only** place that can set `lockedPlayerId`, and its
  first statement is a guard: `if (q.lockedPlayerId !== null) return err('Already locked in.')`.
- It also rejects when `phase !== 'PLAYING'`, when the player is in `lockedOutPlayerIds`, and when
  the player is `pendingJoin` or disconnected.
- The server **stamps `lockedAt = now()` itself**; no client-supplied timestamp appears anywhere in
  the protocol. Do not add one "for latency compensation" — the brief explicitly forbids trusting
  client timing.
- The losing buzzers get `ack({ ok: false, error: 'Already locked in.' })`, and the broadcast
  projection immediately shows the lock, so their UI flips to locked regardless of ack ordering.
- Test this with N concurrent `socket.emit('buzz:press')` calls in the net integration test and
  assert exactly one `ok: true`.

### 2.9 Chromecast: port pinpoint's handshake unchanged, only the namespace changes

Port `/home/eric/projects/pinpoint/packages/client/src/common/cast.ts` essentially verbatim. The
**only** required edits:

- `CAST_NAMESPACE` → `'urn:x-cast:com.mooseflip.musictrivia'` (must match the receiver page's `NS`).
- Nothing else — keep `isCastSupported()`, the lazy `loadSenderSdk()` with the 8 s timeout, the
  `SESSION_STATE_CHANGED` listener, and critically the **`sendCode` retry ladder**
  (`sendCode(); [500, 1500, 3000, 6000].forEach(ms => setTimeout(sendCode, ms))` plus the
  `type: 'ready'` message listener). That retry logic exists because the receiver often isn't
  listening when the first message goes out; it is load-bearing, not defensive noise.

Also port the **three redundant code-delivery paths** pinpoint uses, because any one of them can fail:
1. Cast custom message (`receiver.html` inline script → `window.__castPendingCode` / `window.__castOnCode`).
2. Server push: `receiver:standby` → server replies `cast:roomCode` (see
   `packages/server/src/net/server.ts` `standbyReceivers` + `rooms.setPendingCastCode`).
3. HTTP polling of `/api/cast-room` every 2 s from an inline script in `receiver.html`, which
   redirects to `?code=…`; cancelled via `window.__castPollTimer` as soon as a subscribe succeeds
   (see `packages/client/src/common/store.ts` `receiverSubscribe`).

Plus the **local fallback**: the host screen's "Open TV view (code NNNN)" button
(`packages/client/src/player/App.tsx` `openLocalTv`) opens `/receiver.html?code=NNNN` in a tab. This
is how all local dev and all acceptance testing happens — **no Chromecast is needed to satisfy any
acceptance criterion.**

`CAST_RECEIVER_APP_ID` stays an empty env var the user fills in later after registering a new
receiver app in the Cast SDK Developer Console (a manual browser step; pinpoint's id cannot be
reused).

### 2.10 Question bank: offline Python producer, Node consumer, committed fixture

- `scripts/questionbank/build_bank.py` (Python 3.12, own venv) reads playlists via `ytmusicapi`
  and writes `question-bank/bank.json`.
- The repo's existing `.gitignore` already contains `question-bank/*.json` and
  `!question-bank/.gitkeep` — that directory is the intended output location; create it with a
  `.gitkeep`.
- The server loads `QUESTION_BANK_PATH` (default `question-bank/bank.json`); if absent or invalid it
  **falls back to the committed sample fixture** at
  `packages/server/src/questions/sample-bank.json` and logs a warning — precisely the shape of
  pinpoint's "no `ANTHROPIC_API_KEY` → use bundled seed cards" fallback
  (`packages/server/src/index.ts` line ~31). This is what makes acceptance criterion #1 achievable
  with no credentials.

---

## 3. Step-by-step tasks

Each step is independently verifiable. Commit after each if you like (local only — **no remote,
never push**; the repo has no remote configured).

### Step 1 — Root scaffold

Create:

- `package.json` (root) — mirror `/home/eric/projects/pinpoint/package.json` exactly in structure:
  ```json
  {
    "name": "music-trivia",
    "private": true,
    "version": "0.1.0",
    "description": "Real-time multiplayer music trivia — Jeopardy-style, cast to your TV",
    "workspaces": ["packages/shared", "packages/server", "packages/client"],
    "scripts": {
      "build": "npm run build -w @music-trivia/shared && npm run build -w @music-trivia/client && npm run build -w @music-trivia/server",
      "dev": "concurrently -n server,client -c blue,green \"npm:dev:server\" \"npm:dev:client\"",
      "dev:server": "npm run dev -w @music-trivia/server",
      "dev:client": "npm run dev -w @music-trivia/client",
      "typecheck": "npm run typecheck --workspaces --if-present",
      "test": "npm run test --workspaces --if-present"
    },
    "devDependencies": { "concurrently": "^9.1.0", "typescript": "^5.7.2" }
  }
  ```
  (Build order matters: `shared` first — server and client both import its `dist`/source.)
- `.env.example` — pinpoint's minus the Anthropic vars, plus this app's:
  ```
  # Copy to .env and fill in. .env is gitignored.
  PORT=3001
  CAST_RECEIVER_APP_ID=
  PUBLIC_BASE_URL=http://localhost:5173
  QUESTION_BANK_PATH=question-bank/bank.json
  CLIP_START_SECONDS=30
  CLIP_DURATION_SECONDS=20
  ```
- Append to the **existing** `.gitignore` (do not rewrite it; it already has `node_modules/`,
  `dist/`, `.env`, `*.log`, `.DS_Store`, `question-bank/*.json`, `!question-bank/.gitkeep`):
  ```
  .venv/
  __pycache__/
  scripts/questionbank/oauth.json
  scripts/questionbank/browser.json
  coverage/
  ```
- `question-bank/.gitkeep` (empty file).

**Verify:** `npm install` from the repo root succeeds (it will be a near-noop until Step 2).

### Step 2 — `@music-trivia/shared` package skeleton

Create `packages/shared/package.json` and `packages/shared/tsconfig.json` by copying pinpoint's
(`/home/eric/projects/pinpoint/packages/shared/{package.json,tsconfig.json}`) and renaming the
package to `@music-trivia/shared`, version `0.1.0`. Keep `"type": "module"`, `main`/`types` pointing
at `./dist`, the `exports` map, and the `build`/`typecheck` scripts.

Create `packages/shared/src/index.ts`:
```ts
export * from './types.js';
export * from './questions.js';
export * from './projection.js';
export * from './protocol.js';
```

**Verify:** `npm run typecheck -w @music-trivia/shared` passes (trivially, once Step 3 lands).

### Step 3 — Shared types: question bank + game state (`packages/shared/src/questions.ts`, `types.ts`)

`packages/shared/src/questions.ts` — the on-disk bank contract (also §4.1 below):

```ts
export interface BankQuestion {
  id: string;              // stable, e.g. "q_<videoId>"
  title: string;           // song title (an answer — never broadcast pre-reveal)
  artist: string;          // primary artist string (an answer)
  videoId: string;         // YouTube video id (receiver-only)
  album: string | null;
  durationSeconds: number | null;
  /** Suggested board value; the engine overrides with the row's ladder value. */
  value: number;
  /** Optional hand-tuned clip start; null = use CLIP_START_SECONDS. */
  startSeconds: number | null;
}
export interface BankCategory {
  id: string;              // "cat_<playlistId>"
  title: string;           // playlist name → board column header
  playlistId: string;
  questions: BankQuestion[];
}
export interface QuestionBank {
  version: 1;
  generatedAt: string;     // ISO 8601
  source: 'ytmusicapi' | 'fixture';
  categories: BankCategory[];
}
```
Also export a runtime validator `validateQuestionBank(x: unknown): { ok: true; bank: QuestionBank } | { ok: false; error: string }` — hand-written checks, no new dependency. It must reject: wrong
`version`, empty `categories`, a category with 0 questions, a question missing `videoId`/`title`/`artist`.

`packages/shared/src/types.ts` — canonical server-side model, in pinpoint's house style (heavy
comments explaining *why* a field exists):

```ts
export type RoomPhase = 'LOBBY' | 'BOARD' | 'PLAYING' | 'LOCKED' | 'REVEAL' | 'GAME_OVER' | 'PAUSED';

export interface Player {
  id: string;
  reconnectToken: string;   // secret; how a returning player reclaims their seat
  displayName: string;      // unique in room, case-insensitive
  connected: boolean;
  isHost: boolean;          // exactly one at a time; transferable (see engine.transferHost)
  canHostCast: boolean;     // device reported Cast Sender support (Chrome)
  score: number;            // may go negative if penalizeWrongAnswers
  joinOrder: number;
  pendingJoin: boolean;     // joined mid-game; plays from the next question on
}

export interface BoardCell {
  categoryIndex: number;
  rowIndex: number;
  value: number;            // POINT_VALUES[rowIndex]
  questionId: string;       // index into the room's laid-out question set
  used: boolean;
}
export interface BoardCategory { id: string; title: string; }
export interface BoardState { categories: BoardCategory[]; cells: BoardCell[]; }

export type JudgeVerdict = { titleCorrect: boolean; artistCorrect: boolean };

export interface ActiveQuestion {
  cell: BoardCell;
  question: BankQuestion;        // SERVER-ONLY in full; projected selectively
  startedAt: number;             // ms epoch when PLAYING began
  startSeconds: number;          // resolved clip offset
  durationSeconds: number;       // resolved clip length
  lockedPlayerId: string | null; // the buzz winner
  lockedAt: number | null;       // SERVER timestamp; never client-supplied
  lockedOutPlayerIds: string[];  // already guessed wrong on this question
  verdict: JudgeVerdict | null;
  awarded: number;               // points delta applied (may be negative)
  revealed: boolean;
  playbackError: string | null;  // receiver reported the video won't embed/play
}

export interface RoomSettings { penalizeWrongAnswers: boolean; }

export interface GameRoom {
  code: string;                  // 4-digit join code
  phase: RoomPhase;
  settings: RoomSettings;
  players: Player[];
  board: BoardState | null;      // null in LOBBY
  active: ActiveQuestion | null;
  winnerPlayerIds: string[];
  castConnected: boolean;
  createdAt: number;
  phaseBeforePause: RoomPhase | null;
  pause: { active: boolean; reason: 'PLAYER_DISCONNECT' | 'CAST_DROPPED' | null; waitingForPlayerId: string | null };
}

export const BOARD_ROWS = 5;
export const BOARD_COLUMNS = 5;
export const POINT_VALUES = [100, 200, 300, 400, 500] as const;
export const MIN_PLAYERS = 1;   // solo play is fine for dev; the game doesn't need a minimum
export const MAX_PLAYERS = 10;
export const DEFAULT_CLIP_START_SECONDS = 30;
export const DEFAULT_CLIP_DURATION_SECONDS = 20;
```

**Verify:** `npm run typecheck -w @music-trivia/shared`.

### Step 4 — Shared projections + protocol (`projection.ts`, `protocol.ts`)

`packages/shared/src/projection.ts` — model on
`/home/eric/projects/pinpoint/packages/shared/src/projection.ts`, including its header comment
explaining the two surfaces.

```ts
export interface PublicPlayer {
  id: string; displayName: string; connected: boolean; isHost: boolean;
  canHostCast: boolean; score: number; joinOrder: number; pendingJoin: boolean;
}
/** Answer text — present ONLY once revealed. Never leak title/artist early. */
export interface PublicAnswer { title: string; artist: string; }
export interface PublicActiveQuestion {
  cell: BoardCell;
  categoryTitle: string;
  value: number;
  startedAt: number;
  durationSeconds: number;
  lockedPlayerId: string | null;
  lockedOutPlayerIds: string[];
  verdict: JudgeVerdict | null;
  awarded: number;
  revealed: boolean;
  answer: PublicAnswer | null;   // null until revealed === true
  playbackError: string | null;
  // NOTE: videoId deliberately absent — see PrivateState.receiverPlayback.
}
export interface PublicRoom {
  code: string; phase: RoomPhase; settings: RoomSettings;
  players: PublicPlayer[];
  board: BoardState | null;      // cells carry no song data, only value/used
  active: PublicActiveQuestion | null;
  winnerPlayerIds: string[];
  castConnected: boolean;
  serverNow: number;             // so clients can reconcile clip countdowns
}
/** What the TV receiver alone needs to actually play audio. */
export interface ReceiverPlayback {
  videoId: string; startSeconds: number; durationSeconds: number;
  /** bumped every time playback should (re)start — receiver watches this */
  playToken: number;
  paused: boolean;
}
export interface PrivateState {
  playerId: string | null;
  reconnectToken: string | null;
  isHost: boolean;
  score: number;
  /** true if this socket may buzz right now (armed, not locked out, not the locker) */
  canBuzz: boolean;
  /** Host-only: the answer to judge against, before the reveal. */
  hostAnswer: PublicAnswer | null;
  /** Receiver-only: what to play. Null for player sockets, always. */
  receiverPlayback: ReceiverPlayback | null;
}
```

`packages/shared/src/protocol.ts` — see §4.2 for the full event table. Keep pinpoint's
`export type Ack<T> = { ok: true; data: T } | { ok: false; error: string };` and
`export const SOCKET_PATH = '/socket';` verbatim.

**Verify:** `npm run typecheck -w @music-trivia/shared`; `npm run build -w @music-trivia/shared`
emits `dist/`.

### Step 5 — `@music-trivia/server` skeleton + env + question-bank loader

- `packages/server/package.json` — copy pinpoint's, drop `@anthropic-ai/sdk`, rename to
  `@music-trivia/server`, dep `"@music-trivia/shared": "*"`. Keep `express`, `socket.io`, `dotenv`,
  and devDeps `tsx`, `vitest`, `socket.io-client`, `@types/node`, `@types/express`, `typescript`.
  Scripts identical to pinpoint's (`build`, `typecheck`, `dev: tsx watch src/index.ts`, `start`,
  `test: vitest run`, `test:watch`).
- `packages/server/tsconfig.json` and `packages/server/vitest.config.ts` — copy pinpoint's,
  swapping the alias to `'@music-trivia/shared' → ../shared/src/index.ts`. Keep
  `noUncheckedIndexedAccess: true` and the `__tests__` exclude.
- `packages/server/src/env.ts` — copy
  `/home/eric/projects/pinpoint/packages/server/src/env.ts` **verbatim** (`rootEnvPath()`,
  `loadRootEnv()`, `readAppVersion()`). Its 3-levels-up path resolution is exactly right here too
  and its comment explains why `process.cwd()` won't do.
- `packages/server/src/questions/bank.ts` — `loadQuestionBank(path?: string): QuestionBank`:
  read `QUESTION_BANK_PATH` (relative paths resolved against the repo root, same trick as
  `rootEnvPath()`), `JSON.parse`, run `validateQuestionBank`. On any failure log
  `[startup] question bank …; falling back to bundled sample bank.` and return the fixture.
- `packages/server/src/questions/sample-bank.json` — the committed fixture (see Step 6).
- `packages/server/src/engine/rng.ts` — copy pinpoint's seedable RNG verbatim
  (`/home/eric/projects/pinpoint/packages/server/src/engine/rng.ts`); deterministic tests need it.

**Verify:** `npm run typecheck -w @music-trivia/server`.

### Step 6 — Sample question-bank fixture

`packages/server/src/questions/sample-bank.json`: **6 categories × 6 questions** (one more than the
board needs in each dimension, so the engine's selection logic is actually exercised), `source:
"fixture"`. Use well-known, long-lived, embeddable music videos so criterion #5 can be demonstrated
by ear. Suggested category titles: `80s Bangers`, `90s Alt`, `One-Hit Wonders`, `Motown`,
`Yacht Rock`, `Pop Punk`.

Requirements for each entry: real 11-char `videoId`, correct `title`/`artist`, `album: null`,
plausible `durationSeconds`, `value` matching the ladder, `startSeconds: null`.

> The executor should sanity-check a couple of the chosen video ids resolve (open
> `https://www.youtube.com/watch?v=<id>`); if any is unavailable in this environment, pick another
> obviously-canonical track. It is acceptable for a fixture id to be stale — the app must degrade to
> a visible `playbackError` on the receiver rather than hanging (see Step 11).

**Verify:** a tiny test `packages/server/src/questions/__tests__/bank.test.ts` asserting the fixture
passes `validateQuestionBank` and has ≥ `BOARD_COLUMNS` categories with ≥ `BOARD_ROWS` questions.

### Step 7 — The game engine (`packages/server/src/engine/engine.ts`)

Pure, deterministic, no I/O. Study
`/home/eric/projects/pinpoint/packages/server/src/engine/engine.ts` first for the house style:
`EngineResult = { ok: true } | { ok: false; error: string }`, private `player()/host()/isHost()`
helpers, `deps: { rng?, now?, … }` with injectable clock.

```ts
export interface EngineDeps { rng?: Rng; bank: QuestionBank; now?: () => number;
  clipStartSeconds?: number; clipDurationSeconds?: number; }

export class GameEngine {
  readonly room: GameRoom;
  constructor(code: string, deps: EngineDeps)

  // membership (port pinpoint's join/reconnect/host semantics)
  join(input: { displayName: string; reconnectToken?: string; canCast?: boolean }): JoinResult
  disconnect(playerId: string): EngineResult
  removePlayer(playerId: string): EngineResult
  transferHost(hostId: string, targetPlayerId: string): EngineResult   // NEW vs pinpoint
  setCastConnected(connected: boolean): void

  // game flow (all host-gated except buzz)
  start(hostId: string): EngineResult                       // LOBBY -> BOARD, lays out the board
  selectCell(hostId: string, categoryIndex: number, rowIndex: number): EngineResult  // -> PLAYING
  buzz(playerId: string): EngineResult                      // PLAYING -> LOCKED (the race)
  judge(hostId: string, verdict: JudgeVerdict): EngineResult // LOCKED -> PLAYING (wrong) | REVEAL (right)
  skipQuestion(hostId: string): EngineResult                // -> REVEAL, no points
  clipExpired(): EngineResult                               // PLAYING (nobody buzzed) -> REVEAL
  nextQuestion(hostId: string): EngineResult                // REVEAL -> BOARD | GAME_OVER
  replayClip(hostId: string): EngineResult                  // bump playToken
  reportPlaybackError(message: string): EngineResult        // from the receiver
  rematch(hostId: string): EngineResult                     // GAME_OVER -> LOBBY, fresh board
  forceEnd(hostId: string): EngineResult

  // introspection for projectors
  activeQuestion(): ActiveQuestion | null
  canBuzz(playerId: string): boolean
}
```

Rules to implement precisely:

- **`start`**: requires host, `phase === 'LOBBY'`, ≥1 connected player, and `castConnected` (pinpoint
  gates the same way — the TV must be up before play begins; see `Lobby`'s `canStart` in
  `/home/eric/projects/pinpoint/packages/client/src/player/screens.tsx`). Board layout: filter bank
  categories to those with ≥`BOARD_ROWS` questions, take the first `min(BOARD_COLUMNS, n)`, and for
  each shuffle-pick `BOARD_ROWS` questions with the seeded RNG. Store the chosen `BankQuestion`s in a
  private `Map<questionId, BankQuestion>` on the engine — **not** on `GameRoom` — so there is no way
  to accidentally project them.
- **`selectCell`**: host-only, `phase === 'BOARD'`, cell exists and `!used`. Marks `used = true`,
  builds `ActiveQuestion` (resolve `startSeconds` per §2.3, clamp against `durationSeconds`),
  `phase = 'PLAYING'`, `startedAt = now()`, `playToken = playToken + 1`.
- **`buzz`**: the race guard, exactly as in §2.8. On success: `lockedPlayerId = playerId`,
  `lockedAt = now()`, `phase = 'LOCKED'` (the receiver pauses playback because
  `ReceiverPlayback.paused` derives from `phase === 'LOCKED'`).
- **`judge`**: host-only, `phase === 'LOCKED'`. `award = value/2 * (titleCorrect?1:0) + value/2 *
  (artistCorrect?1:0)`. If both false and `settings.penalizeWrongAnswers`, `award = -value/2`.
  Apply to the locked player's `score`, record `verdict`/`awarded`. If **either** was correct →
  `revealed = true`, `phase = 'REVEAL'`. If both wrong → push the player into `lockedOutPlayerIds`,
  clear `lockedPlayerId`/`lockedAt`, and either return to `PLAYING` (bump `playToken` to resume) or,
  if every connected non-pending player is now locked out, go straight to `REVEAL`.
- **`nextQuestion`**: host-only, `phase === 'REVEAL'`. Promotes any `pendingJoin` players to active.
  If every cell `used` → compute `winnerPlayerIds` (max score, ties included) and `GAME_OVER`;
  else `phase = 'BOARD'`, `active = null`.
- **Pause/resume**: port pinpoint's `pause()`/`maybeResume()` (~lines 687–717) and the
  `castConnected === false → pause('CAST_DROPPED')` behaviour. Keep it simple: pause on host
  disconnect or cast drop; a non-host player dropping mid-question should **not** pause the game
  (unlike pinpoint, where every player is structurally required) — instead just drop them from the
  buzz pool. Document this divergence in a comment.
- **Host transfer on disconnect**: copy pinpoint's `transferHost` private method wholesale, including
  the "prefer a `canHostCast` device" heuristic and the "nobody to take over → keep the crown" branch.

**Verify:** Step 8's tests.

### Step 8 — Engine tests (`packages/server/src/engine/__tests__/`)

Mirror pinpoint's layout (`harness.ts` + several `*.test.ts` files).

- `harness.ts` — a `Clock` class (copy pinpoint's), `makeEngine(seed)` returning
  `{ engine, clock }` wired to the sample fixture bank and a seeded RNG, `addPlayers(engine, n)`
  (first is host), and **`checkInvariants(engine)`** asserting after every mutation:
  - exactly one `isHost` while `players.length > 0`;
  - display names unique case-insensitively;
  - `lockedPlayerId` is null unless `phase === 'LOCKED'`;
  - `lockedPlayerId` never appears in `lockedOutPlayerIds`;
  - `used` cells count is monotonically non-decreasing;
  - **spectator-safe leak check** — `toPublicRoom(room, now)` has `active.answer === null` whenever
    `!active.revealed`, and `JSON.stringify(pub)` contains no `videoId` from the bank;
  - `toPrivateState(engine, p.id, {})` returns `hostAnswer === null` for every non-host player and
    `receiverPlayback === null` for every player socket.
- `buzz.test.ts` — the race: two players buzz in sequence; assert the second gets
  `{ ok: false }` and `lockedPlayerId` is unchanged. A wrong judgement re-arms the others but not the
  loser. All players wrong → `REVEAL`.
- `scoring.test.ts` — the 2×2 verdict matrix at each of the five point values; penalty on/off;
  negative scores permitted; score deltas exactly `value/2` granular.
- `flow.test.ts` — LOBBY → GAME_OVER: select all 25 cells, assert phase transitions in order,
  assert `GAME_OVER` fires exactly when the last cell resolves, assert `winnerPlayerIds` handles a tie.
- `board.test.ts` — layout: 5×5 from a 6×6 bank; a 3-category bank yields a 3-column board; a bank
  where one category has 4 questions excludes that category; the same seed reproduces the same board,
  a different seed does not.
- `host.test.ts` — first joiner is host; `transferHost` rejects non-hosts and disconnected targets;
  host disconnect transfers to a `canHostCast` player preferentially; every host-gated method
  rejects a non-host with an `Only the host…` error.

**Verify:** `npm test -w @music-trivia/server`.

### Step 9 — Projections, room registry, socket server

- `packages/server/src/engine/project.ts` — `toPublicRoom(room, now)` and
  `toPrivateState(engine, playerId, opts)`. Model on pinpoint's file; the extra care here is the
  `videoId` exclusion and `hostAnswer`/`receiverPlayback` gating (§2.6). Add the file-header comment
  spelling out the three secrets.
- `packages/server/src/net/rooms.ts` — port pinpoint's `RoomManager` nearly verbatim: 4-digit
  collision-checked `generateCode()`, `RoomRuntime { engine, sockets, receivers, timer,
  disconnectGraceTimers }`, `closeIfEmpty()` with the `ROOM_EMPTY_GRACE_MS = 60_000` new-room grace,
  and `setPendingCastCode`/`getPendingCastCode` (the 120 s cast handshake window). Constructor takes
  the `QuestionBank` + clip config instead of pinpoint's `CardSource`. **Multi-room falls out for
  free from this registry — do not add anything further for it.**
- `packages/server/src/net/server.ts` — port pinpoint's `attachSocketServer(io, rooms, opts)`
  structure: `SocketData { code?, playerId?, isReceiver? }`, `okAck`/`errAck` helpers, the
  `broadcast(runtime)` function that emits `room:state` to the room and per-socket `you:state`
  (**here it must pass `{ isReceiver: true }` for receiver sockets**), the `standbyReceivers` set,
  and the `DEFAULT_DISCONNECT_GRACE_MS = 60_000` grace-period disconnect handling with its
  explanatory comment. Wire every intent in §4.2.
  - `reconcileTimer(runtime)` here arms **one** timer: when `phase === 'PLAYING'`, fire
    `engine.clipExpired()` at `active.startedAt + durationSeconds*1000 + 250ms` (small pad, as
    pinpoint pads by 20 ms). Clear it on any phase change.
- `packages/server/src/index.ts` — port pinpoint's bootstrap: `loadRootEnv()`, Express with
  `/api/config` (returns `{ castReceiverAppId, publicBaseUrl, appVersion }`), `/api/health`,
  `/api/cast-room`, the `/receiver.html` cache-busting redirect keyed on a per-boot
  `DEPLOY_VERSION` (this exists because Chromecast aggressively caches the receiver page — keep it),
  `express.static(clientDist)`, the SPA fallback route, and the Socket.IO server with
  `pingInterval: 25_000, pingTimeout: 60_000` and its comment about mobile background-tab throttling.
  Load the question bank at boot and log which source won.

**Verify:** `npm run typecheck -w @music-trivia/server`; `node packages/server/dist/index.js` boots
after a build.

### Step 10 — Net integration tests (`packages/server/src/net/__tests__/`)

Port the harness from
`/home/eric/projects/pinpoint/packages/server/src/net/__tests__/integration.test.ts`: boot a real
`http.Server` + Socket.IO on port 0, a `Client` class wrapping `socket.io-client` and caching the
latest `pub`/`priv`, a `tick()` helper.

- `integration.test.ts` — host creates a room, a receiver subscribes, two players join, a full
  question is played end to end over real sockets; assert projections land on all three sockets.
- **`race.test.ts` — acceptance criterion #6 proper:** 4 clients all `emit('buzz:press')` in the
  same tick (`Promise.all` of ack promises); assert **exactly one** ack is `{ ok: true }` and the
  broadcast `pub.active.lockedPlayerId` matches that client. Repeat 50× with a fresh room each time.
- `rooms.test.ts` — two rooms coexist; a buzz in room A never appears in room B's projection.

**Verify:** `npm test -w @music-trivia/server`.

### Step 11 — `@music-trivia/client` skeleton + shared client plumbing

- `packages/client/package.json` — copy pinpoint's, rename, deps `@music-trivia/shared`, `qrcode`,
  `react`, `react-dom`, `socket.io-client`; devDeps as pinpoint's (`@vitejs/plugin-react`, `vite`,
  `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@types/*`).
- `packages/client/vite.config.ts` — copy pinpoint's verbatim, alias
  `@music-trivia/shared → ../shared/src/index.ts`, two rollup inputs (`index.html`, `receiver.html`),
  dev server on 5173 proxying `/socket` (ws) and `/api` to `http://localhost:3001`. **This proxy is
  what makes `npm run dev` a single-origin experience — criterion #1 depends on it.**
- `packages/client/tsconfig.json`, `vitest.config.ts`, `src/test/setup.ts` — copy pinpoint's.
- `packages/client/index.html` / `receiver.html` — copy pinpoint's, retitled. `receiver.html` keeps
  **all three** inline scripts (CAF receiver SDK tag, the `/api/cast-room` poll+redirect, the
  `addCustomMessageListener` block) with the namespace changed to
  `urn:x-cast:com.mooseflip.musictrivia`. **Additionally add the YouTube IFrame API tag:**
  `<script src="https://www.youtube.com/iframe_api"></script>` and a `<div id="yt-player"></div>`
  inside `#root`'s sibling container (see Step 13 for why it must be outside React's render tree).
- `packages/client/src/common/cast.ts` — port per §2.9.
- `packages/client/src/common/store.ts` — port pinpoint's `GameStore`: the singleton socket, the
  observable `patch()`/`subscribe()`, `Ack`-returning `emit()`, `localStorage` keys (use
  `mt:code` / `mt:token` / `mt:name`), the **reconnect re-join logic** in the `connect` handler
  (with pinpoint's comment explaining that transport reconnect does not re-run `room:join`
  server-side), and `receiverStandby()`/`receiverSubscribe()` including the `__castPollTimer`
  cancellation. Replace the game-specific methods with this app's (§4.2).
- `packages/client/src/common/useGame.ts` — copy verbatim (`useSyncExternalStore`).
- `packages/client/src/common/useWakeLock.ts` — copy verbatim; a phone that sleeps mid-game can't buzz.
- `packages/client/src/common/styles.css` — port pinpoint's utility classes (`app`, `card`, `stack`,
  `row`, `spread`, `center`, `muted`, `pill`, `banner`, `tv`, `brand`, `codebox`, `qr`, `players`,
  `pchip`) so the components below can be written against a known vocabulary, then add the
  music-trivia-specific rules (`.board`, `.cell`, `.cell.used`, `.buzz`, `.buzz.locked`,
  `.scorerow`, `.nowplaying`).

**Verify:** `npm run typecheck -w @music-trivia/client`.

### Step 12 — Player UI (`packages/client/src/player/`)

`main.tsx` — copy pinpoint's player entry verbatim (StrictMode + `createRoot`).

`App.tsx` — model on `/home/eric/projects/pinpoint/packages/client/src/player/App.tsx`:
landing → `HostFlow` / `JoinFlow` → `InGame`; `/api/config` fetch; deep-link `?code=` handling;
`ErrorBanner`; `VersionTag`. Keep `HostFlow` intact including `beginCast()`'s
create-room-then-open-picker order and the **"Open TV view (code NNNN)" fallback button** — that
button is the linchpin of local testing.

`screens.tsx` — the game screens (mirrors pinpoint's file of the same name):

- `Lobby` — code pill, cast-connected indicator, player list with 👑 on the host, host-only
  "Start game" (disabled until `castConnected`), host-only "Make host" buttons next to other players
  (`host:transfer`), and a `penalizeWrongAnswers` toggle.
- `BoardPick` (`phase === 'BOARD'`) — host sees a compact tappable grid of the same board the TV
  shows (category headers × values, used cells greyed) and taps to select; non-hosts see
  "🎧 <host> is picking…" plus the scoreboard.
- `BuzzScreen` (`phase === 'PLAYING' | 'LOCKED'`) — **the core screen.** A full-width, ~40vh buzz
  button. States: **armed** (big, colored, `onPointerDown` fires `buzz:press` — use `pointerdown`,
  not `click`, for lower latency); **locked-by-me** ("🎤 You're in! Answer out loud"); **locked-by-other**
  ("🔒 <name> buzzed in"); **locked-out** ("❌ You already guessed"); **disabled** while
  `!g.connected`. Optimistically flip the local button to "sent" on press, but let the server
  projection be the truth — never render "you won the race" from local state.
- `HostJudge` (`phase === 'LOCKED'`, host only) — shows `priv.hostAnswer` (**title + artist**), who
  buzzed, and four buttons: `Both ✓`, `Title only`, `Artist only`, `Both ✗`, each emitting
  `judge:answer` with the corresponding verdict. Plus `Skip question`.
- `Reveal` (`phase === 'REVEAL'`) — the answer, who got it, the points delta, and a host-only "Next".
- `GameOver` — final scores, winner(s), host-only "Rematch".
- `Paused` — port pinpoint's.
- A persistent `ScoreStrip` on every in-game screen: every player's name + score, own row highlighted.

`__tests__/screens.test.tsx` — following
`/home/eric/projects/pinpoint/packages/client/src/player/__tests__/screens.test.tsx`, with fixture
projections in `src/test/fixtures.ts`. Assert: armed buzz button is enabled and dispatches; when
`lockedPlayerId` is another player the button is disabled and shows their name; when the local player
is in `lockedOutPlayerIds` it is disabled; `HostJudge` renders only when `priv.isHost`; a non-host
never sees `hostAnswer` text (it will be `null` in their fixture).

**Verify:** `npm test -w @music-trivia/client`.

### Step 13 — Receiver (TV) UI (`packages/client/src/receiver/`)

`main.tsx` — copy pinpoint's receiver entry verbatim: `store.receiverStandby()`, the
`window.__castOnCode` hook, and the `window.__castPendingCode` check, then `createRoot`.

`App.tsx` — model on `/home/eric/projects/pinpoint/packages/client/src/receiver/App.tsx`:
`/api/config` fetch for `publicBaseUrl`/`appVersion`, `?code=` subscribe, `VersionTag`, and
phase-dispatched TV screens sized in `vw`/`vh` units (TV, not phone):

- **Waiting** — "MUSIC TRIVIA / Waiting for a room…", plus the `__castInitError` diagnostic line.
- **LobbyTV** — join URL, big `codebox` room code, QR (`qrcode` → `toDataURL`, same as pinpoint),
  and joined-player chips.
- **BoardTV** — the Jeopardy grid: `board.categories` as column headers, 5 rows of point values,
  used cells rendered blank/dimmed. Full-bleed, high contrast, huge type.
- **PlayingTV / LockedTV** — the "now playing" panel: category + value, an animated clip
  progress bar driven by `startedAt + durationSeconds` reconciled with `serverOffset`, and, when
  locked, an enormous "🔒 <name>" overlay. The scoreboard strip stays visible in every state.
- **RevealTV** — the answer big on screen with the points delta per player.
- **GameOverTV** — winner(s) and final standings.

`YouTubePlayer.tsx` — the playback component. **Read this whole bullet list before writing it:**

- Loads via the `https://www.youtube.com/iframe_api` tag already in `receiver.html`, using the
  global `window.onYouTubeIframeAPIReady` callback. Guard for it having already fired.
- The `YT.Player` instance is created **once** against the static `#yt-player` div and kept in a
  ref — never re-created on re-render, or you get audio restarts and leaked iframes. React only
  *commands* it via effects keyed on `priv.receiverPlayback?.playToken`.
- `playerVars: { autoplay: 1, controls: 0, disablekb: 1, fs: 0, modestbranding: 1, rel: 0,
  iv_load_policy: 3, playsinline: 1 }`.
- **Hide the video.** The YouTube player chrome displays the song title — that is the answer.
  Cover the iframe with an opaque, `pointer-events: none` overlay (or position it off-screen at
  `left: -9999px`, but keep it in the layout/rendered so audio isn't suspended). Verify by eye that
  no title text is visible on the TV at any point.
- Commands: on a new `playToken` → `loadVideoById({ videoId, startSeconds })`; on
  `receiverPlayback.paused` → `pauseVideo()`, on un-pause → `playVideo()`; on `active === null` →
  `stopVideo()`.
- `onError` (codes 2/5/100/101/150 — the last two mean "embedding disabled by the owner", a very
  real risk for music videos) → emit `receiver:playbackError` so the host's phone shows
  "This track won't play — Skip". Also treat "no `onStateChange` to PLAYING within 5 s" as an error.
- **Autoplay gotcha:** in a plain browser tab (the local-fallback path), unmuted autoplay is blocked
  until a user gesture. Render a one-time full-screen "▶ Tap to enable audio" cover on the receiver
  page that calls `player.playVideo()`, and dismiss it after the first successful play. On a real
  Chromecast this cover will typically never be needed, but leaving it in costs nothing and makes
  local testing possible.

**Verify:** Step 15's manual walkthrough.

### Step 14 — Python question-bank builder (`scripts/questionbank/`)

Create the directory and:

- `scripts/questionbank/requirements.txt`:
  ```
  ytmusicapi>=1.7,<2
  ```
- `scripts/questionbank/build_bank.py` — a single self-contained script, stdlib + `ytmusicapi`:
  - `argparse` flags: `--auth-mode {oauth,browser}` (default `oauth`), `--auth-file` (default
    `oauth.json` / `browser.json` next to the script), `--out` (default
    `<repo>/question-bank/bank.json`), `--playlists` (repeatable playlist id or title substring;
    default = all of the user's own playlists), `--max-categories` (default 8),
    `--songs-per-category` (default 8), `--min-songs` (default 5), `--seed` (int, for reproducible
    sampling), `--dry-run` (print a summary, write nothing).
  - Flow: construct `YTMusic(auth_file)` → `get_library_playlists(limit=100)` → filter → for each,
    `get_playlist(playlistId, limit=200)` → for each track keep only entries that have a
    `videoId` **and** a non-empty `title` **and** at least one artist (skip unavailable/podcast/
    video-type entries and log how many were skipped) → dedupe by `videoId` **globally across
    categories** (the same song in two playlists would make two board cells with one answer) →
    deterministically sample `--songs-per-category` with `random.Random(seed)` → assign
    `value = POINT_VALUES[i]` by index.
  - Artist string: join `track['artists']` names with `', '`; duration from
    `track.get('duration_seconds')`.
  - Drop categories with `< --min-songs` usable tracks, warn about each.
  - Emit the exact `QuestionBank` JSON from §4.1 with `source: "ytmusicapi"` and an ISO-8601
    `generatedAt`; write with `indent=2` + trailing newline; `mkdir -p` the output dir.
  - **Fail loudly and helpfully** when the auth file is missing: print the exact
    `ytmusicapi oauth --client-id … --client-secret …` command and a pointer to the README section.
  - Exit non-zero on any fatal error; print a summary table (`category → n songs`) on success.
- `scripts/questionbank/test_build_bank.py` — pure-stdlib `unittest` tests against a **mocked**
  `YTMusic` (a fake object returning canned `get_library_playlists`/`get_playlist` dicts, injected
  via a `build_bank(client, opts)` seam so no network is touched). Cover: tracks without `videoId`
  are dropped, cross-category `videoId` dedupe, thin categories excluded, point values assigned by
  index, same seed → same output. **This is what makes acceptance criterion #2 automatable.**

Venv creation (record these exact commands in the README, and use them verbatim everywhere):

```bash
/usr/bin/python3 -m venv /home/eric/projects/music-trivia/scripts/questionbank/.venv
/home/eric/projects/music-trivia/scripts/questionbank/.venv/bin/pip install --upgrade pip
/home/eric/projects/music-trivia/scripts/questionbank/.venv/bin/pip install -r /home/eric/projects/music-trivia/scripts/questionbank/requirements.txt
```

**Never use bare `python`, `python3`, or `pip`** in scripts, docs, or verification commands — always
`scripts/questionbank/.venv/bin/python` and `scripts/questionbank/.venv/bin/pip`.

**Verify:**
```bash
/home/eric/projects/music-trivia/scripts/questionbank/.venv/bin/python -m unittest discover -s /home/eric/projects/music-trivia/scripts/questionbank -v
/home/eric/projects/music-trivia/scripts/questionbank/.venv/bin/python /home/eric/projects/music-trivia/scripts/questionbank/build_bank.py --help
```

### Step 15 — README

`README.md` at the repo root, structured like `/home/eric/projects/pinpoint/README.md`:
title + one-paragraph pitch, **Architecture** table of the three packages, **Develop**
(`npm install`, `cp .env.example .env`, `npm run dev`, open http://localhost:5173, note that hosting
needs Chrome for Cast and that "Open TV view" is the no-Chromecast path), **Question bank** (the venv
commands above, the one-time `ytmusicapi` OAuth setup with its Google Cloud "TVs and Limited Input
devices" client requirement, the `build_bank.py` invocation, the JSON schema, and the note that the
app ships a sample bank so none of this is needed to run it), **Test**, **Build & run (production)**,
**Deployment** (state that it follows pinpoint's Docker + Cloudflare Tunnel pattern and is a later
gated step — do **not** write a Dockerfile or compose file now), and an **Environment** var table.

Also document the game rules briefly: the point ladder, the half-title/half-artist scoring, the wrong
-answer penalty setting, and how the host role is assigned/transferred.

**Verify:** every command in the README actually runs, as written, from a clean checkout.

### Step 16 — Final sweep

Run the full acceptance pass in §6, fix anything failing, and leave the tree clean.

---

## 4. Data / model / API changes

### 4.1 Question-bank JSON schema (`question-bank/bank.json`)

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

Field notes:
- `id`s are stable and derived (`cat_<playlistId>`, `q_<videoId>`) so a rebuild doesn't churn them.
- `value` is a **suggestion**; the engine assigns the authoritative value from the row index when it
  lays out the board. Documented in `questions.ts` and the README so nobody "fixes" the redundancy.
- `startSeconds: null` means "use `CLIP_START_SECONDS`". Hand-editable per question.
- `durationSeconds` may be `null` (ytmusicapi doesn't always supply it); the engine then skips the
  clamp described in §2.3.
- `videoId` is the only field the receiver ever needs and the one field never sent to a player.

### 4.2 Socket.IO protocol (`packages/shared/src/protocol.ts`)

**Client → Server (intents).** All ack-bearing intents use pinpoint's `Ack<T>`.

| Event | Payload | Ack | Who | Notes |
|---|---|---|---|---|
| `host:create` | `{ canCast: boolean }` | `{ code }` | anyone | Creates the room; also sets the pending cast code. |
| `host:castStatus` | `{ connected: boolean }` | — | host | Mirrors pinpoint. |
| `room:join` | `{ code, displayName, reconnectToken?, canCast? }` | `{ playerId, reconnectToken }` | anyone | First joiner becomes host. |
| `receiver:subscribe` | `{ code }` | `{}` | TV | Marks socket `isReceiver`; sets `castConnected`. |
| `receiver:standby` | `{}` | — | TV | Waits for `cast:roomCode`. |
| `receiver:playbackError` | `{ message: string }` | — | TV | YT `onError` / stall. |
| `game:start` | `{}` | `{}` | host | LOBBY → BOARD. |
| `game:settings` | `{ penalizeWrongAnswers?: boolean }` | — | host | Lobby only. |
| `host:transfer` | `{ playerId: string }` | `{}` | host | New vs pinpoint (§2.5). |
| `board:select` | `{ categoryIndex: number; rowIndex: number }` | `{}` | host | BOARD → PLAYING. |
| `buzz:press` | `{}` | `{}` | any player | **The race.** No timestamp field — deliberately. |
| `judge:answer` | `{ titleCorrect: boolean; artistCorrect: boolean }` | `{}` | host | LOCKED → PLAYING/REVEAL. |
| `question:skip` | `{}` | `{}` | host | → REVEAL, no points. |
| `playback:replay` | `{}` | `{}` | host | Bumps `playToken`. |
| `question:next` | `{}` | `{}` | host | REVEAL → BOARD / GAME_OVER. |
| `host:forceEnd` | `{}` | — | host | → GAME_OVER. |
| `host:rematch` | `{}` | `{}` | host | New board, scores reset. |

**Server → Client (events).**

| Event | Payload | To |
|---|---|---|
| `host:created` | `{ code: string }` | the creating socket |
| `room:state` | `PublicRoom` | everyone in the room (players + receivers) |
| `you:state` | `PrivateState` | each socket individually |
| `room:closed` | `{ reason: string }` | the room |
| `error` | `{ message: string }` | one socket |
| `cast:roomCode` | `{ code: string }` | standby receivers |

Constants: `SOCKET_PATH = '/socket'`, `CAST_NAMESPACE = 'urn:x-cast:com.mooseflip.musictrivia'`.

### 4.3 HTTP endpoints (Express, `packages/server/src/index.ts`)

| Route | Response |
|---|---|
| `GET /api/config` | `{ castReceiverAppId, publicBaseUrl, appVersion }` |
| `GET /api/health` | `{ ok, version, rooms, bankSource, categories }` |
| `GET /api/cast-room` | `{ code: string \| null }`, `Cache-Control: no-store` |
| `GET /receiver.html` | 302 to `?v=<DEPLOY_VERSION>` then `no-store` file (Chromecast cache-busting) |

### 4.4 Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP/WebSocket port. |
| `CAST_RECEIVER_APP_ID` | *(empty)* | Google Cast custom receiver app id. Empty is fine for dev. |
| `PUBLIC_BASE_URL` | `http://localhost:5173` | Base URL for the TV's QR join link. |
| `QUESTION_BANK_PATH` | `question-bank/bank.json` | Bank file; falls back to the bundled sample. |
| `CLIP_START_SECONDS` | `30` | Default clip offset. |
| `CLIP_DURATION_SECONDS` | `20` | Default clip length. |

No `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` — this app generates nothing with AI.

---

## 5. Testing & verification

Commands, all run from `/home/eric/projects/music-trivia`:

```bash
npm install
npm run typecheck                 # all workspaces
npm test                          # npm run test --workspaces --if-present
npm run build                     # shared -> client -> server
npm run dev                       # server :3001 + vite :5173
node packages/server/dist/index.js    # production-mode smoke test after build

# Python side — always the venv's interpreter, never bare python/pip
/usr/bin/python3 -m venv scripts/questionbank/.venv
scripts/questionbank/.venv/bin/pip install -r scripts/questionbank/requirements.txt
scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py --dry-run   # needs real auth
```

### Acceptance criteria → proof

1. **`npm install && npm run dev` serves player + receiver off the sample bank.**
   Run it. Confirm the server logs `[startup] … bank source: fixture (N categories)`, then
   `curl -s localhost:5173/api/health` (through the Vite proxy — this also proves the proxy works)
   returns `bankSource: "fixture"`. Load http://localhost:5173 (player) and
   http://localhost:5173/receiver.html (receiver) and confirm both render.
2. **Python script produces schema-conformant JSON.**
   `scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v` passes,
   including a test that the mocked run's output validates against the schema (mirror the same field
   checks `validateQuestionBank` performs). Additionally: point the server at a generated bank
   (`QUESTION_BANK_PATH=/tmp/bank.json npm run dev:server`) and confirm it loads with
   `bankSource: "file"`. A real-account run is a user action, not a build-step requirement.
3. **Room create + join with a code/QR.**
   Tab A: http://localhost:5173 → "Host a Game" → "Open TV view (code NNNN)". Tab B (or a phone on
   the LAN): http://localhost:5173/?code=NNNN → enter a name → Join. Assert the TV lobby shows the
   code, a scannable QR, and both players' chips; the first joiner shows 👑.
4. **TV renders the Jeopardy board.**
   Host taps "Start game". The receiver shows 5 category headers (playlist names from the fixture)
   over 5 rows of 100–500. Cross-check the headers against `sample-bank.json`.
5. **Selecting a cell plays the song.**
   Host taps a cell. The receiver enters the now-playing panel, the "Tap to enable audio" cover is
   dismissed (browser-tab path), and audio is audible. Confirm **no song title is visible anywhere
   on the TV** (the anti-spoiler overlay is doing its job) and that DevTools shows the YT iframe
   loaded with the fixture's `videoId`.
6. **Buzz race resolved server-side.**
   Automated: `packages/server/src/net/__tests__/race.test.ts` (50 rooms × 4 simultaneous buzzes,
   exactly one `ok: true` each). Manual: two player tabs, hammer both buzz buttons — one shows
   "You're in", the other flips to "🔒 <name> buzzed in" and is disabled; the TV shows the lock and
   the music pauses.
7. **Host judges; scores propagate.**
   With a lock active, the host tab shows the answer and the four verdict buttons. Tap `Title only`
   at a 400 cell → the buzzer's score goes up by exactly 200 on the host tab, the other player's tab,
   and the TV. Tap `Both ✗` on the next question with penalties on → score drops by half the value
   and the other player can still buzz. Automated coverage in `scoring.test.ts`.
8. **`npm test` covers the engine.**
   `npm test` runs server (`buzz`, `scoring`, `flow`, `board`, `host`, `bank`, plus net
   `integration`/`race`/`rooms`) and client (`screens`) suites; all green.
9. **`npm run typecheck` passes across workspaces.** All three report clean.

---

## 6. Risks & watch-outs

**Ordering constraints**
- `@music-trivia/shared` must build before server/client — the root `build` script encodes this.
  During dev, both consume `../shared/src/index.ts` through a Vite/Vitest alias, so a stale
  `shared/dist` can silently diverge from source. If `npm run build` fails on something `npm run dev`
  liked, rebuild shared first.
- Steps 3–4 (shared types) gate everything. Don't start the engine before the protocol is settled;
  half the risk in this build is churn from an under-specified projection boundary.

**YouTube on the receiver — the biggest technical risk**
- **The player chrome shows the song title.** That is the answer. If the overlay/off-screen trick is
  botched, the game is broken and no test will catch it — verify visually.
- **Embed-disabled videos** (`onError` 101/150) are common for label-owned music videos. The fixture
  may rot. The `receiver:playbackError` → host "Skip" path is a functional requirement, not polish.
- **Autoplay policy**: unmuted autoplay is blocked in a normal browser tab without a gesture. The
  "Tap to enable audio" cover is required for the local-fallback path (which is how all testing
  happens). Don't "fix" the problem by muting — a muted music-trivia game is no game.
- The IFrame API is loaded from `https://www.youtube.com` — a real Chromecast receiver page must be
  served over **HTTPS** (Cast requires it for registered receiver apps), which is another reason
  Chromecast verification is deferred to the later deploy step.
- Create the `YT.Player` **once**. Re-creating it on React re-render causes audio restarts, duplicate
  iframes, and phantom `onError`s. Command it through refs + effects keyed on `playToken`.

**Chromecast**
- `CAST_RECEIVER_APP_ID` will be empty until the user registers a new receiver app in the Cast SDK
  Developer Console — a browser-only manual step. Nothing in the build or the acceptance pass may
  depend on it; use "Open TV view" throughout.
- Do not simplify away the three redundant room-code delivery paths or the `sendCode` retry ladder in
  `cast.ts`. They look like belt-and-braces; pinpoint's comments say they were each earned.
- Keep the `/receiver.html?v=<DEPLOY_VERSION>` cache-busting redirect — Chromecast caches hard.

**ytmusicapi**
- OAuth setup is an **interactive one-time step only the user can do** (Google Cloud OAuth client of
  type "TVs and Limited Input devices", then `ytmusicapi oauth`). Document it, error helpfully, and
  never make it a prerequisite for `npm run dev`, `npm test`, or any acceptance criterion.
- `ytmusicapi` is unofficial; response shapes drift between versions. Pin `>=1.7,<2`, treat every
  field as optional in the parser, and skip-with-a-count rather than crash on odd entries
  (podcasts, unavailable tracks, video-type items with no `videoId`).
- The builder's unit tests must mock the client entirely — **no network in `npm test` or in the
  Python tests.**

**Socket.IO / correctness**
- The buzz guard must live **inside the engine**, not in the socket handler. Any second entry point
  that can set `lockedPlayerId` is a bug waiting to happen.
- Never accept a client timestamp for buzz ordering, however tempting "latency compensation" sounds.
- The losing buzzers must be driven to the locked UI by the **broadcast projection**, not by their
  ack, because ack ordering is not guaranteed relative to the broadcast.
- Port pinpoint's two-layer disconnect tolerance (Socket.IO `pingTimeout: 60_000` plus the 60 s
  `disconnectGraceMs` before anything user-visible happens). Phones background aggressively; without
  this, a player who glances at a notification looks like a drop.
- Reconnect does **not** re-run `room:join` server-side — port the store's `connect`-handler re-join
  logic or reconnected players will be stuck as ghosts.
- The clip-expiry timer must be cleared on every phase change, or a stale timer will yank a question
  out from under a locked buzz.

**Scope discipline**
- Resist adding fuzzy answer matching "just as a hint" for the host — the brief is explicit.
- Resist per-genre or waveform-based clip selection. `CLIP_START_SECONDS` is the whole feature.

---

## 7. Out of scope (do not build)

Restated from the brief so it isn't rediscovered mid-build:

- **No auto-grading / fuzzy answer matching.** The host judges, full stop. No Levenshtein, no
  normalization helper, no "did you mean".
- **No automated or scheduled question-bank regeneration.** `build_bank.py` is run by hand. No cron,
  no watcher, no server-side invocation of Python.
- **No official YouTube Music API.** It doesn't exist; stay on `ytmusicapi`.
- **No production-deploy hardening beyond pinpoint's pattern.** Do **not** write a `Dockerfile`,
  `docker-compose.yml`, `.dockerignore`, or Cloudflare Tunnel config in this build — deployment is a
  separate, later, gated step. The README may only *describe* that it will follow pinpoint's pattern.
- **No clip-selection intelligence.** No intro detection, no hook finding, no loudness analysis.
- **No multi-room hardening beyond what pinpoint's `RoomManager` gives for free.** Multiple
  simultaneous rooms work because the registry is keyed by code; do not add persistence, sharding,
  room listing, or cross-room admin.
- **No accounts, no persistence, no database.** All state is in memory and dies with the process,
  exactly like pinpoint.
- **No push to any git remote.** There is none configured; local commits only.
