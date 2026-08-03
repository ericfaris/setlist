# Host-Playback Setlist Mode — Implementation Plan

> Executor note: this file is self-contained. Read it end to end before touching
> code. Every path is absolute-from-repo-root (`/home/eric/projects/setlist`).
> The repo is a live, deployed app; the working tree is clean at commit `8da8d1e`.

---

## 1. Summary

Setlist today is a Jeopardy-board music-trivia game: the TV receiver embeds a
YouTube IFrame player and plays a 20-second clip of the song behind whichever
board square the host picked. Real gameplay found that ~85% of songs fail with
"Embedding disabled by the owner" — YouTube's **per-domain embed allowlist**,
which no offline API check can detect (the `status.embeddable` flag only covers
the global per-video setting). The previous session built a 3-attempt runtime
substitution system (`songmatch.ts` / `youtube.ts` / `beginRetry` …) to fight
this; it helps but does not fix the root cause, because embedding is simply
unreliable for a large share of real music content.

This change sidesteps the problem entirely: **the host plays the song themselves
via a native `https://music.youtube.com/watch?v=<videoId>` link.** YouTube's own
app/site has no embed restrictions at all, so every song plays, every time. Our
app never embeds anything, so there is nothing left to substitute around. The
user also asked, independently and firmly, for the Jeopardy board to go away
("the board needs to go away no matter what") in favour of a flat, theme-labelled
**setlist** the host browses on their phone — reducing the app to what they
described as **"essentially this just becomes a scorekeeper"**: room management, a
fair server-timestamped buzz race, and score tracking. The board, the point
ladder, the clip timer, the receiver's YouTube player and the whole substitution
system are **deleted** (not feature-flagged, not left inert). The TV keeps room
code, QR, scoreboard and buzz-lock status, and plays no media ever again.

---

## 2. Approach & key decisions

Each of the brief's "still open for the planner" items is resolved here. These
are decisions, not suggestions — implement them as written.

### 2.1 The new state machine

```
LOBBY --game:start--> SETLIST --setlist:start--> ARMED --(first buzz)--> LOCKED
                         ^                         |                       |
                         |     question:reveal     v      judge:answer     v
                         +---------------------- REVEAL <-----------------+
                                                   | (question:next)
                                                   v
                            every song used --> GAME_OVER   (also: host:forceEnd
                                                             from any phase)
PAUSED: orthogonal, unchanged (host/cast drop), restores phaseBeforePause.
```

| Old | New | Why |
|---|---|---|
| `BOARD` | `SETLIST` | host is browsing/choosing; no question exists yet |
| `PLAYING` | `ARMED` | nothing plays in our app any more; the phase means "buzzers are live" |
| `LOCKED` | `LOCKED` | unchanged semantics |
| `REVEAL` | `REVEAL` | unchanged semantics |
| `GAME_OVER`, `LOBBY`, `PAUSED` | unchanged | |

`IN_PROGRESS_PHASES` in `engine.ts` becomes `['SETLIST', 'ARMED', 'LOCKED', 'REVEAL']`.

### 2.2 Cueing is client-local; "Start" is the only server intent

The host's two-step (tap a song → see title/artist + YT Music link → tap Start)
is deliberately **not** two server round-trips. The host's `PrivateState` carries
the whole setlist (titles, artists, videoIds) while in `SETLIST`, so tapping a
song is pure client state in the host's browser. Only **Start** hits the server,
as `setlist:start` with the chosen song id.

Rationale:

- Acceptance criterion 3 ("buzzing is not live merely from having tapped a song")
  becomes *structurally* true — there is no server state between tap and Start.
- Tapping the YT Music link backgrounds the browser (or opens a new tab). A
  server-side "cued" phase could get stranded there if the host never comes back;
  client-local state simply survives backgrounding, and a hard reload just returns
  the host to the setlist to re-tap. Nothing can get stuck.
- Fewer phases, no cancel-selection path, no new race between cue and disconnect.

The TV and other players see the same thing throughout `SETLIST`: "🎧 *Host* is
choosing a song…" plus the live scoreboard. They get no signal that a song has
been cued — which is correct, since a cued song is the answer.

### 2.3 Flat point value: a constant, not a setting

`SONG_POINT_VALUE = 100` exported from `packages/shared/src/types.ts`. Title
correct = **+50**, artist correct = **+50**, both = **+100**, both wrong =
**−50** when `settings.penalizeWrongAnswers` is on (default on). This reuses the
existing `V/2 + V/2` judge logic verbatim with a constant `V`.

Not a `RoomSettings` field: the brief leans that way for v1, a wager system is
explicitly out of scope, and with a flat value the absolute number is arbitrary —
only ratios matter. A future settings field is a one-line change if wanted.
`PublicActiveQuestion.value` is kept (always `SONG_POINT_VALUE`) so the reveal
screens can show the delta without importing the constant.

### 2.4 Host actions — exact wording

Host phone, `SETLIST` phase, song **not** cued:

- Header: `Pick a song`
- Sections are the bank categories, rendered as sticky-ish headers with a count:
  `80s Bangers · 4 left`
- Rows: `<b>Title</b>` on line 1, `muted Artist` on line 2. An already-played row
  is dimmed, non-tappable, and suffixed `✓ played`.
- A search input at the top (`Search songs or artists`) filters rows across all
  sections case-insensitively on title+artist. Sections with no matches hide.
- Footer button: `🏁 End game & show scores` (calls `store.forceEnd()`), styled
  `ghost small`. This is important: with a 36–64-song bank, "all songs used" is
  effectively unreachable, so the host needs an explicit way to finish.

Host phone, `SETLIST` phase, song cued (client-local panel replacing the list):

- `<b>Title</b>` / `muted Artist` / `small muted Section title`
- Primary link, rendered as an `<a class="primary" target="_blank" rel="noopener noreferrer">`:
  `▶ Open in YouTube Music`
- Primary button: `🔔 Start round — arm buzzers` → `store.startSong(songId)`
- Ghost button: `← Back to setlist` (clears the local cue; no server call)
- Helper line: `small muted` — `Play it out loud first, then arm the buzzers.`

Host phone, `ARMED` phase, nobody buzzed:

- Button: `🔎 Nobody got it — reveal` → `store.revealQuestion()`

Host phone, `LOCKED` phase: the existing `HostJudge` panel, with its secondary
button relabelled from `Skip question` to `Reveal & move on` (same
`store.revealQuestion()` call).

Non-host phones during `SETLIST`: card reading `🎧 <Host> is choosing a song…`
plus `ScoreStrip`. During `ARMED`: the buzzer, with the "now playing" card
reduced to the section title and `Name that song… and the artist!` (**never**
the title/artist — see §7.1).

TV during `SETLIST`: `brand` = `SETLIST`, centre `🎧`, sub =
`<Host> is choosing a song…`, plus `Scores` and the persistent mini join QR.
TV during `ARMED`: centre `🎧`, sub `Name that song… and the artist!`, and a
`sub` line `🔔 Buzzers live`. On `LOCKED`: `huge` = `🔒 <name>`.

### 2.5 "Already played" tracking

The engine builds a `SetlistState` once, in `start()`, by flattening the bank:
every category becomes a **section**, every question becomes a **song** with an
opaque positional id and a `used: boolean` — the direct replacement for
`BoardCell.used`. `setlist:start` sets `used = true` (same place the old
`selectCell` did) and refuses an already-used song. `rematch()` clears the
setlist (rebuilt on the next `start()`), so a rematch replays everything.

Songs are deduped by `videoId` while flattening (first section wins) so a bank
where the AI categoriser placed one track in two themes can't offer the same song
twice. Order is **bank order**, not shuffled — the host is deliberately browsing,
and a stable order is far friendlier than a reshuffle. Section labels come
straight from `BankCategory.title` (that is the brief's "categories become
setlist section labels").

Song ids are **opaque and positional** — `s<sectionIndex>q<indexWithinSection>`,
e.g. `s0q3` — exactly like the old `c0r2` cell ids, and for exactly the same
reason: the id appears in the public projection (`PublicActiveQuestion.songId`),
and deriving it from the bank id (`q_<videoId>`) would put a videoId on the wire.
Do not "simplify" this to the bank id.

### 2.6 GAME_OVER logic: unchanged

`endGame()` / winner-by-max-score / ties-all-win carries over verbatim.
`nextQuestion()` ends the game when **every setlist song is used** (replacing
"every board cell used"); in practice `host:forceEnd` — now reachable from a real
button (§2.4) — is the normal ending. No other change.

### 2.7 Host exclusion from buzzing

`buzz()` and `canBuzz()` reject a player who is **either**:

1. the room's current host, **or**
2. `active.pickedByPlayerId` — the player who armed this round.

Case 2 exists because the crown can move mid-round (host disconnect ⇒
`transferHostOnDisconnect`). The demoted ex-host has seen the setlist, including
this song's answer, and would otherwise become buzz-eligible the instant they are
demoted. `pickedByPlayerId` closes that. See §7.2 for the residual risk.

Error string: `"The host doesn't buzz on this one."`

Two knock-on rules that are easy to miss:

- `judge()`'s "everyone has now guessed wrong ⇒ auto-reveal" check computes
  `stillIn`. It must exclude the host and the picker, or a 2-player game (host +
  one guest) hangs in `ARMED` forever after the guest's wrong answer.
- `disconnect()` has the same `stillIn` check for `phase === 'ARMED'`. Same fix.
  Factor this into one private helper, `eligibleBuzzers(active)`, used by
  `canBuzz`, `judge` and `disconnect`.
- `MIN_PLAYERS` goes from `1` to `2` — a solo game now has nobody who can buzz.
  `start()` error: `"Need at least 2 players — the host doesn't buzz."`

### 2.8 Python builder's `--youtube-api-key` embeddable pre-check

**Keep the code and its unit tests; stop running it by default.** The functions
(`check_embeddable`, `filter_embeddable`) are well-tested, self-contained and
harmless — deleting them is pure churn. But leaving the flag defaulting to
`os.environ.get("YOUTUBE_API_KEY")` is now actively *harmful*: it silently drops
songs that are non-embeddable but play perfectly in YouTube Music, shrinking the
bank for no benefit. So: change the argparse default to `None`, so the check runs
only when someone passes `--youtube-api-key` explicitly, and update the help text
and the end-of-run summary line to say so.

---

## 3. Data / model / API changes

### 3.1 `packages/shared/src/types.ts`

**Remove:** `BoardCell`, `BoardCategory`, `BoardState`, `BOARD_ROWS`,
`BOARD_COLUMNS`, `POINT_VALUES`, `MAX_SUBSTITUTION_ATTEMPTS`,
`DEFAULT_CLIP_START_SECONDS`, `DEFAULT_CLIP_DURATION_SECONDS`,
`GameRoom.board`, and every retry/substitution/clip field on `ActiveQuestion`
(`startSeconds`, `durationSeconds`, `playToken`, `playbackError`, `timedOut`,
`retrying`, `retryAttempts`, `retryCandidates`, `substituteVideoId`, `retryId`,
`lastPlaybackErrorMessage`).

**Add / change:**

```ts
export type RoomPhase =
  | 'LOBBY'
  | 'SETLIST'    // host is browsing/choosing the next song
  | 'ARMED'      // host has started the round; buzzers are live
  | 'LOCKED'     // someone buzzed; host judges
  | 'REVEAL'
  | 'GAME_OVER'
  | 'PAUSED';

/** One bank category, flattened into a setlist section header. */
export interface SetlistSection {
  index: number;
  id: string;    // BankCategory.id
  title: string; // BankCategory.title — the theme label the host browses by
}

/** SERVER-ONLY in full: `question` carries the answer and the videoId. */
export interface SetlistSong {
  /** Opaque + positional (`s<section>q<index>`). NEVER derived from the bank id. */
  id: string;
  sectionIndex: number;
  question: BankQuestion;
  used: boolean;
}

export interface SetlistState {
  sections: SetlistSection[];
  songs: SetlistSong[];
}

export interface ActiveQuestion {
  songId: string;
  sectionIndex: number;
  /** SERVER-ONLY (title/artist are the answer; videoId is a spoiler). */
  question: BankQuestion;
  /** Who armed this round. Permanently ineligible to buzz on it (see plan §2.7). */
  pickedByPlayerId: string;
  startedAt: number;             // ms epoch when ARMED began
  lockedPlayerId: string | null;
  lockedAt: number | null;       // SERVER clock, always
  lockedOutPlayerIds: string[];
  verdict: JudgeVerdict | null;
  awarded: number;
  revealed: boolean;
}

export interface GameRoom {
  code: string;
  phase: RoomPhase;
  settings: RoomSettings;
  players: Player[];
  setlist: SetlistState | null;  // null while in LOBBY
  active: ActiveQuestion | null;
  winnerPlayerIds: string[];
  castConnected: boolean;
  createdAt: number;
  phaseBeforePause: RoomPhase | null;
  pause: PauseState;
}

export const SONG_POINT_VALUE = 100;
export const MIN_PLAYERS = 2;   // the host never buzzes
export const MAX_PLAYERS = 10;  // unchanged
```

`Player`, `RoomSettings`, `PauseState`, `JudgeVerdict` are unchanged.

### 3.2 `packages/shared/src/questions.ts`

Unchanged except:

- Add the one-liner every surface needs:
  ```ts
  /** Native YT Music deep link. No embed restrictions apply — this is the whole
   *  point of the setlist redesign. */
  export function youtubeMusicUrl(videoId: string): string {
    return `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  }
  ```
- Update the `BankQuestion.value` doc comment: the engine now ignores it entirely
  (flat `SONG_POINT_VALUE`); it stays in the file because the builder writes it.
  The validator still requires it — **do not** relax `validateQuestionBank`, the
  bank format is unchanged on disk.
- Update `BankQuestion.videoId`'s comment: it is no longer "receiver-only", it is
  now **host-only** (the host needs it to build the YT Music link; the receiver
  never sees it again).

### 3.3 `packages/shared/src/projection.ts`

**Remove:** `ReceiverPlayback`, `PrivateState.receiverPlayback`, the `retrying`
/ `playbackError` / `timedOut` / `durationSeconds` / `cell` fields on
`PublicActiveQuestion`, and `PublicRoom.board`.

```ts
export interface PublicActiveQuestion {
  songId: string;              // opaque; carries no song data
  sectionTitle: string;        // the theme label — public, like the old category header
  value: number;               // always SONG_POINT_VALUE
  startedAt: number;
  lockedPlayerId: string | null;
  lockedOutPlayerIds: string[];
  verdict: JudgeVerdict | null;
  awarded: number;
  revealed: boolean;
  answer: PublicAnswer | null; // null until revealed === true — the one secret left here
  // NOTE: no videoId, no title/artist pre-reveal. Built field by field, never `...a`.
}

export interface PublicRoom {
  code: string;
  phase: RoomPhase;
  settings: RoomSettings;
  players: PublicPlayer[];
  active: PublicActiveQuestion | null;
  /** Progress only — counts, never song data. */
  songsTotal: number;
  songsRemaining: number;
  winnerPlayerIds: string[];
  castConnected: boolean;
  pause: PauseState;
  serverNow: number;
}

/** HOST-ONLY. The host legitimately knows every song — they have to pick and
 *  play them. This must never be projected onto a non-host socket. */
export interface HostSetlistSong {
  id: string;
  title: string;
  artist: string;
  videoId: string;
  used: boolean;
}
export interface HostSetlistSection {
  title: string;
  songs: HostSetlistSong[];
}

export interface PrivateState {
  playerId: string | null;
  reconnectToken: string | null;
  isHost: boolean;
  score: number;
  canBuzz: boolean;
  /** Host-only. Now populated from the moment the round is ARMED (the host picked
   *  the song, so hiding it is pointless) — but still ONLY for the host socket. */
  hostAnswer: PublicAnswer | null;
  /** Host-only, and only while phase === 'SETLIST'. Null for everyone else, always. */
  setlist: HostSetlistSection[] | null;
}
```

Rewrite the file's header comment: the three secrets become **two** —
(1) the answer, hidden from everyone but the host until `revealed`; (2) the
setlist's song data (titles/artists/videoIds), host-socket-only. There is no
receiver secret any more; the receiver is now the *least* privileged surface.

### 3.4 `packages/shared/src/protocol.ts` — Socket.IO events

| Event | Change |
|---|---|
| `board:select` | **removed** |
| `playback:replay` | **removed** |
| `receiver:playbackError` | **removed** |
| `question:skip` | **renamed** to `question:reveal` (same `(_, ack)` shape) |
| `setlist:start` | **new**: `(payload: { songId: string }, ack: (res: Ack<{}>) => void) => void` — host-only: `SETLIST -> ARMED` |
| everything else | unchanged (`host:create`, `host:castStatus`, `room:join`, `receiver:subscribe`, `receiver:standby`, `game:start`, `game:settings`, `host:transfer`, `buzz:press`, `judge:answer`, `question:next`, `host:forceEnd`, `host:rematch`; all `ServerToClient` events; `SOCKET_PATH`; `CAST_NAMESPACE`) |

Update the `game:start` doc comment: `LOBBY -> SETLIST`. Update `judge:answer`:
`LOCKED -> ARMED (wrong) | REVEAL (right)`.

### 3.5 Bank → setlist mapping

`QuestionBank.categories[i]` → `SetlistSection { index: i, id, title }`.
`categories[i].questions[j]` → `SetlistSong { id: 's<i>q<j>', sectionIndex: i,
question, used: false }`, skipping any question whose `videoId` was already
emitted. No minimum-songs-per-category filter (the old `>= BOARD_ROWS` gate is
gone — every section, however small, is browsable). `start()` fails only if the
flattened list is empty: `"The question bank has no songs."`

---

## 4. Step-by-step tasks

Do them in this order; `npm run typecheck` after every server/shared step (the
shared package must be rebuilt for the others to see it — see §5.0).

### Task 1 — shared types (`packages/shared/src/types.ts`)

Apply §3.1 exactly. Delete the board/clip/substitution constants and types, add
`RoomPhase`'s new members, `SetlistSection`/`SetlistSong`/`SetlistState`, the new
`ActiveQuestion`, `SONG_POINT_VALUE`, and change `MIN_PLAYERS` to `2`. Rewrite the
file header comment to describe the setlist model. Everything downstream will
fail to compile until Tasks 2–9 land; that is expected.

### Task 2 — shared projection (`packages/shared/src/projection.ts`)

Apply §3.3 exactly, including the rewritten header comment.

### Task 3 — shared protocol (`packages/shared/src/protocol.ts`)

Apply §3.4. Also add `youtubeMusicUrl` + comment updates to
`packages/shared/src/questions.ts` per §3.2. `packages/shared/src/index.ts`
needs no change (it re-exports `*` from all four files).

### Task 4 — engine rewrite (`packages/server/src/engine/engine.ts`)

This is the primary file. Keep everything about join / reconnect / settings /
cast / host transfer / pause / resume / disconnect-grace **exactly as it is** —
it is a stable foundation, not part of this redesign.

**Delete:** `layOutBoard()`, `selectCell()`, `clipExpired()`, `replayClip()`,
`reportPlaybackError()`, `beginRetry()`, `resolveRetrySearch()`,
`playSubstitute()`, `exhaustRetries()`, `resolveStartSeconds()`,
`categoryTitle()`, the `BeginRetryResult` type, `makeRetryId()`/`retryIdSeq`,
the `clipStartSeconds`/`clipDurationSeconds` constructor deps and fields, and
the `private questions = new Map<string, BankQuestion>()` map (the setlist now
holds the questions directly, still off `GameRoom`… see below).

**Question storage:** `GameRoom.setlist.songs[].question` is a `BankQuestion` and
therefore *does* live on the room object, unlike the old design where answers were
deliberately kept in a side map. That is safe **only** because `toPublicRoom`
no longer projects the setlist at all (`PublicRoom` has no setlist field — just
`songsTotal`/`songsRemaining` counts). Keep it that way: never add a setlist field
to `PublicRoom`. The harness leak assertions (Task 12) enforce this.

**Add / change:**

- `IN_PROGRESS_PHASES = ['SETLIST', 'ARMED', 'LOCKED', 'REVEAL']`.
- `start(hostId)`: same host/phase/cast/player-count gates, but
  `MIN_PLAYERS` is now 2 with the new message; then `this.room.setlist =
  this.buildSetlist()`; fail with `'The question bank has no songs.'` if it has
  zero songs; `phase = 'SETLIST'`.
- `private buildSetlist(): SetlistState | null` — flatten per §3.5, dedupe by
  `videoId`, bank order preserved, no RNG. (The room RNG is now used only by
  `RoomManager.generateCode`; leave `rng.ts` and the `rng` dep in place — it
  costs nothing and removing it churns the constructor and every test harness.)
- `startSong(hostId: string, songId: string): EngineResult` — the replacement for
  `selectCell`:
  - `'Only the host can start a song.'` if not host
  - `'Not choosing a song right now.'` if phase !== `'SETLIST'`
  - `'No setlist.'` if `room.setlist` is null
  - `'No such song.'` if the id doesn't resolve
  - `'That song has already been played.'` if `song.used`
  - then: `song.used = true`; build `ActiveQuestion` with `songId`,
    `sectionIndex`, `question`, `pickedByPlayerId: hostId`,
    `startedAt: this.now()`, nulls/empties for the lock fields, `awarded: 0`,
    `revealed: false`; `phase = 'ARMED'`.
- `private eligibleBuzzers(active: ActiveQuestion): Player[]` — active (non-pending),
  connected players who are neither the current host nor `active.pickedByPlayerId`
  and are not in `lockedOutPlayerIds`.
- `buzz(playerId)`: keep the lock guard first (`'Already locked in.'`), then
  `phase !== 'ARMED'` ⇒ `'Buzzers are not armed.'`, then the new host/picker check
  ⇒ `'The host doesn\'t buzz on this one.'`, then the existing
  no-such-player / disconnected / pendingJoin / already-guessed checks. Drop the
  `active.retrying` check. `lockedAt = this.now()` stays server-clock.
- `canBuzz(playerId)`: mirror `buzz`'s rules — `phase === 'ARMED'`, no lock, not
  the host, not the picker, not locked out, connected, not pendingJoin.
- `judge(hostId, verdict)`: identical except `const value = SONG_POINT_VALUE`
  (was `active.cell.value`), the wrong-on-both branch returns to `'ARMED'`
  (was `'PLAYING'`) **without** bumping any play token or re-stamping `startedAt`
  (there is nothing to restart), and the "nobody left" check uses
  `eligibleBuzzers(active).length === 0`.
- `revealQuestion(hostId)` — rename of `skipQuestion`, same body minus the
  `retrying` line: valid in `'ARMED'` or `'LOCKED'`, clears the lock, sets
  `revealed = true`, `phase = 'REVEAL'`. Errors: `'Only the host can reveal the
  answer.'` / `'No song in play.'`
- `nextQuestion(hostId)`: unchanged except `allUsed` reads
  `(this.room.setlist?.songs ?? []).every((s) => s.used)` and the non-end branch
  goes to `'SETLIST'`.
- `rematch(hostId)`: `this.room.setlist = null` instead of `board = null`; drop
  the `this.questions = new Map()` line.
- `disconnect(playerId)`: the "last person able to answer" block guards on
  `phase === 'ARMED'` and uses `eligibleBuzzers(active).length === 0`.
- `activeQuestion()` unchanged. Add
  `setlistFor(playerId): HostSetlistSection[] | null` **or** keep that shaping in
  `project.ts` — either is fine; §3.3's field is what matters. Prefer
  `project.ts` so all projection logic stays in one file.
- Update the file-header ASCII state diagram to §2.1's.

### Task 5 — projection (`packages/server/src/engine/project.ts`)

- `toPublicRoom`: drop `board`, drop the removed active fields, emit `songId`,
  `sectionTitle` (from `room.setlist?.sections[a.sectionIndex]?.title ?? ''`),
  `value: SONG_POINT_VALUE`, and the new `songsTotal` / `songsRemaining` counts
  (`songs.length` / `songs.filter(s => !s.used).length`, `0`/`0` when the setlist
  is null). Keep the field-by-field construction and its comment — do **not**
  spread `...a` or `...room`.
- `toPrivateState`: drop `opts.isReceiver` and all `receiverPlayback` logic
  (delete `PrivateOpts` entirely; callers stop passing it). Then:
  ```ts
  const isHost = p?.isHost ?? false;
  // NEW: the host picked the song, so they legitimately know it from the moment
  // the round is armed — but still ONLY on the host's own socket.
  const hostAnswer = isHost && a ? { title: a.question.title, artist: a.question.artist } : null;
  // Host-only, and only while browsing: the full setlist, answers and all.
  const setlist =
    isHost && room.phase === 'SETLIST' && room.setlist
      ? toHostSetlist(room.setlist)
      : null;
  ```
  where `toHostSetlist` groups `songs` by `sectionIndex` into
  `HostSetlistSection[]` (section order = `sections` order; a section with zero
  songs after dedupe is omitted). The `!playerId` early-return branch (receiver
  sockets) returns `hostAnswer: null, setlist: null` — the receiver is now the
  least-privileged surface in the system.
- Rewrite the file header: two secrets, not three (§3.3).

### Task 6 — delete the substitution layer

Delete outright:

- `/home/eric/projects/setlist/packages/server/src/net/songmatch.ts`
- `/home/eric/projects/setlist/packages/server/src/net/youtube.ts`
- `/home/eric/projects/setlist/packages/server/src/net/__tests__/songmatch.test.ts`
- `/home/eric/projects/setlist/packages/server/src/net/__tests__/substitution.test.ts`

Remove `youtubeApiKey()` from `/home/eric/projects/setlist/packages/server/src/env.ts`
(keep `rootEnvPath`, `loadRootEnv`, `rootPackageJsonPath`, `readAppVersion`).

### Task 7 — net layer (`packages/server/src/net/server.ts`)

- Drop the `pickCandidates` / `YouTubeSearchClient` imports, the
  `MAX_SUBSTITUTION_ATTEMPTS` import, the `opts.youtube` option and the `youtube`
  local, `CLIP_TIMER_PAD_MS`, `reconcileTimer()` (and its call at the end of
  `broadcast`), and `trySubstitute()` entirely.
- `broadcast()` keeps the two loops but the receiver loop now calls
  `toPrivateState(runtime.engine, null)` with no opts — receivers get the same
  unprivileged private state as an unseated socket. (Keep the loop: receivers
  still need `you:state` to exist for store shape consistency, and
  `runtime.receivers` is still used by `closeIfEmpty` and cast tracking.)
- Delete the `receiver:playbackError`, `board:select` and `playback:replay`
  handlers.
- Rename the `question:skip` handler to `question:reveal` →
  `rt.engine.revealQuestion(hostId)`.
- Add:
  ```ts
  socket.on('setlist:start', ({ songId }, ack) => {
    acked(ack, (rt, hostId) => rt.engine.startSong(hostId, songId));
  });
  ```
- Keep `withPlayer` / `acked` / `runtimeForSocket` / `standbyReceivers` / the
  whole `disconnect` handler and its grace-timer machinery byte-for-byte.

### Task 8 — room registry (`packages/server/src/net/rooms.ts`)

- Remove `RoomRuntime.timer` and the `if (r?.timer) clearTimeout(r.timer)` line
  in `close()`.
- Remove `RoomManagerOptions` (`clipStartSeconds` / `clipDurationSeconds`) and
  stop passing them to `new GameEngine`. `RoomManager`'s constructor keeps the
  bank; drop the now-empty options param (or keep it as `{}` — prefer dropping
  it and updating the two call sites: `index.ts` and the net test harness).
- Leave `pendingCastCode`, `closeIfEmpty`, `ROOM_EMPTY_GRACE_MS`,
  `generateCode`, `disconnectGraceTimers` untouched.

### Task 9 — server bootstrap (`packages/server/src/index.ts`)

- Drop the `createYouTubeSearchClient` import, the `youtubeApiKey` import, the
  `YT_KEY`/`youtube` block and its `console.log`, and the `{ youtube }` arg to
  `attachSocketServer(io, rooms)`.
- Drop `DEFAULT_CLIP_*` imports and the `CLIP_START_SECONDS` /
  `CLIP_DURATION_SECONDS` env reads and their `RoomManager` options.
- Everything else (Express, `/api/config`, `/api/health`, the versioned
  `/receiver.html` redirect, Socket.IO ping tuning) is unchanged.

### Task 10 — receiver UI

- **Delete** `/home/eric/projects/setlist/packages/client/src/receiver/YouTubePlayer.tsx`.
- `/home/eric/projects/setlist/packages/client/receiver.html`: remove the
  `<script src="https://www.youtube.com/iframe_api">` tag, the `#yt-stage` /
  `#yt-player` / `.ytshield` div block and its explanatory comment. **Keep** the
  Cast receiver framework script, the `#root` div, the module script, and both
  inline scripts (the `/api/cast-room` poller and whatever follows) exactly as
  they are — that is the Cast handshake and it is out of scope.
- `/home/eric/projects/setlist/packages/client/src/receiver/App.tsx`:
  - Drop the `YouTubePlayer` import and its always-mounted element; drop
    `BoardGrid` and `ClipBar` imports.
  - Replace `BoardTV` with `SetlistTV` (per §2.4): `brand` = `SETLIST`, a centred
    `🎧` + `<Host> is choosing a song…`, a `muted` progress line
    `{pub.songsRemaining} of {pub.songsTotal} songs left`, then `<Scores/>`. Keep
    the `playOneShot('/sounds/board.mp3')` mount effect — it is a good "new round"
    cue.
  - Replace `PlayingTV` with `ArmedTV`: `brand` = `a.sectionTitle`, right-hand
    `brand` = `{a.value} pts`; centre shows `🔒 <name>` when
    `pub.phase === 'LOCKED'`, else `🎧` + `Name that song… and the artist!` +
    a `sub` line `🔔 Buzzers live`. No `ClipBar`, no playback error, no retry line.
  - `RevealTV`: drop `a.cell` usage; header becomes `a.sectionTitle` / `{a.value} pts`.
    Replace the `a.timedOut` sound trigger with
    `if (!a.lockedPlayerId && !a.verdict) playOneShot('/sounds/times-up.mp3')`
    (nobody got it), keyed on `a.songId` so it fires once per question.
  - `LobbyTV`, `GameOverTV`, `PausedTV`, `MiniJoinQr`, `VersionTag`, `Scores`:
    unchanged. Update the phase router (`BOARD` → `SETLIST`, `PLAYING` → `ARMED`).
- `/home/eric/projects/setlist/packages/client/src/receiver/main.tsx`: unchanged.

### Task 11 — player UI

`/home/eric/projects/setlist/packages/client/src/common/store.ts`:

- Remove `selectCell`, `replayClip`, `reportPlaybackError`.
- Rename `skipQuestion` → `revealQuestion` (emits `question:reveal`).
- Add `async startSong(songId: string): Promise<boolean>` emitting `setlist:start`
  with `{ songId }`, error-toasting on failure like its siblings.
- Everything else (reconnect-on-`connect` logic, localStorage keys,
  `receiverStandby` / `receiverSubscribe` and the `__castPollTimer` clear)
  is untouched. **Do not** modify the reconnect or cast paths.

`/home/eric/projects/setlist/packages/client/src/common/ui.tsx`:

- Delete `BoardGrid`, `ClipBar`, `useClipProgress`, `useNow` (nothing else uses
  them once `ClipBar` is gone — verify with a grep before deleting `useNow`).
- Keep `nameOf`.
- Add `SetlistBrowser` here (shared vocabulary, one place) or keep it inside
  `screens.tsx` — either is acceptable; `screens.tsx` is fine since the TV never
  renders it.

`/home/eric/projects/setlist/packages/client/src/player/screens.tsx`:

- Delete `BoardPick`. Add `SetlistScreen` for the `SETLIST` phase:
  - Non-host: a card `🎧 <Host> is choosing a song…` + `ScoreStrip`.
  - Host, no local cue: search box + sections + song rows + `🏁 End game & show
    scores` (§2.4), driven off `priv.setlist`. If `priv.setlist` is null (e.g. a
    stale projection), render `Loading setlist…` rather than crashing.
  - Host, cued (local `useState<HostSetlistSong | null>`): the cue panel of §2.4,
    with the `<a href={youtubeMusicUrl(song.videoId)} target="_blank"
    rel="noopener noreferrer">` link and the `🔔 Start round — arm buzzers`
    button calling `store.startSong(song.id)`. Clear the local cue in an effect
    when `pub.phase !== 'SETLIST'`, so returning to the setlist after a round
    starts from the list, not a stale panel.
- `BuzzScreen`: drop `ClipBar`, the `retrying` branch and the `playbackError`
  banner; the header card shows `active.sectionTitle` and a `{active.value} pts`
  pill plus a `small muted` line `Name that song… and the artist!`. Host controls
  under it become: `pub.phase === 'LOCKED'` ⇒ `<HostJudge/>`;
  `pub.phase === 'ARMED'` ⇒ a single `🔎 Nobody got it — reveal` button. The
  buzz button itself, its `onPointerDown`, the optimistic `sent` state and the
  locked/locked-out label logic are unchanged **except**: add a branch for the
  host (and, defensively, for `priv.playerId === ...` when `!priv.canBuzz` and the
  player is the host) rendering label `👑 You're hosting this one` with the
  `out` class, disabled — so the host isn't staring at a dead red button.
- `HostJudge`: unchanged behaviour, but note the answer is now available from the
  start of the round. **Keep the tap-to-reveal gate** — it stops the host's own
  screen from spoiling the answer to a buzzer reading over their shoulder, and it
  costs nothing. Relabel the secondary button `Skip question` → `Reveal & move on`
  and point it at `store.revealQuestion()`. Key the local `revealedFor` state off
  `active.songId` (was `${cell.categoryIndex}:${cell.rowIndex}`).
- `Reveal`: header becomes `{active.sectionTitle} · {active.value} pts`; rest
  unchanged.
- `Lobby`, `GameOver`, `Paused`, `ScoreStrip`: unchanged.

`/home/eric/projects/setlist/packages/client/src/player/App.tsx`:

- Phase router: `BOARD` → `SETLIST` (renders `SetlistScreen`), `PLAYING` →
  `ARMED`. Everything else (landing/host/join flows, Cast init, `TvStatusStrip`,
  `useWakeLock`, `VersionTag`) unchanged.
- Update the tagline `Buzz in on your phone · board on the TV` →
  `Buzz in on your phone · scores on the TV`.

`/home/eric/projects/setlist/packages/client/src/common/styles.css`:

- Delete `.board`, `.board .cathead`, `.cell`, `button.cell:hover`, `.cell.used`,
  `.tv .board*`, `.tv .cell`, `.clipbar` (+ `.tv .clipbar`), `.ytstage`,
  `.ytshield`, `.audiocover`, and the now-unused `--jeopardy` variable.
- Add a compact setlist list style: `.setlist` (flex column, gap 4),
  `.setlist .sechead` (small, uppercase, muted, sticky top 0), `.setlist .song`
  (full-width button, left-aligned, two-line, `padding: 10px 12px`),
  `.setlist .song.used` (opacity .4, `cursor: default`). Keep it modest — this is
  a phone list, not a design exercise.

### Task 12 — engine tests

`/home/eric/projects/setlist/packages/server/src/engine/__tests__/harness.ts`:

- Drop `BOARD_ROWS` / `POINT_VALUES` imports; `makeBank` writes
  `value: SONG_POINT_VALUE` for every question.
- `makeEngine` drops `clipStartSeconds`/`clipDurationSeconds`.
- `startedGame(seed, n)` — `n` must now be ≥ 2 everywhere it's called.
- Add `firstUnusedSongId(engine): string` and
  `playRound(engine, hostId, buzzerId, verdict)` convenience helpers — the
  rewritten tests use them constantly.
- `checkInvariants`: replace the board block with a setlist block —
  `used` count never decreases, every song id matches `/^s\d+q\d+$/`, ids are
  unique, `songsRemaining + used === songsTotal` in the public projection. Replace
  the substitute/retry-candidate leak assertions with these:
  - public projection contains **no** bank videoId, and no active title/artist
    pre-reveal (keep both; they are the core guarantee)
  - public projection contains **no** setlist title/artist at all, ever, for any
    unplayed song (stronger than before — assert every bank title is absent from
    `JSON.stringify(pub)` except the revealed active answer)
  - for every player: `toPrivateState(engine, p.id)` has `setlist === null` and
    `hostAnswer === null` when `!p.isHost`; when `p.isHost`, `setlist` is non-null
    exactly in `SETLIST` phase and `hostAnswer` is non-null exactly when there's an
    active question
  - `toPrivateState(engine, null)` (the receiver's projection) has
    `hostAnswer === null` **and** `setlist === null`, and its JSON contains no
    videoId — this is the new receiver-is-unprivileged assertion.

Test files:

- **Delete** `board.test.ts`. **Create** `setlist.test.ts` covering: the flatten
  (section count, song count, opaque ids, bank order preserved), videoId dedupe
  across sections, `start()` refusing an empty bank, small sections surviving (no
  `>= 5` gate any more), `used` flipping on `startSong` and the
  `'That song has already been played.'` refusal, and `rematch()` clearing every
  `used` flag.
- `flow.test.ts` — heavy rewrite: `LOBBY -> SETLIST -> ARMED -> LOCKED -> REVEAL
  -> SETLIST`; game ends when the last song is used (use a tiny `makeBank(2, 2)`
  so this is a 4-iteration loop, not 36); ties; rematch; cast-drop pause/resume.
  Delete every substitution/replay/clip/playbackError test in it.
- `buzz.test.ts` — rewrite the `selectCell` calls to `startSong(hostId,
  firstUnusedSongId(engine))`, `PLAYING` → `ARMED`. Delete the `clipExpired` and
  playToken tests. **Add**: the host cannot buzz; the picker cannot buzz after
  being demoted (arm as host, `transferHost` to another player, assert the
  ex-host still gets `'The host doesn\'t buzz on this one.'`); a 2-player game
  auto-reveals when the single eligible guest answers wrong; `revealQuestion`
  from `ARMED` with nobody buzzed.
- `scoring.test.ts` — rewrite around `SONG_POINT_VALUE`: 100 / 50 / 50 / −50, the
  penalty toggle, negative scores, only-the-buzzer-scores, a revealed question
  scoring nobody, accumulation across two rounds. The "every value in the ladder"
  loop collapses to a single value — that's the point.
- `host.test.ts` — mostly mechanical: `selectCell` → `startSong`, `skipQuestion`
  → `revealQuestion`, drop `replayClip` from the host-gating list, `PLAYING` →
  `ARMED`, `startedGame(…, 1)` → `2` (and the "keeps the crown when nobody is
  left" / "pauses when the host drops" cases need a 2-player setup now).

### Task 13 — net tests

`/home/eric/projects/setlist/packages/server/src/net/__tests__/harness.ts`:

- Delete `FakeYouTube`, `fakeYouTube`, `deferred`, the `youtube` option and the
  `YouTubeSearchClient` import; delete the `clipDurationSeconds` option.
- Add `async function firstSongId(host: Client): Promise<string>` reading
  `host.priv!.setlist![0]!.songs.find(s => !s.used)!.id`, and
  `async function armRound(host: Client)` that starts the game (if needed) and
  arms the first unused song — every net test needs it.
- `makeRoom` is otherwise unchanged.

- **Delete** `songmatch.test.ts` and `substitution.test.ts`.
- `integration.test.ts` — heavy rewrite. Keep the shape (a full question across
  all three surfaces) but:
  - `BOARD` → `SETLIST`, `board:select` → `setlist:start`, `PLAYING` → `ARMED`.
  - New assertion set replacing "only the receiver gets playback data": the
    **host** and only the host has `priv.setlist` in `SETLIST`; guest and receiver
    have `null`. Once armed, host has `priv.hostAnswer` **immediately** (this is
    the behaviour change) while guest and receiver still have `null`, and
    `JSON.stringify(guest.pub)` / `guest.priv` / `receiver.pub` / `receiver.priv`
    contain neither the title nor the artist nor the videoId.
  - Replace the "never puts a videoId in the public projection" test with one that
    pulls the videoId from `host.priv.setlist` and asserts it appears in **no**
    other surface.
  - **Delete** "expires the clip on the server when nobody buzzes" and "surfaces a
    receiver playback error"; **add** "the host can reveal with nobody buzzed"
    (`question:reveal` → `REVEAL` with a non-null answer) and "a non-host cannot
    arm a song" (`setlist:start` → `'Only the host can start a song.'`).
  - Keep "blocks starting without a TV attached", "transfers the host role", and
    "reconnects a dropped player by token" — the last one needs 2 players where
    the *guest* buzzes and scores `100` (not `500`).
- `race.test.ts` — light rework, but one real change: `makeRoom(port, 4)` makes
  `players[0]` the host, so only 3 clients can win the race. Assert exactly one
  `ok` among `players.slice(1)`, and that the host's ack is
  `{ ok: false, error: "The host doesn't buzz on this one." }`. Swap
  `board:select` for `setlist:start` (use the harness's `firstSongId`) and
  `PLAYING` → `ARMED`. The locked-out test needs 3 players → host + 2 buzzers
  (it already has 3; `a`/`b` are `players[1]`/`players[2]` — correct as written).
- `rooms.test.ts` — minimal rework: `board:select` → `setlist:start` (2 call
  sites), `PLAYING` → `ARMED`, and `new RoomManager(sampleQuestionBank())` still
  compiles once the options param is dropped. The whole `RoomManager.closeIfEmpty`
  describe block is untouched.

### Task 14 — client tests

`/home/eric/projects/setlist/packages/client/src/test/fixtures.ts`:

- Delete `makeBoard`; add `makeHostSetlist(sections = 2, per = 3):
  HostSetlistSection[]`.
- `makeActive` returns the new `PublicActiveQuestion` (`songId: 's0q2'`,
  `sectionTitle: 'Category 0'`, `value: 100`, no cell/duration/playbackError/
  retrying/timedOut).
- `makePub` drops `board`, adds `songsTotal` / `songsRemaining`, defaults
  `phase: 'ARMED'`.
- `makePriv` drops `receiverPlayback`, adds `setlist: null`.

`/home/eric/projects/setlist/packages/client/src/player/__tests__/screens.test.tsx`:

- Delete the `BoardPick` describe block and the two substitution/playback-error
  `BuzzScreen` tests.
- Rewrite the remaining `BuzzScreen` tests against `ARMED`; **add** one asserting
  the host sees `👑 You're hosting this one`, disabled, and that
  `store.buzz` is not called.
- **Add** a `SetlistScreen` describe block: the host sees section headers and
  tappable song rows from `priv.setlist`; tapping one reveals the title, artist
  and an `<a>` whose `href` is `https://music.youtube.com/watch?v=<videoId>`;
  `🔔 Start round — arm buzzers` calls `store.startSong` with the song id; a
  non-host sees `🎧 Eric is choosing a song…` and **no** song titles in the DOM
  (this is the client-side spectator-safety test — make it explicit).
- `HostJudge` tests: unchanged except the relabelled secondary button.
- `Reveal` / `Lobby` tests: unchanged.

### Task 15 — Python builder

`/home/eric/projects/setlist/scripts/questionbank/build_bank.py`:

- Change the `--youtube-api-key` argparse default from
  `os.environ.get("YOUTUBE_API_KEY")` to `None`, and reword the help to:
  `"Google/YouTube Data API v3 key — optional legacy pre-filter that drops songs
  with embedding disabled. No longer needed: the game plays songs via native
  YouTube Music links, which have no embed restrictions."`
- Update the summary print near the end from
  `"Embeddable pre-check: … skipped (no YOUTUBE_API_KEY)"` to
  `f"Embeddable pre-check: {'ran' if args.youtube_api_key else 'skipped (not requested)'}"`.
- Leave `check_embeddable` / `filter_embeddable` and every test in
  `test_build_bank.py` alone — they pass `BuildOptions(youtube_api_key=...)`
  directly and are unaffected.

### Task 16 — config, docs, env

- `/home/eric/projects/setlist/docker-compose.yml`: remove the
  `CLIP_START_SECONDS`, `CLIP_DURATION_SECONDS` and `YOUTUBE_API_KEY` env entries
  and their comments. Leave `PORT`, `CAST_RECEIVER_APP_ID`, `PUBLIC_BASE_URL`,
  `QUESTION_BANK_PATH`, and every hardening/ports directive untouched.
- `/home/eric/projects/setlist/.env.example`: drop `CLIP_START_SECONDS` /
  `CLIP_DURATION_SECONDS`; move `YOUTUBE_API_KEY` into the builder-only section
  with a comment saying it is now an optional legacy pre-filter the Node server
  never reads.
- `/home/eric/projects/setlist/package.json`: update `description` — drop
  "Jeopardy-style" (e.g. *"Real-time multiplayer music trivia — host-played
  setlist, buzz in on your phone, scores on the TV"*). Bump `version` to `0.3.0`
  (it is surfaced in the UI and used to tell deploys apart).
- `/home/eric/projects/setlist/README.md`: substantial rewrite —
  - Opening paragraph: setlist, not board; the host plays songs on their own
    device via a YT Music link; the app is the scorekeeper + buzz race.
  - Architecture: the "three things never sent" list becomes two — the answer
    (host-only until reveal) and the setlist's song data (host socket only). Add
    a sentence stating the TV receiver is now the *least* privileged surface and
    plays no media.
  - "How the game works": replace the **Board** and **Clip** bullets with
    **Setlist** (sections = bank categories, browse + search, `used` marking) and
    **Host playback** (tap song → YT Music link → Start arms buzzers → manual
    Reveal, no timer). Update **Scoring** to the flat 100 / 50 / 50 / −50. Update
    **Host** to say the host never buzzes and can end the game at any time.
  - Delete the entire **Runtime song substitution** paragraph; rewrite the
    **Embeddable pre-check** paragraph as a short "legacy, off by default, not
    needed any more" note.
  - Schema section: `value` is now ignored by the engine (flat value); `videoId`
    is the field the *host* needs for the YT Music link and the one field never
    sent to a non-host or the TV; drop the "clip offset" framing of
    `startSeconds`/`durationSeconds` (they are now unused by the app — say so;
    the builder still writes them and the validator still accepts them).
  - Test section: update the description of what the suite covers.
  - Environment table: drop `CLIP_START_SECONDS`, `CLIP_DURATION_SECONDS`; note
    `YOUTUBE_API_KEY` is builder-only and optional.
  - The **Deployment** section currently says "Not set up yet" — that is stale.
    Replace it with the real setup: Docker (`docker compose up -d --build`,
    image `ericfaris/setlist:latest`, container `setlist-app-1`, bound to
    `127.0.0.1:8900`) behind a Cloudflare Tunnel at
    `https://setlist.mooseflip.com`.

---

## 5. Testing & verification

### 5.0 Commands (all from `/home/eric/projects/setlist`)

```bash
npm run build -w @setlist/shared   # REQUIRED FIRST after any shared change:
                                   # server/client resolve @setlist/shared via dist/
npm run typecheck                  # all three workspaces
npm test                           # engine unit + WebSocket integration + client screens
npm run build                      # shared -> client -> server, proves the prod build
scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v
```

Re-run `npm run build -w @setlist/shared` whenever you touch `packages/shared`;
a stale `dist/` produces confusing "property does not exist" errors downstream.

For a manual smoke test: `npm run dev`, open <http://localhost:5173>, host a game,
click **Open TV view** (opens `/receiver.html?code=NNNN` — the supported
no-Chromecast path), join from a second browser profile, and play a round.

### 5.1 Acceptance criteria → proof

| # | Criterion | Proof |
|---|---|---|
| 1 | Setlist, not a board, on game start | `setlist.test.ts` (flatten + section labels); `screens.test.tsx` `SetlistScreen` renders section headers + song rows; `integration.test.ts` asserts `phase === 'SETLIST'` after `game:start` and `host.priv.setlist` is populated |
| 2 | Tapping a song shows the host (and only the host) title/artist + a YT Music link | `screens.test.tsx`: tapping a row reveals title/artist and an `<a href="https://music.youtube.com/watch?v=…">`; the non-host `SetlistScreen` test asserts **no** song titles in the DOM; `integration.test.ts` asserts `guest.priv.setlist === null` and no title/artist/videoId anywhere in guest/receiver JSON |
| 3 | Buzzing requires an explicit Start | Structurally true (cue is client-local; §2.2). `buzz.test.ts`: `buzz()` in `SETLIST` ⇒ `'Buzzers are not armed.'`; `integration.test.ts`: `guest.priv.canBuzz === false` until `setlist:start` acks |
| 4 | Buzz race unchanged: first server-processed wins, nothing client-timed | `race.test.ts` (50 rooms × simultaneous buzzes, exactly one winner among non-hosts, every surface agrees); `buzz.test.ts` `lockedAt` comes from the injected clock; `protocol.ts` `buzz:press` still carries no timestamp field |
| 5 | The host cannot buzz on the round they started | `buzz.test.ts` (host rejected; picker still rejected after demotion); `race.test.ts` (host's ack is the exclusion error); `screens.test.tsx` (host's buzz button disabled, `store.buzz` not called) |
| 6 | Judging scores a flat value | `scoring.test.ts` (100 / 50 / 50 / −50, penalty toggle, negatives, only-the-buzzer); `integration.test.ts` asserts the guest's score after a `titleCorrect` verdict is `50` |
| 7 | Manual reveal, no timeout | `buzz.test.ts` `revealQuestion` from `ARMED`; `integration.test.ts` "host can reveal with nobody buzzed"; **negative proof**: grep the server for `setTimeout` — the only remaining ones are the disconnect grace timers in `server.ts` |
| 8 | TV shows code/QR/scores/lock status, never media, never the answer early | `checkInvariants` asserts the receiver projection (`toPrivateState(engine, null)`) has null `hostAnswer`/`setlist` and no videoId; `integration.test.ts` asserts `receiver.priv.hostAnswer === null` while armed; **structural**: `YouTubePlayer.tsx`, the iframe script tag and `ReceiverPlayback` no longer exist |
| 9 | Board + substitution removed, not unused | `git status` shows the deletions; `grep -rn "BOARD_ROWS\|POINT_VALUES\|BoardState\|selectCell\|clipExpired\|beginRetry\|substituteVideoId\|retrying\|songmatch\|net/youtube\|YouTubePlayer\|receiverPlayback" packages/` returns **nothing** |
| 10 | `npm run typecheck` + `npm test` pass on a suite that reflects the new game | Both commands green; test inventory in §5.2 |

### 5.2 Test-file disposition

| File | Disposition |
|---|---|
| `engine/__tests__/harness.ts` | **Rewrite the invariant block** (setlist instead of board; new leak assertions incl. the receiver projection); mechanical elsewhere |
| `engine/__tests__/board.test.ts` | **Delete** → replaced by `setlist.test.ts` |
| `engine/__tests__/flow.test.ts` | **Heavy rewrite** (phase names, no clip/replay/substitution, setlist-exhaustion end) |
| `engine/__tests__/buzz.test.ts` | **Rewrite** + new host/picker-exclusion cases |
| `engine/__tests__/scoring.test.ts` | **Rewrite** around `SONG_POINT_VALUE` |
| `engine/__tests__/host.test.ts` | **Light rework** (method renames, `PLAYING`→`ARMED`, 2-player minimums) |
| `net/__tests__/harness.ts` | **Light rework** (drop the fake YouTube client + clip options, add `firstSongId`/`armRound`) |
| `net/__tests__/songmatch.test.ts` | **Delete** |
| `net/__tests__/substitution.test.ts` | **Delete** |
| `net/__tests__/integration.test.ts` | **Heavy rewrite** |
| `net/__tests__/race.test.ts` | **Light rework** (event rename + host-exclusion assertion) |
| `net/__tests__/rooms.test.ts` | **Light rework** (event rename, phase rename) |
| `questions/__tests__/bank.test.ts` | **Leave alone** — the bank format is unchanged (confirm it compiles; it should not reference board constants) |
| `client/src/test/fixtures.ts` | **Rewrite** the shapes |
| `client/src/player/__tests__/screens.test.tsx` | **Rewrite** (drop `BoardPick`/substitution, add `SetlistScreen`) |
| `scripts/questionbank/test_build_bank.py` | **Leave alone** |

---

## 6. Out of scope

Restated from the brief — do not build these, and do not leave hooks for them:

- **No external playback control or detection.** The YT Music link opens the app;
  everything after that (play, pause, when the song ends) is invisible to us. No
  Spotify/YT Music API integration.
- **No casting song audio/video to the TV.** The receiver renders game state
  only — code, QR, scoreboard, buzz-lock status. This is permanent, not a stopgap.
- **No backwards-compatibility toggle** for the board mode. Full deletion, not a
  feature flag, not a second mode. There is no `if (setlistMode)` anywhere.
- **No per-question wager / configurable point values** in v1. Flat constant.
- **No changes to** the buzz-race fundamentals (server-timestamped, first-in-wins,
  no client timing), the reconnect-token / disconnect-grace / pause / host-transfer
  machinery, or the Cast sender↔receiver handshake. Treat all of it as a stable
  foundation.
- **No changes to `build_bank.py`'s core pipeline** (library + community
  playlists, AI categorisation, `isExplicit` filtering, dedupe, output schema)
  beyond the one argparse-default change in Task 15.

---

## 7. Risks & watch-outs

### 7.1 The new leak surface: the host knows the song early

This is the single most important thing to get right, and it is genuinely new.
Previously **nobody** saw the answer before a buzz locked in — even the host.
Now the host's socket carries (a) the entire setlist with titles, artists and
videoIds while browsing, and (b) `hostAnswer` from the instant the round is armed.
Two consequences:

- `toPrivateState` is the only gate. It must check `isHost` for **both** new
  fields, and `toPublicRoom` must never gain a setlist field. Keep both projectors
  field-by-field; never `...spread` a `GameRoom`, `ActiveQuestion` or
  `SetlistSong`. The comment explaining why is worth keeping.
- The `hostAnswer` gate changed shape: it was `isHost && (locked || revealed)`,
  it is now `isHost && active !== null`. Do not accidentally widen it to
  `active !== null` alone — that would hand the answer to every player.
- Client-side, `screens.tsx` must never render `priv.setlist` or `priv.hostAnswer`
  in a component a non-host mounts. `HostJudge` already early-returns on
  `!priv.isHost`; `SetlistScreen` needs the same discipline. The
  `screens.test.tsx` non-host assertions (§5.1 row 2) exist to catch a regression
  here.
- The `checkInvariants` leak assertions are the safety net for all of the above.
  Strengthen them as described in Task 12 rather than trimming them — they are the
  reason a projection bug fails the build instead of leaking in a real game.

### 7.2 Host exclusion × host transfer

`transferHostOnDisconnect` can move the crown mid-round. Combined with the new
"host can't buzz" rule that creates three hazards:

1. **A demoted ex-host becomes buzz-eligible while knowing the answer.** Solved by
   `active.pickedByPlayerId` (§2.7) — exclude the picker for the whole round, not
   just "whoever is host right now".
2. **The inherited host loses their buzz mid-round.** Accepted: the user's rule is
   "the host becomes a non player, period", so whoever holds the crown is a
   non-player, full stop. Their `canBuzz` flips to false and the UI shows
   `👑 You're hosting this one`.
3. **Deadlock check.** In a 2-player room where the host drops, the crown moves to
   the only other player — who is then the only eligible buzzer *and* now
   ineligible. `eligibleBuzzers()` returns empty, so `disconnect()`'s existing
   "nobody left" branch must fire and auto-reveal the question, dropping the room
   to `REVEAL` rather than hanging in `ARMED`. **Write a test for exactly this.**
4. **Residual, accepted limitation:** anyone who has ever held the crown has seen
   the *whole* setlist, so they know future songs too. There is no cheap fix
   (re-shuffling or hiding the setlist would break the host's core workflow).
   Document it in the README's Host bullet: don't rotate the host mid-game unless
   you're happy for the new host to be a permanent non-player, and expect the old
   one to have seen the list. Do not build mitigation.

### 7.3 Confirm — don't assume — that reconnect/pause/Cast need no changes

The brief says these carry over unchanged. That is true, but verify it rather
than trusting it; the relevant code is:

- **Reconnect token**: `engine.join()`'s `reconnectToken` branch, `store.join()`'s
  `savedCode`/`savedToken` logic, and the `connect` handler in `store.ts` that
  re-issues `room:join` / `receiver:subscribe` after a transport reconnect. None
  of it references board, clip or playback state — leave it alone entirely.
- **Disconnect grace**: `server.ts`'s `disconnectGraceTimers` + the 60 s window.
  Untouched by this change. Note that `RoomRuntime.timer` (the *clip* timer) is
  a different field and is the one being deleted — do not delete the grace timers
  by mistake.
- **Pause/resume**: `pause()` / `maybeResume()` / `phaseBeforePause` /
  `setCastConnected`. The only coupling is `IN_PROGRESS_PHASES`, which must be
  updated to the new phase names (Task 4) — that is the *entire* change here. A
  pause during `SETLIST` restores to `SETLIST`; during `ARMED` restores to
  `ARMED`. `flow.test.ts` should assert the `ARMED` case.
- **Cast handshake**: `receiver.html`'s inline `/api/cast-room` poller,
  `receiver/main.tsx`'s `__castOnCode` / `__castPendingCode`, `store.receiverStandby`
  / `receiverSubscribe` (including the `__castPollTimer` clear), `common/cast.ts`,
  and `server.ts`'s `standbyReceivers` / `rooms.setPendingCastCode`. The only edit
  to `receiver.html` is removing the YouTube iframe script tag and the
  `#yt-stage` block — **do not touch anything else in that file.**

### 7.4 "Already played" correctness

- `used` lives on the engine's `SetlistState`, which is rebuilt from the bank on
  every `start()`. A bank rebuilt between games therefore starts fresh — correct.
- A bank rebuilt *while a room is live* does not affect that room (the engine
  holds a reference to the bank object loaded at boot). Fine.
- Song ids are positional (`s<i>q<j>`), so they are **not stable across bank
  rebuilds**. That's fine because they never persist beyond a room's lifetime —
  but it means you must never store a song id in localStorage or a URL.
- Long games: with a 36–64-song bank, "all songs used" won't be reached. The
  `🏁 End game & show scores` button (Task 11) is what actually ends a real game;
  do not skip it. Also surface `songsRemaining` on the TV so the room can see the
  setlist shrinking.
- Dedupe by `videoId` when flattening, or an AI-categorised bank that placed one
  track in two themes will offer the same song twice with two different ids and
  two independent `used` flags.

### 7.5 Smaller traps

- **Stale `@setlist/shared` dist.** Build shared first (§5.0). Most confusing
  compile errors during this change trace back to this.
- **`MIN_PLAYERS = 2` breaks 1-player test setups.** `startedGame(seed, 1)` appears
  in `board.test.ts` (deleted) and `host.test.ts` (fix). Grep for `, 1)` in the
  engine tests before declaring victory.
- **`useNow` / `useClipProgress`** in `common/ui.tsx` may be referenced elsewhere;
  grep before deleting.
- **`sounds/times-up.mp3`** was driven by `active.timedOut`, which no longer
  exists. Re-key it to "revealed with nobody locked in" (Task 10) or the file
  becomes dead weight. Keep both sound files on disk either way.
- **`PublicActiveQuestion.value`** is redundant with the constant but keep it —
  it saves every client importing `SONG_POINT_VALUE` and keeps the reveal screens
  purely projection-driven.
- **Do not relax `validateQuestionBank`.** The on-disk bank format is explicitly
  unchanged; `value`, `startSeconds` and `durationSeconds` stay required/accepted
  even though the engine ignores them now.
- **The `/api/health` endpoint** reports `bankSource` and `categories` — leave it
  as is; it is used to sanity-check deploys.
- **Deployment**: after `npm run build` and tests pass, ship with
  `docker compose up -d --build` from the repo root (image `ericfaris/setlist:latest`,
  container `setlist-app-1`, `127.0.0.1:8900`, public at
  `https://setlist.mooseflip.com`). Deploys wipe in-memory rooms — expected.
