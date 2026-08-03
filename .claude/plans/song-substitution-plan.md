# Implementation Plan — Runtime Song Substitution

Companion to `.claude/plans/song-substitution-brief.md` (read that first for the
problem statement and acceptance criteria). This plan is self-contained: every
file path is absolute-from-repo-root and every new symbol is named.

Repo root: `/home/eric/projects/setlist`. Working tree is clean. Node v24.14.0
(global `fetch` available — **do not add an HTTP dependency**). Commands from
repo root: `npm run typecheck`, `npm test`, `npm run build`.

---

## 1. Summary

~85% of songs in a real game failed to play with YouTube IFrame error 101/150
("Embedding disabled by the owner") even though every one of those videos was
verified embeddable via *both* the Data API's `status.embeddable` field *and*
the oEmbed endpoint. The cause is per-domain embed allowlisting: many
label-uploaded music videos permit embedding only on approved domains, and
neither API surface reflects that. It is only discoverable by a real browser
attempting playback from the real origin — i.e. exactly the moment the game
already fails. There is no offline pre-check that can catch it.

So we handle it reactively. When the TV receiver's `YT.Player` `onError` fires
(the existing `receiver:playbackError` path), the **server** searches the
YouTube Data API v3 for alternate uploads of the same song — different uploads
(auto-generated "Topic" channel audio, lyric videos, fan uploads) are far less
likely to carry the same domain restriction as the official music video —
verifies each candidate plausibly *is* the same song, and plays up to **2** of
them by bumping the existing `playToken`. While that happens the room shows a
"finding another version…" indicator and **buzzing is disabled**. If both
attempts fail (or there is no API key, or the search errors), the room lands in
exactly today's state: `active.playbackError` set, host taps Skip. That
fallback must be byte-identical to current behavior.

---

## 2. Approach & key decisions

These resolve the brief's "still open for the planner" list. Implement them as
written unless something in the code contradicts them.

### 2.1 Where the code lives (the pure-engine / net-I/O split)

`packages/server/src/engine/engine.ts` is a deterministic state machine; all
side effects (the clip-expiry `setTimeout`, socket emits) live in
`packages/server/src/net/server.ts`. That discipline holds here:

- **Engine** gains pure methods that *mint* a retry, *accept* its outcome, and
  *represent* the retrying state. It never calls `fetch`.
- **Net layer** (`net/server.ts`) performs the `fetch`, awaits it, and feeds the
  result back into the engine, then `broadcast()`s — mirroring exactly how
  `reconcileTimer` schedules `clipExpired()` and re-broadcasts.

### 2.2 Search once, try two candidates (decision)

**Decision: one search call per failed question**, requesting `maxResults=10`,
filtered and ranked down to an ordered candidate list of up to 2 videoIds
stored server-side on the active question. Attempt 1 pops the first; if that
also errors, attempt 2 pops the second with **no further I/O**.

Justification: (a) it costs 100 quota units per failed question instead of 200
in the worst case; (b) counter to the brief's guess, it is the *simpler* async
story — there is at most one in-flight `fetch` per question ever, so there is
exactly one stale-response race window to guard instead of two, and attempt 2 is
a pure synchronous engine transition. Tradeoff: if the search yields only one
acceptable candidate, there is no second attempt and we fall back after one —
acceptable, and explicitly tested.

### 2.3 Query construction (decision)

`q` = `` `${title} ${artist}` `` — the natural relevance query, nothing more.

Do **not** bake "official audio"/"lyrics" into the query text: it degrades
YouTube's relevance ranking and can return a different song's lyric video. The
embeddable-friendly bias belongs in **ranking**, not the query (§2.4): boost
`- Topic` channels and titles containing "audio"/"lyric", penalize titles
containing "official video"/"music video".

Request parameters (all on the one call):

| param | value | why |
|---|---|---|
| `part` | `snippet` | need `title` + `channelTitle` for matching |
| `q` | `` `${title} ${artist}` `` | §2.3 |
| `type` | `video` | required for the video-only filters below |
| `videoEmbeddable` | `true` | free removal of globally-non-embeddable results |
| `maxResults` | `10` | enough to survive filtering; same 100-unit cost |
| `key` | `YOUTUBE_API_KEY` | |

Deliberately **not** set: `videoCategoryId=10` (Music) — many legitimate lyric
and fan uploads are categorized Entertainment and would be filtered out.

### 2.4 Same-song matching heuristic (decision — hand-rolled, no new dependency)

New file `packages/server/src/net/songmatch.ts`, pure and directly unit-testable.

```
normalize(s):
  s.normalize('NFKD')
   .replace(/[̀-ͯ]/g, '')     // strip diacritics
   .toLowerCase()
   .replace(/&/g, ' and ')
   .replace(/[^a-z0-9]+/g, ' ')
   .trim()
```

`STOPWORDS = the, a, an, of, and, feat, ft, featuring, with, official, video,
audio, lyrics, lyric, hd, hq, 4k, remaster, remastered, version, music, mv`

`tokens(s)` = `normalize(s).split(' ')` minus stopwords minus empty strings.

**Rejection scan** — run against `normalize(candidateTitle)` *before* scoring.
Reject outright if it contains any of (as whitespace-delimited word runs):
`karaoke`, `instrumental`, `cover`, `tribute`, `reaction`, `nightcore`, `remix`,
`sped up`, `slowed`, `8 bit`, `backing track`, `live at`, `live from`,
`live in`, `live performance`. (Note the `live` entries are two-word phrases on
purpose so a title like "Live and Let Die" is not rejected.)

**Scoring** — let `T = tokens(originalTitle)`, `A = tokens(originalArtist)`,
`C = tokens(candidateTitle)`, `Ch = tokens(candidateChannelTitle)`:

- `titleScore = |T ∩ C| / |T|` (if `|T| === 0`, treat as 0 → reject)
- `artistScore = max(|A ∩ C| / |A|, |A ∩ Ch| / |A|)` (the channel form is what
  catches auto-generated `"<Artist> - Topic"` uploads, which are precisely the
  uploads most likely to embed anywhere)

**Accept** iff `titleScore >= 0.7 && artistScore >= 0.5`, with one extra rule:
if `|T| === 1` require `titleScore === 1` (a one-word title can't be matched at
70%).

**Rank** accepted candidates, descending, by:

```
rank = titleScore + artistScore
     + 3 if normalize(channelTitle) ends with ' topic'
     + 2 if normalize(candidateTitle) contains 'audio' or 'lyric'
     - 1 if normalize(candidateTitle) contains 'official video'
                                   or 'music video'
```

Ties keep API result order (use a stable sort — `Array.prototype.sort` is
stable in V8). Always exclude any candidate whose `videoId` equals the original
question's `videoId` or one already attempted. Take the top **2**.

Export shape:

```ts
export interface SongMatchInput { title: string; artist: string }
export interface Candidate { videoId: string; title: string; channelTitle: string }
export function pickCandidates(
  song: SongMatchInput,
  candidates: Candidate[],
  opts: { excludeVideoIds: string[]; limit: number },
): Candidate[];
// plus `normalize`, `tokens`, `scoreCandidate` exported for unit tests
```

### 2.5 Protocol/state representation (decision)

Mirroring the `timedOut: boolean` precedent — one narrow public boolean, and
everything secret stays server-side.

**Public** (`PublicActiveQuestion` in `packages/shared/src/projection.ts`, and
mirrored onto `ActiveQuestion` in `packages/shared/src/types.ts`):

- `retrying: boolean` — true from the moment the receiver reports an error that
  we intend to handle, until the substitute is loaded or retries are exhausted.
  This is the *only* new public field. It carries no video information.

**Server-only** on `ActiveQuestion` (present in `types.ts`, deliberately **not**
copied into `toPublicRoom`):

- `retryAttempts: number` — 0..2, the server-side cap. Never client-trusted.
- `retryCandidates: string[]` — remaining candidate videoIds from the one search.
- `substituteVideoId: string | null` — the currently-playing substitute, or null
  for the bank's original.
- `retryId: string | null` — opaque per-search token used to reject stale
  search results (§2.6).
- `lastPlaybackErrorMessage: string | null` — the message to surface if we end
  up exhausting (so the final host-facing banner reads the same as today).

The videoId secret is preserved structurally: `toPublicRoom` copies fields
one at a time (it does not spread `a`), so adding server-only fields to
`ActiveQuestion` cannot leak them. The receiver gets the substitute through the
**existing** `PrivateState.receiverPlayback` branch in
`packages/server/src/engine/project.ts`, which is gated on `opts.isReceiver`:

```ts
videoId: a.substituteVideoId ?? a.question.videoId
```

No new socket event is required for the substitute — bumping the existing
`playToken` is what already drives `YouTubePlayer`'s load-a-new-video effect.

**One optional protocol addition** (`packages/shared/src/protocol.ts`):

```ts
'receiver:playbackError': (payload: { message: string; playToken?: number }) => void;
```

`playToken` is optional so existing tests and any in-flight client keep
compiling/working. The engine ignores a report whose `playToken` is older than
the active question's current `playToken` — this kills late `onError` events
from the *previous* video arriving after a substitute has already loaded.

### 2.6 Stale-result guard

Every `beginRetry()` mints a fresh `retryId` (e.g.
`` `r${++seq}_${Math.random().toString(36).slice(2, 8)}` ``) and stores it on
the active question. The net layer passes that id back into
`engine.resolveRetrySearch(retryId, candidates)`. The engine **ignores** the
call (returns an error result, no state change) if:

- `room.active` is null, or
- `room.active.retryId !== retryId`.

Since `selectCell()` builds a brand-new `active` object and `nextQuestion()`
sets `active = null`, a search that resolves after the question has moved on can
never touch the new question. This is the single most important correctness
guard in the feature.

---

## 3. Data / model / API changes

### 3.1 YouTube Data API v3 request

```
GET https://www.googleapis.com/youtube/v3/search
  ?part=snippet
  &q=<encodeURIComponent(`${title} ${artist}`)>
  &type=video
  &videoEmbeddable=true
  &maxResults=10
  &key=<YOUTUBE_API_KEY>
```

Response shape actually consumed (everything else ignored):

```jsonc
{
  "items": [
    {
      "id": { "kind": "youtube#video", "videoId": "dQw4w9WgXcQ" },
      "snippet": { "title": "…", "channelTitle": "Rick Astley - Topic" }
    }
  ]
}
```

Parse defensively (this is untrusted remote JSON, same posture as
`validateQuestionBank` in `packages/shared/src/questions.ts`): skip any item
lacking a string `id.videoId`, `snippet.title`, or `snippet.channelTitle`.
Non-2xx response, network error, timeout, or malformed body ⇒ treat as "no
candidates" and exhaust immediately.

Quota: 100 units/call against the 10,000/day default = ~100 failed songs per
day. Log the call so it's observable. No extra guardrails beyond the 2-attempt
cap (explicitly out of scope).

### 3.2 Shared type changes

`packages/shared/src/types.ts` — `ActiveQuestion` gains:

```ts
  /** True while the server is searching for / loading a substitute video.
   *  Buzzing is disabled and the clip timer is suspended while true. */
  retrying: boolean;
  /** Server-only from here down — deliberately NOT in PublicActiveQuestion. */
  retryAttempts: number;
  retryCandidates: string[];
  substituteVideoId: string | null;
  retryId: string | null;
  lastPlaybackErrorMessage: string | null;
```

`packages/shared/src/projection.ts` — `PublicActiveQuestion` gains **only**:

```ts
  /** The server is trying an alternate upload of this song. Buzzers are cold. */
  retrying: boolean;
```

`packages/shared/src/types.ts` also gains the cap constant next to the other
constants at the bottom of the file:

```ts
/** Alternate uploads tried automatically before falling back to manual Skip. */
export const MAX_SUBSTITUTION_ATTEMPTS = 2;
```

### 3.3 Protocol

Only the optional `playToken` field on `receiver:playbackError` (§2.5). No new
events.

---

## 4. Step-by-step tasks

Each step is independently verifiable. Run `npm run typecheck` after each of
steps 1–8; the shared package must be rebuilt (`npm run build -w @setlist/shared`)
before server/client typecheck picks up new shared types, or use the repo-root
`npm run typecheck` which handles workspace order.

### Step 1 — Shared types

Files: `packages/shared/src/types.ts`, `packages/shared/src/projection.ts`,
`packages/shared/src/protocol.ts`.

1. Add the six new `ActiveQuestion` fields from §3.2 with the comments shown.
2. Add `retrying: boolean` to `PublicActiveQuestion`, with a comment noting the
   server-only fields are intentionally absent (match the existing
   `// NOTE: videoId deliberately absent` house style).
3. Add `MAX_SUBSTITUTION_ATTEMPTS = 2`.
4. Add the optional `playToken?: number` to `receiver:playbackError` in
   `protocol.ts`.

At this point typecheck will fail in `engine.ts`, `project.ts` and the client
fixtures — that's expected and fixed in the next steps.

### Step 2 — Engine: initialize + project the new state

File: `packages/server/src/engine/engine.ts`.

1. In `selectCell()`, extend the `this.room.active = { … }` literal with:
   `retrying: false, retryAttempts: 0, retryCandidates: [], substituteVideoId:
   null, retryId: null, lastPlaybackErrorMessage: null`.
2. Add a module-level `retryIdSeq` counter and a `makeRetryId()` helper next to
   the existing `makeToken()` / `makePlayerId()` helpers.

File: `packages/server/src/engine/project.ts`.

3. In `toPublicRoom`, add `retrying: a.retrying,` next to `timedOut: a.timedOut,`.
   Add nothing else — the other new fields stay server-side.
4. In `toPrivateState`, change the receiver playback line to
   `videoId: a.substituteVideoId ?? a.question.videoId,` and leave the comment
   block above it intact (extend it with one line noting the substitute).

File: `packages/client/src/test/fixtures.ts`.

5. Add `retrying: false,` to `makeActive()`'s defaults so client tests compile.

### Step 3 — Engine: the retry state machine

File: `packages/server/src/engine/engine.ts`. Rewrite `reportPlaybackError` and
add three new methods. Keep them near the existing `reportPlaybackError` /
`skipQuestion` block and give them the same comment density as their neighbours.

```ts
export type BeginRetryResult =
  | { ok: true; retryId: string; title: string; artist: string;
      excludeVideoIds: string[]; needSearch: boolean }
  | { ok: false; error: string };
```

**`reportPlaybackError(message: string, playToken?: number): EngineResult`**
— keeps today's signature-compatible behavior for the no-retry path.

- `const active = this.room.active; if (!active) return err('No question in play.');`
- **New:** if `playToken !== undefined && playToken < active.playToken` return
  `err('Stale playback error.')` — a late `onError` from a superseded video.
- **New:** if `active.retrying` return `err('Already retrying.')` — dedupes the
  double `onError` YouTube sometimes fires.
- Record `active.lastPlaybackErrorMessage = message`.
- Set `active.playbackError = message` (unchanged from today). The net layer
  will clear it if it decides to retry — see `beginRetry`.
- `return ok;`

**`beginRetry(): BeginRetryResult`** — called by the net layer immediately
after a successful `reportPlaybackError`, only when a YouTube client is
configured.

- Reject (`{ ok: false, error }`) if: no `active`; `room.phase !== 'PLAYING'`;
  `active.retrying` already true; or
  `active.retryAttempts >= MAX_SUBSTITUTION_ATTEMPTS` — **this is the
  server-side cap, the only place it is enforced.**
- Set `active.retrying = true`.
- Clear `active.playbackError = null` — while retrying, the room shows the
  retry indicator, not today's error banner. (`lastPlaybackErrorMessage`
  retains the text for the eventual fallback.)
- `needSearch = active.retryCandidates.length === 0 && active.retryAttempts === 0`.
  If `needSearch`, mint and store `active.retryId = makeRetryId()`; otherwise
  leave `retryId` null (attempt 2 needs no search and no stale guard).
- Return `{ ok: true, retryId: active.retryId ?? '', title:
  active.question.title, artist: active.question.artist, excludeVideoIds: [
  active.question.videoId, ...attempted ], needSearch }`. Track attempted ids by
  keeping `substituteVideoId` history in a small server-only array if you
  prefer; simplest sufficient version: exclude `active.question.videoId` and
  `active.substituteVideoId` when non-null.

**`resolveRetrySearch(retryId: string, videoIds: string[]): EngineResult`**

- `if (!active) return err('No question in play.');`
- `if (active.retryId !== retryId) return err('Stale retry.');` ← §2.6 guard.
- `active.retryCandidates = videoIds.slice(0, MAX_SUBSTITUTION_ATTEMPTS);`
- `return ok;`

**`playSubstitute(): EngineResult`** — consume the next candidate and restart
playback.

- `if (!active) return err('No question in play.');`
- `if (!active.retrying) return err('Not retrying.');`
- `const next = active.retryCandidates.shift(); if (!next) return err('No candidate.');`
- `active.substituteVideoId = next;`
- `active.retryAttempts += 1;`
- `active.retrying = false;`
- `active.playbackError = null;`
- `active.playToken += 1;` and `active.startedAt = this.now();` ← reuses the
  existing mechanism that `replayClip()` uses and that `YouTubePlayer`'s
  `playToken` effect already watches; also restarts the clip timer cleanly via
  `reconcileTimer`.
- `return ok;`

**`exhaustRetries(): EngineResult`** — give up; land in exactly today's state.

- `if (!active) return err('No question in play.');`
- `active.retrying = false;`
- `active.playbackError = active.lastPlaybackErrorMessage ?? active.playbackError;`
- `active.retryCandidates = [];`
- `active.retryId = null;`
- `return ok;`

**`canBuzz()`** — add one clause: `if (active.retrying) return false;` (place it
right after the existing `lockedPlayerId !== null` check). This is criterion 4's
server-side half; the client UI in Step 7 is only cosmetic reinforcement.

**`buzz()`** — add the same guard so a racing socket can't sneak in:
after the phase check, `if (active.retrying) return err('Finding another version…');`

### Step 4 — Env var threading

File: `packages/server/src/env.ts`. Add:

```ts
/** YouTube Data API v3 key. Read by the Node server for runtime song
 *  substitution (net/youtube.ts) as well as by the offline Python builder.
 *  Empty/absent simply disables substitution — playback errors fall straight
 *  through to the host's manual Skip, exactly as before. */
export function youtubeApiKey(): string {
  return (process.env.YOUTUBE_API_KEY ?? '').trim();
}
```

File: `/home/eric/projects/setlist/.env.example`. Move `YOUTUBE_API_KEY` out
from under the `# --- scripts/questionbank/build_bank.py only …` header into its
own block above it, and reword:

```
# --- Read by BOTH the Node server and scripts/questionbank/build_bank.py ---
# Google/YouTube Data API v3 key. Builder: embeddable pre-check. Server: live
# search for an alternate upload when a song fails to play mid-game (up to 2
# substitutes tried before falling back to the host's manual Skip). Unset =
# substitution disabled, everything else works.
YOUTUBE_API_KEY=
```

Leave the `ANTHROPIC_*` block under the builder-only header.

File: `/home/eric/projects/setlist/README.md`. Update the "Embeddable
pre-check" paragraph (~line 220) so it no longer implies the key is
builder-only, and add a short paragraph after it:

> **Runtime song substitution**: the `status.embeddable` flag cannot see
> per-domain embed allowlists, so some videos still fail live with error
> 101/150. When that happens the Node server (which now also reads
> `YOUTUBE_API_KEY`) searches the YouTube Data API v3 for an alternate upload of
> the same song, verifies the title/artist plausibly match, and plays it — up to
> 2 attempts, with a "finding another version…" indicator and buzzers disabled
> throughout. If both fail, or the key is unset, it falls back to the host's
> manual Skip exactly as before. Costs 100 quota units per failed song against
> the 10,000/day default.

Also update any env-var table in the README that lists `YOUTUBE_API_KEY` as
builder-only (grep for it: `grep -n YOUTUBE_API_KEY README.md`).

### Step 5 — The injectable YouTube search client

New file: `packages/server/src/net/youtube.ts`.

```ts
/** Injectable seam for the one live external call this server makes.
 *  Mirrors the RoomManager/EngineDeps constructor-injection pattern: the real
 *  implementation is built in index.ts, tests pass a fake. */
export interface YouTubeSearchResult {
  videoId: string;
  title: string;
  channelTitle: string;
}
export interface YouTubeSearchClient {
  /** Resolves to [] on any failure — never throws, never rejects. */
  searchVideos(query: string): Promise<YouTubeSearchResult[]>;
}

export interface CreateYouTubeSearchClientOptions {
  apiKey: string;
  /** Defaults to global fetch. Overridable for tests that want to assert URLs. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number; // default 5000
  maxResults?: number; // default 10
}

export function createYouTubeSearchClient(
  opts: CreateYouTubeSearchClientOptions,
): YouTubeSearchClient;
```

Implementation notes:

- Build the URL with `new URL('https://www.googleapis.com/youtube/v3/search')`
  and `searchParams.set(...)` per §3.1.
- `signal: AbortSignal.timeout(timeoutMs)` so a hung search can't strand a
  question mid-game.
- Wrap everything in `try/catch`; on non-`res.ok`, thrown error, or malformed
  body, `console.warn('[youtube] search failed: …')` and `return []`.
- Validate each item defensively (§3.1) before mapping.
- Log one line per call: `console.log('[youtube] search "<query>" -> N results')`
  so quota use is observable in `docker logs`.

### Step 6 — Net-layer orchestration

File: `packages/server/src/net/server.ts`.

1. Extend the options bag (this is the DI seam, alongside the existing
   `disconnectGraceMs`):

```ts
export function attachSocketServer(
  io: IO,
  rooms: RoomManager,
  opts: { disconnectGraceMs?: number; youtube?: YouTubeSearchClient | null } = {},
): void
```

   `const youtube = opts.youtube ?? null;` — null means substitution is off and
   the handler behaves exactly like today.

2. **Suspend the clip timer while retrying.** In `reconcileTimer`, change the
   arming condition to:

```ts
if (room.phase === 'PLAYING' && room.active && !room.active.retrying) { … }
```

   Without this, the 20-second clip timer would fire `clipExpired()` in the
   middle of a search and reveal the answer. Add a one-line comment saying so.

3. Rewrite the `receiver:playbackError` handler:

```ts
socket.on('receiver:playbackError', ({ message, playToken }) => {
  const runtime = runtimeForSocket(socket);
  if (!runtime || !data(socket).isReceiver) return;
  const res = runtime.engine.reportPlaybackError(message, playToken);
  if (!res.ok) return;                       // stale / duplicate — ignore silently
  console.log(`[receiver] playback error in ${runtime.engine.room.code}: ${message}`);
  broadcast(runtime);
  if (youtube) void trySubstitute(runtime);  // fire-and-forget; see below
});
```

   Note the ordering: `broadcast()` first (so today's behavior is preserved for
   the no-client case and the host sees *something* immediately), then the
   async attempt, which broadcasts again when it changes state.

4. Add the orchestrator, defined alongside `reconcileTimer` (module scope inside
   `attachSocketServer`, so it closes over `youtube` and `broadcast`):

```ts
/**
 * Runtime song substitution. The engine holds all state and enforces the
 * 2-attempt cap; this function only performs the I/O and hands the result
 * back. Mirrors reconcileTimer's shape: side effect out here, decision in the
 * engine. Never throws — every failure path ends in exhaustRetries().
 */
async function trySubstitute(runtime: RoomRuntime): Promise<void> {
  const engine = runtime.engine;
  const begun = engine.beginRetry();
  if (!begun.ok) return;                       // cap hit, wrong phase, etc.
  broadcast(runtime);                          // players see "finding another version…"

  if (begun.needSearch) {
    const results = await youtube!.searchVideos(`${begun.title} ${begun.artist}`);
    const picked = pickCandidates(
      { title: begun.title, artist: begun.artist },
      results,
      { excludeVideoIds: begun.excludeVideoIds, limit: MAX_SUBSTITUTION_ATTEMPTS },
    );
    const applied = engine.resolveRetrySearch(begun.retryId, picked.map((c) => c.videoId));
    if (!applied.ok) return;                   // question moved on — do nothing at all
  }

  const played = engine.playSubstitute();
  if (!played.ok) engine.exhaustRetries();
  broadcast(runtime);
}
```

   Critical detail: when `resolveRetrySearch` reports a stale retry, **return
   without broadcasting and without touching the engine** — the question has
   already moved on and the new question's state must not be disturbed.

5. Import `pickCandidates` from `./songmatch.js`, `MAX_SUBSTITUTION_ATTEMPTS`
   from `@setlist/shared`, and the `YouTubeSearchClient` type from
   `./youtube.js`.

### Step 7 — Wire it up at bootstrap

File: `packages/server/src/index.ts`.

```ts
import { loadRootEnv, readAppVersion, youtubeApiKey } from './env.js';
import { createYouTubeSearchClient } from './net/youtube.js';
…
const YT_KEY = youtubeApiKey();
const youtube = YT_KEY ? createYouTubeSearchClient({ apiKey: YT_KEY }) : null;
console.log(
  `[startup] song substitution: ${youtube ? 'enabled' : 'disabled (no YOUTUBE_API_KEY)'}`,
);
…
attachSocketServer(io, rooms, { youtube });
```

Note `loadRootEnv()` already runs at the top of the file, before this reads
`process.env` — keep that order.

### Step 8 — Client: receiver

File: `packages/client/src/common/store.ts`. Change the sender to pass the token:

```ts
reportPlaybackError(message: string, playToken?: number) {
  this.socket.emit('receiver:playbackError', { message, playToken });
}
```

File: `packages/client/src/receiver/YouTubePlayer.tsx`. The `onError` callback
is created inside a `useEffect(…, [])` that runs once, so it cannot close over
the current `playback`. Add a ref that the command effect keeps current:

```ts
const currentToken = useRef<number | null>(null);
// …inside the command effect, where lastToken.current is set:
currentToken.current = playback.playToken;
// …in onError:
store.reportPlaybackError(`${ERROR_MESSAGES[e.data] ?? 'Playback error'} (${e.data})`,
                          currentToken.current ?? undefined);
```

Do not otherwise restructure this component — the header comment explains why
the player is created exactly once, and the substitute arrives through the
existing `playToken`-change branch (`p.loadVideoById({...})`) with zero further
changes. Verify by reading that branch: it already keys purely on
`playback.playToken !== lastToken.current`, which the server bumps in
`playSubstitute()`.

File: `packages/client/src/receiver/App.tsx`, `PlayingTV` (~line 200). Replace
the single error line with a retry-aware pair, keeping the existing `.sub` class
and voice:

```tsx
{a.retrying && <div className="sub">🔎 Finding another version…</div>}
{!a.retrying && a.playbackError && <div className="sub">⚠️ {a.playbackError}</div>}
```

Also suppress the `<ClipBar …>` while `a.retrying` (it would be counting down a
clip that isn't playing) — render it only when `!a.retrying`.

### Step 9 — Client: player screens

File: `packages/client/src/player/screens.tsx`, `BuzzScreen`.

1. In the `disabled`/label ladder, insert a branch **before** the `!priv.canBuzz`
   branch (so the retry message wins over a generic disabled state):

```ts
} else if (active.retrying) {
  cls += ' out';
  label = '🔎 Finding another version…';
  disabled = true;
}
```

   Place it after the `lockedByMe` / `lockedBy` / `lockedOut` branches — a lock
   is a stronger statement than a retry, and the two can't co-occur anyway
   (retry only happens in PLAYING).

2. In the `nowplaying` card, mirror the receiver:

```tsx
{active.retrying && (
  <div className="banner small">🔎 That track won't play — finding another version…</div>
)}
{!active.retrying && active.playbackError && (
  <div className="banner small">This track won't play: {active.playbackError}</div>
)}
```

3. Leave the host Replay/Skip row untouched — the host keeps their escape hatch
   even mid-retry, and `skipQuestion()` already works from PLAYING regardless of
   `retrying`. (An in-flight search that resolves after the skip is neutralized
   by the `retryId` guard, because `skipQuestion` doesn't clear `active`… so
   also add to `playSubstitute()` the guard `if (this.room.phase !== 'PLAYING')
   return err('Not playing.')` — see Risks §6.)

### Step 10 — Tests (see §5 for the full matrix)

New/changed test files:

- `packages/server/src/net/__tests__/harness.ts` — add fake-client plumbing.
- `packages/server/src/net/__tests__/substitution.test.ts` — **new**, the four
  criterion-6 scenarios plus stale-result and cap tests.
- `packages/server/src/net/__tests__/songmatch.test.ts` — **new**, pure unit
  tests for the matcher.
- `packages/server/src/engine/__tests__/flow.test.ts` — extend the existing
  "surfaces a receiver playback error" test with retry-state assertions.
- `packages/server/src/net/__tests__/integration.test.ts` — the existing
  "surfaces a receiver playback error to the players" test must still pass
  **unmodified** (it runs with no `youtube` client ⇒ no substitution). Treat any
  change needed there as a regression signal, not a test to fix.
- `packages/client/src/player/__tests__/screens.test.tsx` — add a retry-state
  render test.

---

## 5. Testing & verification

**Commands, from `/home/eric/projects/setlist`:**

```bash
npm run typecheck    # shared + server + client
npm test             # server (vitest) + client (vitest)
npm run build        # shared -> client -> server; confirms the prod build
```

**Absolute rule: zero real network calls, zero real `YOUTUBE_API_KEY`.** Every
test injects a fake `YouTubeSearchClient`. Never construct
`createYouTubeSearchClient` in a test with a real key; if you want coverage of
the URL builder, pass a `fetchImpl` stub that returns a canned `Response`
(`new Response(JSON.stringify({items: […]}), { status: 200 })`).

### 5.1 Harness extension (house style)

`packages/server/src/net/__tests__/harness.ts` currently constructs
`RoomManager` + `attachSocketServer`. Extend `startTestServer`:

```ts
export interface FakeYouTube extends YouTubeSearchClient {
  queries: string[];
  results: YouTubeSearchResult[];
}
export function fakeYouTube(results: YouTubeSearchResult[] = []): FakeYouTube { … }

export async function startTestServer(opts: {
  bank?: QuestionBank;
  clipDurationSeconds?: number;
  youtube?: YouTubeSearchClient | null;   // NEW — default null = today's behavior
} = {}): Promise<TestServer>
```

Pass `opts.youtube ?? null` through to `attachSocketServer`. Defaulting to
`null` is what keeps every existing net test byte-identical in behavior.

Use `makeBank(...)` from `packages/server/src/engine/__tests__/harness.ts` (or a
local equivalent) when a test needs predictable titles like `Song 0-0` /
`Artist 0-0` to write matcher fixtures against. Follow the existing file style:
`beforeEach`/`afterEach` server lifecycle, `makeRoom(server.port, n)`,
`await tick()` between an emit and an assertion, `}, 20000)` timeouts.

### 5.2 Acceptance criteria → proof

| # | Criterion | Proof |
|---|---|---|
| 1 | Auto-search + play alternate, no host action | `substitution.test.ts` → "recovers on the first alternate": start game, select cell, note `receiver.priv.receiverPlayback.videoId` and `playToken`; emit `receiver:playbackError`; `await tick()`; assert the fake client received exactly one query equal to `` `${title} ${artist}` ``, that `receiver.priv.receiverPlayback.videoId` is now the first candidate, `playToken` incremented, `host.pub.active.retrying === false`, `host.pub.active.playbackError === null`, phase still `PLAYING`, and **no host emit occurred**. |
| 2 | Second alternate, then exactly today's fallback | "recovers on the second alternate": error → tick → error again (with the new `playToken`) → tick → assert `receiverPlayback.videoId` is candidate #2 and `retryAttempts` effect (videoId change) held. Then "exhausts both attempts": third error → tick → assert `retrying === false`, `playbackError === '<last message>'`, phase `PLAYING`, `receiverPlayback.videoId` unchanged from candidate #2, then `host.emit('question:skip', {})` ⇒ `{ok:true}` and phase `REVEAL` — i.e. the exact assertions of the existing integration test. |
| 3 | Unrelated result rejected | "rejects a result that isn't the same song": fake returns `[{title: 'Completely Different Song', channelTitle: 'Some Channel', …}]`; emit error; tick; assert `receiverPlayback.videoId` is **unchanged** (original), `retrying === false`, `playbackError` set ⇒ straight to the manual-Skip state. Plus direct unit coverage in `songmatch.test.ts`: accept `"Song 0-0 (Official Audio)"` by `"Artist 0-0 - Topic"`; reject `"Song 0-0 (Karaoke Version)"`, `"Totally Other Track"`, `"Song 0-0 — Live at Wembley"`, and a candidate whose videoId equals the original. |
| 4 | No buzzing during retry + visible indicator | Server half: in "recovers on the first alternate", use a fake client whose `searchVideos` returns a promise you resolve manually (a deferred). Between the error emit and resolution, assert `host.pub.active.retrying === true`, `guest.priv.canBuzz === false`, and `await guest.emit('buzz:press', {})` returns `{ok:false}`. Also assert the clip timer did not fire: with `clipDurationSeconds: 1` and a search deferred past 1.5s, phase must still be `PLAYING` (not `REVEAL`) — this proves the `reconcileTimer` suspension. Client half: `screens.test.tsx` renders `makePub({active: makeActive({retrying: true})})` and asserts the buzz button is disabled and `/Finding another version/` is in the document. |
| 5 | No videoId reaches a player socket | In every substitution test, after each broadcast assert `host.priv.receiverPlayback === null`, `guest.priv.receiverPlayback === null`, and `expect(JSON.stringify(host.pub)).not.toContain(candidateVideoId)` for **every** candidate id the fake returned (including rejected ones). Additionally extend `checkInvariants` in `packages/server/src/engine/__tests__/harness.ts`: it already asserts no bank videoId appears in the serialized public room — add the same assertion for `room.active?.substituteVideoId` when non-null. |
| 6 | Fully injectable, four scenarios, no network | The four `substitution.test.ts` cases above; the whole suite runs with `YOUTUBE_API_KEY` unset. Sanity check: `env -u YOUTUBE_API_KEY npm test` from the repo root must pass. |
| 7 | No regressions | `npm run typecheck && npm test` clean. Specifically: `integration.test.ts`'s "surfaces a receiver playback error to the players" and `flow.test.ts`'s "surfaces a receiver playback error on the active question" must pass **without edits to their existing assertions** (you may append new assertions to `flow.test.ts`, not change existing ones). |
| 8 | Docs | `git diff .env.example README.md` shows the Step-4 wording; `grep -n "not read by the Node server" .env.example README.md` returns nothing. |

### 5.3 Extra tests worth writing (cheap, high value)

- **Stale search result**: deferred fake search; while it's pending, drive the
  room forward (`question:skip` → `question:next` → `board:select` a different
  cell); *then* resolve the search. Assert the new question's
  `receiverPlayback.videoId` is its own bank videoId, `playToken` was not bumped
  by the stale resolution, and `retrying === false`. This is criterion-adjacent
  but is the highest-risk bug in the feature.
- **Cap enforced server-side**: emit `receiver:playbackError` five times in a
  row (with ticks); assert `searchVideos` was called exactly **once** and at
  most two distinct substitute videoIds were ever projected to the receiver.
- **Search failure = today's behavior**: fake whose `searchVideos` resolves `[]`
  (and a second one that rejects — the real client never rejects, but assert the
  orchestrator survives it anyway): assert the room lands in the manual-Skip
  state and Skip works.
- **No client configured**: `startTestServer()` with no `youtube` — assert
  `searchVideos` is never reachable and behavior is identical to today.

---

## 6. Risks & watch-outs

1. **The 2-attempt cap must be server-side.** It lives in one place:
   `beginRetry()`'s `active.retryAttempts >= MAX_SUBSTITUTION_ATTEMPTS` check,
   with `retryAttempts` incremented in `playSubstitute()` and reset only by
   `selectCell()` creating a fresh `active`. Nothing the receiver sends
   influences it. A receiver spamming `receiver:playbackError` must produce at
   most one search and at most two substitutes — test it explicitly.

2. **Stale/late search response (the big one).** A search that resolves after
   the host skipped, judged, or advanced must be a complete no-op. Two guards,
   both required: the `retryId` equality check in `resolveRetrySearch()`, and a
   `room.phase !== 'PLAYING'` check in `playSubstitute()` (the host can `Skip`
   into `REVEAL` while `active` still exists — `skipQuestion()` does not null
   `active`, so `retryId` alone would not catch that case). Also: `skipQuestion`
   and `clipExpired` should set `active.retrying = false` so a REVEAL screen
   never renders "finding another version…". Add that one line to each.

3. **Clip timer during the search.** `reconcileTimer` arms on
   `phase === 'PLAYING'`. Without the `!room.active.retrying` condition, a 20s
   clip that failed at second 19 would `clipExpired()` mid-search and reveal the
   answer. This is easy to miss because the default test `clipDurationSeconds`
   is 3600.

4. **Receiver must actually load the substitute.** Do not invent a new socket
   event or a new receiver code path. `playSubstitute()` bumps `playToken`;
   `toPrivateState` already re-projects `receiverPlayback` on every broadcast;
   `YouTubePlayer`'s command effect already branches on
   `playback.playToken !== lastToken.current` and calls `loadVideoById`. That
   chain is the entire delivery mechanism — verify it end to end in the net test
   by asserting the receiver's projected `videoId` and `playToken` both changed.

5. **Duplicate / late `onError`.** YouTube can fire `onError` more than once per
   load, and an error from the *previous* video can land after the substitute
   loaded. Both are handled: `reportPlaybackError` rejects when `active.retrying`
   is already true, and rejects a `playToken` older than the current one. Do not
   drop the optional-`playToken` plumbing in Step 8 — without it the second
   guard is inert.

6. **Fallback must be byte-identical to today.** After exhaustion the room must
   look exactly as it does now: `phase === 'PLAYING'`,
   `active.playbackError === '<the message>'`, `retrying === false`, host sees
   the banner and Skip. The existing `integration.test.ts` and `flow.test.ts`
   cases are the contract — they must pass unmodified. Likewise, with no API key
   the feature is entirely inert (`youtube === null` ⇒ `trySubstitute` is never
   called).

7. **Quota.** Search costs **100 units per call** against a 10,000/day default —
   ~100 failed songs/day. The 2-attempt cap plus search-once-per-question keeps
   this at one call per failed song. No further guardrails (explicitly out of
   scope). Do log each call so it's visible in `docker logs setlist-app-1`.

8. **Search latency stalls the game.** A slow search is dead air with buzzers
   cold. The client's `AbortSignal.timeout(5000)` bounds it; on timeout the room
   falls to manual Skip. Do not raise this above ~5s.

9. **Matcher over-rejection.** A too-strict threshold means the feature silently
   never helps. If real-world testing shows misses, tune the 0.7/0.5 thresholds
   — but never below 0.5/0.4, and never remove the reject-list: confidently
   playing a karaoke or cover version is worse than falling back to Skip.

10. **Spectator safety.** `toPublicRoom` builds its `active` object field by
    field; keep it that way. Never `...a` spread it, and never add
    `substituteVideoId` / `retryCandidates` to `PublicActiveQuestion`. The
    `checkInvariants` leak check in the engine test harness is the backstop —
    extend it (criterion 5) rather than trusting review.

11. **Shared package build order.** `@setlist/shared` resolves via its built
    `dist/`. After changing shared types, run `npm run build -w @setlist/shared`
    (or repo-root `npm run typecheck`, which handles ordering) before expecting
    server/client typecheck or tests to see the new fields.

---

## 7. Out of scope

Restated from the brief — do not do any of these:

- No changes to the offline Python builder (`scripts/questionbank/build_bank.py`)
  or its embeddable pre-check.
- No build-time / bank-build-time detection of domain-restricted embedding — it
  is structurally impossible without a real browser on the real origin.
- No manual "try another version" host button. Substitution is fully automatic,
  triggered only by a real playback failure.
- No changes to scoring, the buzz race, or judging.
- No retry-budget or rate-limiting system beyond the per-question 2-attempt cap.
- No new HTTP-client dependency and no fuzzy-matching dependency — global
  `fetch` and the hand-rolled `songmatch.ts` only.
- No Docker/Cloudflare/deployment changes: this is a code change plus the normal
  `docker compose up -d --build` redeploy.
