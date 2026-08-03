# Host-Playback Setlist Mode — Concept Brief

## Problem

The Jeopardy-board game currently plays songs through a YouTube IFrame embedded on the receiver. Real gameplay testing found ~85% of songs failed to play with "Embedding disabled by the owner" — a per-domain embed allowlist restriction that no offline API check can detect (already diagnosed and partially mitigated in a prior session with a 3-attempt runtime substitution system, but the underlying problem — embedding is fundamentally unreliable for a lot of real music content — remains).

The user's insight in this conversation: **native YouTube Music playback has none of these restrictions.** If the host taps a link that opens the song directly in the real YouTube Music app/site (`https://music.youtube.com/watch?v=<videoId>`), it plays every time, because embed restrictions only apply to third-party iframe embeds, never to YouTube's own app. This sidesteps the entire problem at its root instead of continuing to fight it.

This is also, independently, a request to simplify the game: the user wants the Jeopardy board (categories × dollar-value grid) removed entirely — "the board needs to go away no matter what" — in favor of a much simpler flow where the host browses a flat, themed **setlist**, taps a song to open/play it themselves, and the app's job shrinks to what the user summarized as **"essentially this just becomes a scorekeeper"**: room management, a fair server-timestamped buzz race, and score tracking.

## Goal

Replace the current Jeopardy-board game entirely with a simpler "Setlist" mode:

- The host browses a **setlist** (songs from the existing AI-categorized bank, sectioned/labeled by theme, no dollar-grid) on their own phone.
- The host taps a song to see its title/artist, taps a **YouTube Music link** to open and play it on their own device (their phone speaker, a Bluetooth speaker, whatever — entirely outside this app's control), then taps **"Start"** in the app to arm the buzzers.
- Buzzing and scoring work exactly as today: first buzz wins (server-timestamped, never client-trusted), host judges title/artist correctness — but scoring is now a **flat, fixed point value per song** (not a variable board value).
- There is **no clip-expiry timer** (there's no clip in our system to time — the host is playing it on a device we don't control). The host manually ends/reveals the question whenever they decide.
- The **host never buzzes** — they already know the song they picked, so they're purely a facilitator/judge for that round, not a contestant.
- The **TV/Chromecast receiver stays** — it still shows the room code, live scoreboard, and buzz-lock status — but **no longer plays any audio/video itself.** The YouTube IFrame player, the embeddable pre-check, and the entire runtime song-substitution system (built and shipped in the immediately prior session) all become unnecessary and should be removed, not just unused — this is explicitly a full replacement, not a second mode alongside the old one.

## In scope

- **Data model**: keep the existing bank format (`QuestionBank` / `BankCategory` / `BankQuestion` in `packages/shared/src/questions.ts`, produced by `scripts/questionbank/build_bank.py`) largely as-is — it already has everything needed (title, artist, videoId, category grouping). The *board layout* concept (`BoardState`, `BoardCell`, category × row selection, `POINT_VALUES` ladder) goes away; the bank's categories become **setlist section labels** instead of board columns.
- **Game state machine redesign**: remove the `BOARD` phase and board-selection flow (`layOutBoard()`, `selectCell()`, `BOARD_ROWS`/`BOARD_COLUMNS`). Replace with a flow where the host picks the next song from the setlist directly (no intermediate "board" state needed — picking *is* starting, modulo the new "host readies external playback, then arms buzzers" two-step described above).
- **New host flow**: (1) host taps a song in the setlist → sees title/artist (this is new: currently the host doesn't see the answer until a buzz locks in; in this mode the host must see it immediately, since they have to know what to play) → (2) a tappable `https://music.youtube.com/watch?v=<videoId>` link opens YT Music → (3) host taps "Start" in-app once ready → buzzers arm.
- **Flat scoring**: pick and hardcode (or make configurable via `RoomSettings`) a fixed point value per song, split between title/artist correctness the same way today's `V/2 + V/2` logic already works, just with a constant `V` instead of the board's per-row value.
- **Host exclusion from buzzing**: `canBuzz()`/`buzz()` must treat the current room's host as permanently ineligible in this mode (or more precisely: ineligible for the song they just picked and started — since the host doesn't rotate mid-question, "the host" is the only exclusion needed).
- **Manual question-ending**: replace the clip-expiry timer (`reconcileTimer`, `clipExpired()`) with a host-triggered "Reveal" action when nobody's buzzed and the host decides to move on. This already exists in spirit as `skipQuestion()` — likely reusable/renameable rather than net-new.
- **Receiver simplification**: remove `YouTubePlayer.tsx`, the `PlayingTV` clip/video rendering, and anything driving video playback on the TV. The receiver still needs a "now playing" / "waiting for host" state showing the room is mid-question and buzzing is live, plus the existing scoreboard, lobby, reveal, and paused screens (adapted to drop board-specific bits).
- **Remove the substitution system**: `packages/server/src/net/songmatch.ts`, `packages/server/src/net/youtube.ts`, the `beginRetry`/`resolveRetrySearch`/`playSubstitute`/`exhaustRetries` engine methods, the `retrying`/`retryAttempts`/`retryCandidates`/`substituteVideoId`/`retryId`/`lastPlaybackErrorMessage` fields, the `YOUTUBE_API_KEY`-in-the-Node-server wiring, and their tests — all of it was built specifically to work around embed failures that this redesign sidesteps entirely by never embedding in the first place. (The Python builder's own `--youtube-api-key` embeddable pre-check flag can also go, or at minimum is no longer meaningfully useful — planner's call on whether it's worth removing from the offline builder too, or just leaving unused there since it's harmless and separate from the live app.)
- **Docs**: `README.md` needs a substantial rewrite reflecting the new game flow (no board, setlist + host-external-playback, flat scoring), and removal of the runtime-substitution section added in the prior session.

## Out of scope

- No changes to the offline `build_bank.py` pipeline's core song-gathering (library playlists, community playlists/search, AI categorization, `isExplicit` filtering) — the bank format and builder stay valuable as the source of the setlist. (The embeddable pre-check specifically may be removed or left inert — see above, planner's call, not a blocker either way.)
- No attempt to control playback on the host's external device from our app (no Spotify/YT Music API integration to detect play/pause/song-end) — the link just opens the app; everything after that is manual and outside this app's knowledge.
- No casting of the actual song audio/video to the TV via Chromecast — the TV shows game state only (scoreboard, buzz status, room code), never plays media. This is a deliberate simplification of the receiver, not a temporary state.
- No backwards-compatibility mode / toggle to keep the old board-based game available — this is a full replacement per the user's explicit decision. Do not build a mode-switch; delete the board.
- No changes to the fundamentals of the buzz race (server-timestamped, first-in-wins), reconnect/pause logic, or the Cast sender/receiver handshake pattern — those all carry over unchanged.
- No per-question configurable point values in v1 (a host "wager" system) — flat value only, per the user's decision.

## Constraints

- **Server-authoritative discipline holds**: the buzz race must remain server-timestamped, never client-trusted — same as today. The host's "Start" action (arming buzzers) and "Reveal" action (manually ending) are host-only privileged intents, validated server-side, following the exact pattern `board:select`/`judge:answer`/`skipQuestion` already use for host-only operations.
- **Spectator-safety, adapted**: today's three-secrets model (answer hidden until reveal, videoId receiver-only, unplayed cells hidden) mostly dissolves because the host now legitimately knows the song before it starts — but the **other players and the TV must still never see the title/artist before the reveal**, exactly as today. Only the host's own private state should carry the song identity early.
- **This is a live, deployed app** at `https://setlist.mooseflip.com` (Docker, `docker compose up -d --build`). The existing deployment pattern applies unchanged.
- **Reuse existing patterns**: host-only privileged actions, spectator-safe projections (`toPublicRoom`/`toPrivateState` field-by-field, never spread), the reconnect-token/pause/host-transfer machinery, the Cast sender/receiver handshake — all of this is untouched by this redesign and should be treated as a stable foundation, not rebuilt.
- **Testing conventions**: `packages/server/src/engine/__tests__` (pure engine unit tests) and `packages/server/src/net/__tests__` (Socket.IO integration tests) are the two surfaces this redesign will touch heavily, given how much of the board/playback machinery they currently cover. Expect significant test rewrites, not just additions, since board/playback tests are being removed along with the features they test.

## Acceptance criteria

1. Starting a game shows the host a browsable setlist (songs grouped/labeled by their bank category) instead of a board.
2. Tapping a song in the setlist shows the host (and only the host) its title and artist, and a tappable link that opens `https://music.youtube.com/watch?v=<videoId>` (e.g. in a new tab/the YT Music app).
3. The host must explicitly arm the round (a "Start" action) before players can buzz — buzzing is not live merely from having tapped a song.
4. Once armed, the buzz race behaves exactly as today: first buzz wins, server-timestamped, other players see it locked, no client timing trusted.
5. The host cannot buzz in on the round they just started.
6. The host can judge the locked-in buzzer's answer (title/artist correctness) and score updates with a flat, fixed point value — not a board-derived variable value.
7. If nobody buzzes, the host can manually end/reveal the question — there is no automatic timeout.
8. The TV/receiver shows room code, QR join, live scoreboard, and buzz-lock status throughout, but never attempts to play any audio/video and never shows the song title/artist before reveal.
9. The old board (`BOARD` phase, `layOutBoard`, `selectCell`, category/row grid) and the entire runtime substitution system (`songmatch.ts`, `youtube.ts`, retry state/engine methods) are removed from the codebase, not merely unused.
10. `npm run typecheck` and `npm test` (server + client workspaces) pass with a test suite that reflects the new game — old board/substitution tests removed or rewritten, new tests cover the setlist/arm/judge/reveal flow and the host-can't-buzz rule.

## Open questions & decisions made

- **Plan review**: user chose to **review the plan** before build starts — Phase 3 gate applies normally.
- **Setlist grouping**: keep the existing AI-generated category themes as section labels in the setlist (not a flat unsorted list) — decided.
- **Scope**: full replacement of the board-based game, not a second alternate mode — decided, explicit and firm ("the board needs to go away no matter what").
- **Scoring**: flat, fixed point value per song — decided, not a host-set wager system.
- **No-buzz ending**: host manually ends/reveals — decided, no timer of any kind (not even an optional one).
- **Host as non-player**: host never buzzes in this mode — decided, stated directly by the user ("the host becomes a non player, period").
- **Still open for the planner to decide and document** (not blocking, but should be resolved explicitly in the plan):
  - Exact UI/UX for the setlist browsing screen on the host's phone (list density, search/filter, how "already played" songs are marked so the host doesn't repeat one).
  - Exact flat point value (e.g. 100, or something else) and whether it's a hardcoded constant or a `RoomSettings` field the host can configure before starting (leaning toward a simple constant for v1, but planner should decide and document).
  - Exact wording/UI for the "Start" (arm buzzers) and "Reveal" (manually end) host actions, and what the TV/other players see in the interim (e.g. "🎧 Host is playing a song…" placeholder state).
  - Whether to also remove `--youtube-api-key`/the embeddable pre-check from the offline Python builder, or leave it as inert/unused (out-of-scope note above already flags this as non-blocking either way).
  - How "already played" songs in the setlist are tracked so the same song isn't accidentally picked twice in one game (likely a straightforward `used: boolean` per bank question, replacing the board cell's `used` flag).
  - Whether GAME_OVER / winner logic changes at all (likely not — should carry over unchanged, just no longer tied to "all board cells used" but rather "host ends the game" or "setlist exhausted").

## Relevant files/areas

- `/home/eric/projects/setlist/packages/shared/src/types.ts` — `RoomPhase`, `BoardState`/`BoardCell`, `POINT_VALUES`/`BOARD_ROWS`/`BOARD_COLUMNS`, `ActiveQuestion` (including all the retry/substitution fields to remove), `MAX_SUBSTITUTION_ATTEMPTS`.
- `/home/eric/projects/setlist/packages/shared/src/projection.ts` — `PublicActiveQuestion`, `PublicRoom`, the `retrying` field to remove.
- `/home/eric/projects/setlist/packages/shared/src/questions.ts` — `QuestionBank`/`BankCategory`/`BankQuestion`, stays largely as-is as the setlist's data source.
- `/home/eric/projects/setlist/packages/server/src/engine/engine.ts` — the whole state machine: `layOutBoard()`, `selectCell()`, `buzz()`, `judge()`, `skipQuestion()`, `clipExpired()`, `reportPlaybackError()`, `beginRetry()`/`resolveRetrySearch()`/`playSubstitute()`/`exhaustRetries()` (all substitution methods to remove), `canBuzz()`. This is the primary file to rewrite.
- `/home/eric/projects/setlist/packages/server/src/engine/project.ts` — `toPublicRoom`/`toPrivateState`, the spectator-safe projection logic that needs adapting for "host sees the song early, nobody else does."
- `/home/eric/projects/setlist/packages/server/src/net/server.ts` — `reconcileTimer` (clip-expiry timer to remove), `trySubstitute` orchestrator (to remove), the Socket.IO event handlers.
- `/home/eric/projects/setlist/packages/server/src/net/songmatch.ts`, `/home/eric/projects/setlist/packages/server/src/net/youtube.ts` — to be deleted entirely.
- `/home/eric/projects/setlist/packages/client/src/receiver/App.tsx`, `YouTubePlayer.tsx` — `YouTubePlayer.tsx` to be deleted; `App.tsx`'s `BoardTV`/`PlayingTV` to be replaced with setlist-mode equivalents.
- `/home/eric/projects/setlist/packages/client/src/player/App.tsx`, `screens.tsx` — `BoardPick`, `BuzzScreen`, `HostJudge` need reworking for the setlist browse/select flow and the new host-arm/host-reveal actions.
- `/home/eric/projects/setlist/packages/client/src/common/store.ts`, `packages/shared/src/protocol.ts` — the Socket.IO event contract; board-select and playback-error events likely become setlist-select/arm/reveal events.
- `/home/eric/projects/setlist/scripts/questionbank/build_bank.py` — stays as the setlist's data source; the `--youtube-api-key` embeddable pre-check is a planner judgment call (see open questions).
- `/home/eric/projects/setlist/packages/server/src/engine/__tests__/`, `/home/eric/projects/setlist/packages/server/src/net/__tests__/` — heavy rewrite expected; board/substitution-specific test files (`songmatch.test.ts`, `substitution.test.ts`) to be deleted, `flow.test.ts`/`integration.test.ts`/`race.test.ts`/`rooms.test.ts` to be updated for the new flow.
- `/home/eric/projects/setlist/README.md` — substantial rewrite: architecture description, "How the game works" section, the "Community playlists and AI categories" section (setlist-relevant parts stay, board-specific parts go), the "Runtime song substitution" section (remove entirely).

## Repo commands & tree state

- **Repo root**: `/home/eric/projects/setlist`. Working tree is **clean** (confirmed via `git status --short`, no output). Latest commit: `8da8d1e` ("Bump substitution to 3 attempts and auto-skip when exhausted") — i.e. the substitution system this brief asks to remove was just built and shipped in the prior session; removing it now is a deliberate reversal based on the better solution (native YT Music links) found in this conversation, not a regression.
- **Node**: v24.14.0, **npm**: on `PATH` directly.
- **Commands** (from repo root): `npm install`, `npm run build` (shared → client → server order, shared must build first since server/client resolve `@setlist/shared` via its built `dist/`), `npm run typecheck` (workspaces), `npm test` (workspaces, `--if-present`), `npm run dev` (concurrent server+client dev servers).
- **Live deployment**: Docker (`docker compose up -d --build`, image `ericfaris/setlist:latest`, container `setlist-app-1`, bound to `127.0.0.1:8900`), publicly reachable at `https://setlist.mooseflip.com` via a Cloudflare Tunnel (remotely managed via the Cloudflare API — no local config file changes needed, already set up). `.env` at the repo root holds `ANTHROPIC_API_KEY`, `YOUTUBE_API_KEY` (may become unused by the Node server after this change, still used by the offline builder), `CAST_RECEIVER_APP_ID`, `PUBLIC_BASE_URL`, `QUESTION_BANK_PATH`.
- No pre-existing uncommitted changes to account for.
