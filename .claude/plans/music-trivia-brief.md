# Music Trivia — Concept Brief

## Problem

The user wants a party game: a group plays music trivia together in a room, using their own YouTube Music subscription as the question source, with the shared game state cast to a TV via Chromecast and each player buzzing in on their own phone — a Jeopardy-style buzz-in format.

## Goal

A self-hosted, real-time multiplayer web app, architecturally modeled on the sibling project `/home/eric/projects/pinpoint` (same monorepo shape, same Chromecast sender/receiver pattern, same "TV is a read-only spectator, phones are the real clients" philosophy), but for music trivia instead of word-clue guessing.

## In scope (v1)

- **Question bank builder**: a standalone **Python script** using `ytmusicapi` (OAuth/browser-auth against the user's real YT Music account) that reads the user's YT Music **playlists**, and emits a JSON question bank where:
  - each **playlist becomes a category** (Jeopardy-style board column)
  - each **song in the playlist becomes a question** with song title, artist, and YouTube video id
  - the script is run manually/offline by the user to (re)generate the bank; it is not called live during a game
- **Jeopardy-style board**: TV view shows a grid of categories (playlists) × point values; host (or players collectively, out loud) pick a square.
- **Playback**: TV/receiver embeds the YouTube IFrame player for the selected question's video id and plays a clip of the song.
- **Buzz-in**: each connected phone has a big buzz button. First buzz-in the **server timestamps and receives** wins the lock — classic server-authoritative race, no client-side timing trusted.
- **Judging & scoring**: a **host** (a designated client — TV operator or a phone marked as host) manually marks the locked-in buzz as correct/incorrect for song title and/or artist; points awarded accordingly. No fuzzy text-matching/auto-grading in v1.
- **Room join flow**: room code + QR on the TV, phones join via browser, same UX pattern as pinpoint.
- **Chromecast**: TV view is cast from a phone/desktop Chrome sender to an actual Chromecast device, reusing pinpoint's `cast.ts` sender pattern and a custom receiver page — OR a same-network browser tab fallback ("Open TV view") for local play without a Chromecast, exactly as pinpoint does.
- Monorepo scaffold: `@music-trivia/shared`, `@music-trivia/server` (Node + Socket.IO, server-authoritative game engine), `@music-trivia/client` (React + Vite, two builds: player UI + TV receiver UI).
- Git repo initialized (done — plain `git init`, no commits yet; `.gitignore` already written, no commit made).

## Out of scope (v1 — later)

- Auto-graded/fuzzy answer matching.
- Automated/scheduled regeneration of the question bank (rebuild is a manual script run).
- Any use of the (non-existent) official YouTube Music API — this stays on `ytmusicapi` (unofficial).
- Deployment/production hardening beyond following pinpoint's existing pattern (Docker, Cloudflare Tunnel) — scaffold should be deployable the same way but actual deploy is a later gated step (Phase 6 of this skill), not part of the build.
- Clip-selection intelligence (e.g. skipping intros, picking a "hook" timestamp) — a simple fixed playback strategy (e.g. play from start, or from a configurable offset) is enough for v1; note it as a tunable default, not a feature to over-engineer.
- Multiple simultaneous games/rooms is fine if it falls out of pinpoint's existing room-registry pattern for free, but is not a hard requirement to design further for.

## Constraints

- **Reuse pinpoint's architecture directly**, not just "similar to it": npm workspaces monorepo, `packages/shared` / `packages/server` / `packages/client`, Socket.IO for realtime, server as sole source of truth sending spectator-safe projections to the TV receiver (hidden info — e.g. who's about to answer, other players' scores mid-lockout if relevant — should follow the same spectator-safe discipline pinpoint uses, even though music trivia has much less hidden state than pinpoint).
- **Reuse pinpoint's Chromecast pattern verbatim where possible**: `packages/client/src/common/cast.ts` (Cast Sender SDK wiring, `CAST_NAMESPACE`, session handshake retry logic), a `receiver.html` second Vite entry point, and a `CAST_RECEIVER_APP_ID` env var. See `/home/eric/projects/pinpoint/packages/client/src/common/cast.ts` and `/home/eric/projects/pinpoint/README.md` for the exact pattern to port.
- **New Cast Receiver App ID required**: pinpoint's registered custom receiver app id cannot be reused for a different app. Registering a new one in the Google Cast SDK Developer Console is a manual step only the user can do (browser login, no CLI). The plan should treat `CAST_RECEIVER_APP_ID` as an env var the user fills in later, exactly like pinpoint's `.env.example`, and should not block scaffolding/local dev on it (pinpoint's local fallback — "Open TV view" browser tab — makes the Cast SDK optional for dev).
- **ytmusicapi is Python-native**; the question-bank builder is a separate Python script, not a Node port. It writes a JSON file (gitignored, per user's own data) that the Node server reads at startup/runtime. Needs a `requirements.txt` or similar and its own README section for one-time setup (auth: ytmusicapi requires either browser-cookie auth or OAuth — plan should pick one, OAuth is more durable and is `ytmusicapi`'s recommended modern approach, browser-cookie is simpler but expires often; planner should decide and document, defaulting to OAuth unless there's a strong reason otherwise).
- **YouTube IFrame Player API** is the playback mechanism on the receiver (not Chromecast's Default Media Receiver — no viable direct stream URL for YouTube content without ToS-risky extraction). The receiver page embeds the IFrame player directly for the clip's video id.
- Environment: Node v24.14.0, npm 11.9.0, Python 3.12.3 (`/usr/bin/python3`) confirmed available on this machine. No virtualenv exists yet for the Python piece — plan should create one (e.g. `.venv` under a `packages/questionbank` or top-level `scripts/` dir) and record its exact invocation path (not bare `python`/`pip`).
- This is a **brand-new repo** (`git init` already run here, no commits yet, `.gitignore` already in place, empty working tree otherwise). No pre-existing uncommitted changes to worry about.

## Acceptance criteria

1. `npm install && npm run dev` (from repo root, matching pinpoint's script names) starts a server (Socket.IO) and a Vite client dev server, proxied together, serving both the player UI and a TV receiver route/build, using a **sample/fixture question bank** (since the user's real YT Music bank requires their own OAuth run) so the app is testable without live YT Music credentials.
2. The Python question-bank script, run against a real (or mocked, for automated tests) YT Music account, produces a JSON file matching a documented schema: categories (playlists) → questions (song title, artist, YouTube video id, point value).
3. A room can be created, shows a join code/QR, and a second browser tab/device can join as a player using that code (mirrors pinpoint's join flow, verifiable locally without a real Chromecast via the "Open TV view" fallback).
4. The TV/receiver view renders a Jeopardy-style board of categories × point values sourced from the question bank.
5. Selecting a question on the board plays the corresponding song via an embedded YouTube IFrame player on the receiver.
6. From two or more joined player clients, buzzing in is resolved server-side as a race — only the first buzz the server receives locks in; other clients see it's locked and cannot also lock in for that question.
7. A host view/control lets the host mark the locked-in buzz correct/incorrect and points update and are reflected on the TV view and player views.
8. `npm test` (or equivalent per-workspace test command, mirroring pinpoint's `npm run test --workspaces --if-present`) passes for at least the server-side game engine logic (buzz race resolution, scoring, round/category state transitions) with automated tests, following pinpoint's testing pattern (`packages/server/src/engine/__tests__`).
9. `npm run typecheck` passes across workspaces.

## Open questions & decisions made

- **Plan review**: user chose to **skip** the Phase 3 plan-approval gate — proceed straight from plan to execution after this session's own sanity check.
- **Question-bank language**: Python script using `ytmusicapi`, decided.
- **Playback mechanism**: YouTube IFrame embed on the receiver page, decided (not Cast Default Media Receiver).
- **Buzz/scoring model**: server-timestamp race + manual host judging (no auto-grading), decided.
- **Round/category format**: fixed-size game, categories/board (playlists as categories), Jeopardy-style grid — not a flat shuffled pool. Both song and artist are guessable/judgeable per question.
- **Git**: initialize git for this repo — done (`git init`, `.gitignore` written, no commit yet). Planner/executor should feel free to commit as they see fit for their own workflow, but should not push anywhere (no remote configured).
- **Still open for the planner to decide and document** (not blocking, but should be resolved explicitly in the plan rather than left vague):
  - ytmusicapi auth method: OAuth vs. browser-cookie (brief recommends OAuth; planner should confirm/decide and document setup steps).
  - Exact clip playback strategy (e.g., start from 0:00 vs. a fixed offset) — keep simple, document the default and where it's configurable.
  - Exact point-value scheme for the board (e.g., fixed ladder like 100/200/300/400 per category, or something simpler) — pick something sensible and document it, not a v1 blocker.
  - Whether "host" is a distinct role a player claims (e.g. first joiner, or an explicit "host mode" toggle) — needs a concrete mechanism in the plan, modeled loosely on how pinpoint assigns any special roles if applicable (check pinpoint's room/role code for precedent) or designed fresh if pinpoint has no equivalent.

## Relevant files/areas (reference, in sibling project `pinpoint`)

- `/home/eric/projects/pinpoint/README.md` — architecture, dev/build/deploy commands, env vars.
- `/home/eric/projects/pinpoint/package.json` — npm workspaces script pattern to mirror (`build`, `dev`, `dev:server`, `dev:client`, `typecheck`, `test`).
- `/home/eric/projects/pinpoint/packages/client/src/common/cast.ts` — Cast Sender SDK integration to port/adapt.
- `/home/eric/projects/pinpoint/packages/client/receiver.html` — second Vite entry point for the TV receiver build.
- `/home/eric/projects/pinpoint/packages/client/src/receiver/App.tsx`, `main.tsx` — receiver app structure to mirror.
- `/home/eric/projects/pinpoint/packages/client/src/player/App.tsx`, `screens.tsx` — player app structure to mirror.
- `/home/eric/projects/pinpoint/packages/server/src/net/server.ts`, `rooms.ts` — Socket.IO room registry pattern.
- `/home/eric/projects/pinpoint/packages/server/src/engine/engine.ts`, `project.ts` — server-authoritative engine + spectator-safe projection pattern to mirror for music trivia's much simpler state.
- `/home/eric/projects/pinpoint/packages/shared/src/types.ts`, `protocol.ts`, `projection.ts` — wire-protocol/type pattern to mirror.
- `/home/eric/projects/pinpoint/.env.example` — env var pattern (`CAST_RECEIVER_APP_ID`, `PUBLIC_BASE_URL`, `PORT`) to mirror, swapping `ANTHROPIC_API_KEY` for nothing (no AI generation needed here) and keeping the rest.
- `/home/eric/projects/pinpoint/docker-compose.yml`, `Dockerfile` — reference only; not needed until Phase 6 deploy.

## Repo commands & tree state

- **Repo root**: `/home/eric/projects/music-trivia` — brand-new, empty except `.gitignore` and this `.claude/plans/` dir. `git init` already run (no commits yet, no remote).
- **Node**: v24.14.0, **npm**: 11.9.0 — both on `PATH`, confirmed working directly (no nvm/version-manager wrapper needed here).
- **Python**: 3.12.3 at `/usr/bin/python3`, confirmed on `PATH`. No virtualenv exists yet — the plan must create one (e.g. `python3 -m venv .venv` under wherever the question-bank script lives) and all invocations in the plan/build/test steps must use the venv's interpreter/pip explicitly (e.g. `./path/to/.venv/bin/python`, `./path/to/.venv/bin/pip`), not bare `python`/`pip`.
- **Expected top-level scripts** (mirroring pinpoint, to be created by the plan): `npm install`, `npm run dev` (concurrently runs server + client dev servers), `npm run build`, `npm run typecheck`, `npm test` (workspaces `--if-present`).
- No existing uncommitted changes to account for — this is a clean slate.
