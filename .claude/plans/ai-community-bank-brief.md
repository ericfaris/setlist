# AI-Curated Community Question Bank — Concept Brief

## Problem

The question-bank builder (`scripts/questionbank/build_bank.py`) currently only reads the user's own YT Music library playlists, and turns each playlist into one board category verbatim (category title = playlist title). The user wants two things layered on top:

1. **Reach beyond their own library** — pull songs from YouTube Music **community/public playlists** (playlists made by other users, or YT Music's own featured/editorial ones), not just playlists the user personally saved.
2. **AI-generated categories** — instead of "one category per playlist" (literal, mechanical), use an LLM to look at the *pooled* set of songs (from the user's playlists + any community playlists) and invent fun, cross-cutting thematic groupings — e.g. "Songs About Cars," "One-Hit Wonders," "80s Power Ballads" — that pull songs from wherever they came from, not from a single source playlist. The AI should also apply a lightweight secondary content-appropriateness pass on top of (never instead of) YouTube Music's own real `isExplicit` flag per track.

## Goal

Extend the existing offline builder script so a single run can:
- Pool songs from the user's own library playlists **and** from explicitly named community/public playlists or search queries.
- Hard-filter out anything YT Music itself flags `isExplicit: true` — this remains the sole authoritative content signal, non-negotiable, never overridden by AI judgment.
- Send the pool of *remaining* (title, artist) pairs to Claude (Anthropic API) in a single batch call to (a) group them into thematic board categories with fun titles, and (b) flag any track whose title/artist looks inappropriate on its face as an extra conservative pass — anything flagged is dropped, never included, no "keep if unsure."
- Write the same `QuestionBank` JSON contract the Node server already reads (`packages/shared/src/questions.ts` / `packages/server/src/questions/bank.ts`), with a schema adjustment since a category may no longer map 1:1 to a single source playlist.

This is a **build-time, offline** feature — same as the rest of the builder. It never runs live during a game; the Node server only ever reads the JSON file the script writes.

## In scope

- **Community/public playlist ingestion**, via `ytmusicapi`:
  - `search(query, filter="community_playlists")` to find playlists by search term.
  - `get_playlist(playlistId)` on any public playlist id or URL (not just the user's own) to pull its tracks.
  - New CLI flags (repeatable, additive to the existing `--playlists` for the user's own library):
    - `--community-playlist <ID_OR_URL>` — pull a specific public playlist by id or a pasted share URL (accept both; extract the id from a URL).
    - `--community-search "<query>"` — search community playlists for `<query>` and pull the top match (planner should decide exact match-selection behavior and document it — e.g. "first result," and log what was picked so a user can sanity-check).
  - Both flags are repeatable and can be combined with each other and with `--playlists` in the same run. If none of `--playlists`/`--community-playlist`/`--community-search` are given, fall back to today's behavior (all of the user's own library playlists).
- **AI category generation**, via the official Anthropic Python SDK (`anthropic` package, add to `requirements.txt`):
  - One batch call (not per-song) sending the pooled, already-`isExplicit`-filtered list of `{title, artist}` pairs (no video ids needed in the prompt — the AI never chooses or invents songs, only groups/labels/flags ones that are already real and already pooled).
  - Model: `claude-haiku-4-5-20251001` by default, overridable via `ANTHROPIC_MODEL` env var — same env var name and same default model pinpoint already uses (see `/home/eric/projects/pinpoint/.env.example`), for consistency across the two sibling projects. API key via `ANTHROPIC_API_KEY` env var, same naming convention.
  - Default category count: the board size the game already uses, `BOARD_COLUMNS = 5` (`packages/shared/src/types.ts`), overridable via a new `--categories N` flag.
  - Response must map every surviving song to exactly one AI-chosen category with a category title; parse robustly (the AI's reply may not be perfectly clean JSON — see pinpoint's `extractNames()` in `/home/eric/projects/pinpoint/packages/server/src/ai/generator.ts` for the house pattern of "prefer JSON, fall back to permissive parsing" to mirror in Python).
  - **Secondary content pass, same call or a clearly separated second call (planner's choice, document the tradeoff)**: the AI additionally flags any track whose title/artist alone looks inappropriate for a family/party setting despite not being marked `isExplicit`. Anything flagged is dropped from the bank entirely — conservative default, exclude when unsure, no partial/"maybe" bucket surfaced to the user to adjudicate in v1.
  - **Graceful fallback when no AI is available**: if `ANTHROPIC_API_KEY` is unset, or the API call fails/errors, the script must **not** hard-fail — fall back to the existing one-category-per-playlist behavior (each source playlist, including community ones, becomes its own category, titled with the playlist's own title) and print a clear message explaining why AI categorization was skipped. This mirrors pinpoint's own house pattern of "AI enhances, but the app always works without a key" (see pinpoint's README: "falls back to bundled seed cards if unset").
- **Schema change** (touches both the Python builder and the shared TypeScript contract, since the Node server validates and reads this file):
  - `BankCategory` currently requires `playlistId: string` (`packages/shared/src/questions.ts`) and the builder derives `id: cat_<playlistId>` — both assume one category maps to exactly one source playlist. An AI-generated cross-cutting category pulls from many source playlists, so this must change:
    - `playlistId` becomes optional (`string | null`), populated only when a category *does* map 1:1 to a single source playlist (the graceful-fallback path); `null` for AI-generated cross-cutting categories.
    - Category `id` needs a derivation that doesn't depend on `playlistId` for the AI path — e.g. a slug of the AI-chosen title plus a short hash/counter for uniqueness. Document the exact scheme chosen.
  - Update `validateQuestionBank` in `packages/shared/src/questions.ts` to match the relaxed schema.
  - Update the existing Python-side schema mirror/tests in `scripts/questionbank/test_build_bank.py` (`SchemaTests`) accordingly.
- **CLI plumbing**: `--categories N` (default `BOARD_COLUMNS`, i.e. 5 — keep in sync or read the real constant; planner should decide whether to hardcode `5` with a comment pointing at the TS source of truth, or another reasonable approach, and document it), plus whatever flags the community-playlist ingestion needs per above.
- **Tests**: extend `scripts/questionbank/test_build_bank.py` (currently 20 tests, all offline/mocked) to cover the new code paths — community playlist search/fetch (mocked `YTMusic` responses, same pattern as today), AI categorization (a fake/mocked Anthropic client returning canned category JSON — no real network call, no real API key needed to run the suite), the `isExplicit` hard filter, the AI secondary content-flag drop, the no-API-key fallback path, and the relaxed schema (`playlistId` optional).

## Out of scope

- The AI never invents, searches for, or chooses which songs exist — it only groups/labels/flags songs that are already real, already pooled from `ytmusicapi`, and already carry a real video id. No hallucinated songs can enter the bank.
- Per-song AI calls — one batch call per builder run, not N calls for N songs.
- Any live/in-game use of the Anthropic API — this stays entirely in the offline builder script, never called by the Node server or during a running game.
- Any change to the Node/TypeScript game engine, Socket.IO protocol, or client UI beyond the minimal `QuestionBank`/`BankCategory` shared-type schema relaxation described above (`playlistId` optional) needed so the server keeps accepting bank files the updated builder produces.
- A UI/adjudication flow for content the AI is "unsure" about — the v1 behavior is a hard drop, not a review queue.
- Automated/scheduled bank regeneration — this remains a manual, offline script run, same as today.
- Any change to `oauth.json`/`browser.json` auth for the user's *own* library — community/public playlist reads use the same authenticated `YTMusic` client already in hand (public playlists are readable by any authenticated client; no separate auth path needed).

## Constraints

- **Language**: Python, extending the existing `scripts/questionbank/build_bank.py` and its venv (`scripts/questionbank/.venv`) — do not introduce a Node/TS reimplementation of any of this.
- **Anthropic Python SDK**: add `anthropic` to `scripts/questionbank/requirements.txt`, pinned similarly to the existing `ytmusicapi>=1.7,<2` style (planner picks a sensible version constraint).
- **Env vars**: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-haiku-4-5-20251001`) — same names pinpoint uses, for a consistent mental model across sibling projects, but these are read by the **Python script**, not the Node server (no change needed to the Node server's own env handling, `docker-compose.yml`, or `.env.example` unless the planner finds a good reason — flag if so).
- **Existing test isolation must be preserved**: all 20 current Python tests mock the `YTMusic` client and touch no network; the new tests must mock the Anthropic client the same way (inject a fake client object, same pattern `build_bank(client, opts, log)` already uses for `YTMusic` — a natural second injected dependency, e.g. `build_bank(yt_client, ai_client, opts, log)` or similar; planner's call on exact signature).
- **This is a live, already-deployed app.** `music-trivia` is running in Docker on this machine at `127.0.0.1:8900` (see `docker-compose.yml`, `Dockerfile`), full test suite currently passing. The schema relaxation in `packages/shared/src/questions.ts` must not break the already-committed `packages/server/src/questions/sample-bank.json` fixture (it has `playlistId` on every category already — that stays valid since the field only becomes *optional*, not removed) or the currently-passing TypeScript test suite.
- **Working tree is not clean right now** — there are pre-existing uncommitted changes from an unrelated, already-tested-and-deployed session of bug fixes (answer-leak fix in `project.ts`/`screens.tsx`, a board-category-shuffle fix in `engine.ts`, a cache-bust redirect fix in `index.ts`, a persistent TV-status strip in `App.tsx`/receiver `App.tsx`, and new `Dockerfile`/`docker-compose.yml`/`.dockerignore`). These are **not** part of this feature and should not be attributed to it, reverted, or assumed to be the executor's own uncommitted work-in-progress — they've already been typechecked, tested, and redeployed successfully in a prior session. The executor should leave them as-is (they're additive, not conflicting with this feature's files) and only commit its own new changes if the user has asked for a commit.

## Acceptance criteria

1. Running the builder with only `--community-playlist <id>` (no `--playlists`) successfully pulls tracks from that public playlist via `get_playlist`, without requiring it to be in the user's own library.
2. Running the builder with `--community-search "<query>"` calls `search(filter="community_playlists")`, selects a playlist from the results, logs which one it picked, and pulls its tracks via `get_playlist`.
3. With `ANTHROPIC_API_KEY` set (mocked client in tests / real key manually if the user wants to try it live), the pooled song list is sent in one batch call and the resulting bank's categories are AI-chosen thematic groupings (not one category per source playlist) with every song's `isExplicit` field having been checked and any `true` ones excluded before ever reaching the AI.
4. A track that is not `isExplicit` but whose title/artist the AI's secondary pass flags as inappropriate is excluded from the final bank — verified with a mocked AI response that flags a specific fabricated test track.
5. With `ANTHROPIC_API_KEY` unset (or the mocked AI client simulating an API error), the builder does **not** crash — it falls back to one-category-per-source-playlist behavior and prints a clear explanatory message.
6. `--categories N` controls how many AI-generated categories are requested; omitting it defaults to 5 (matching `BOARD_COLUMNS`).
7. The relaxed `QuestionBank`/`BankCategory` schema (`playlistId` now optional) is reflected in `packages/shared/src/questions.ts`'s `validateQuestionBank`, and the already-committed `sample-bank.json` fixture still validates successfully (regression check).
8. All existing 20 Python tests plus new ones for community playlists, AI categorization, the explicit/content filters, and the no-API-key fallback pass via `scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v`, with zero real network calls or real API keys required to run the suite.
9. `npm run typecheck` and `npm test` (from the repo root, workspaces) still pass after the shared-type schema change — no TypeScript-side regression.

## Open questions & decisions made

- **Plan review**: user chose to **review the plan** before build starts (Phase 3 gate applies as normal — do not skip to execution without showing the user the plan first).
- **Community playlist input**: CLI flags, decided (`--community-playlist`, `--community-search`), not a config file.
- **Category count**: fixed default of `BOARD_COLUMNS` (5) with a `--categories N` override flag, decided — not "AI decides freely."
- **Age-appropriateness mechanism**: `isExplicit` is the hard, authoritative filter (non-AI); AI does an additional conservative secondary pass over titles/artists only, dropping anything it flags — decided.
- **AI call design**: one batch call using `claude-haiku-4-5-20251001` (same default model pinpoint uses) — decided, not Sonnet, not per-song calls.
- **Test strategy**: mock both the `YTMusic` client (already the pattern) and the Anthropic client — decided, no real network/API key needed for `npm test`/the Python suite ever.
- **Still open for the planner to decide and document** (not blocking, but should be resolved explicitly in the plan):
  - Exact prompt structure and response-parsing robustness strategy for the category-generation call (mirror pinpoint's `extractNames()` fallback-parsing philosophy in Python).
  - Whether the content-safety secondary pass is the same API call as categorization or a separate one — document the tradeoff (one call is cheaper/simpler; two calls separates concerns and might be more reliable to parse) and pick one.
  - Exact category `id` derivation scheme once it no longer depends on `playlistId` (e.g. slugified title + short hash).
  - Exact playlist-URL-to-id extraction logic for `--community-playlist` (YT Music share URLs have a few known formats — handle the common ones, document which).
  - Whether `--community-search` picks strictly the first search result or applies any lightweight ranking — keep it simple and document the choice.

## Relevant files/areas

- `/home/eric/projects/music-trivia/scripts/questionbank/build_bank.py` — the file being extended; read it in full, it's ~360 lines and already establishes the house style (dependency-injected client for testability, `BuildError` for user-actionable failures, careful optional-field parsing since `ytmusicapi` is unofficial and drifts).
- `/home/eric/projects/music-trivia/scripts/questionbank/test_build_bank.py` — the existing 20-test suite to extend, all offline/mocked.
- `/home/eric/projects/music-trivia/scripts/questionbank/requirements.txt` — currently just `ytmusicapi>=1.7,<2`; add `anthropic`.
- `/home/eric/projects/music-trivia/packages/shared/src/questions.ts` — the `QuestionBank`/`BankCategory` TypeScript contract and `validateQuestionBank` runtime validator; needs the `playlistId` → optional change.
- `/home/eric/projects/music-trivia/packages/server/src/questions/sample-bank.json` — the committed fixture; must keep validating after the schema relaxation (regression, not a file to redesign).
- `/home/eric/projects/music-trivia/packages/server/src/questions/bank.ts` — the Node-side loader that reads the JSON file at server startup; check whether it needs any change (likely not, since it just passes through to `validateQuestionBank`, but confirm).
- `/home/eric/projects/pinpoint/packages/server/src/ai/generator.ts` — the house pattern for calling the Anthropic API: JSON-first response parsing with a permissive fallback (`extractNames()`), `stop_reason === 'refusal'` handling, structured prompt construction. Mirror the *philosophy* in Python — this is TypeScript using `@anthropic-ai/sdk`, the Python builder will use the `anthropic` PyPI package instead, but the parsing-robustness lesson (unofficial/LLM output isn't guaranteed clean JSON) applies identically.
- `/home/eric/projects/pinpoint/.env.example` — confirms the `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` naming convention to mirror.
- `/home/eric/projects/music-trivia/README.md` — should get a short new section documenting the community-playlist flags and AI categorization (env vars, fallback behavior) alongside the existing "Question bank" setup instructions; planner should include this as a task.

## Repo commands & tree state

- **Repo root**: `/home/eric/projects/music-trivia`.
- **Node**: v24.14.0, **npm**: 11.9.0, on `PATH` directly.
- **Node commands**: `npm run typecheck` (workspaces), `npm test` (workspaces, `--if-present`), `npm run build`, `npm run dev` — all as established in prior sessions, unchanged.
- **Python**: venv already exists at `scripts/questionbank/.venv` (Python 3.12.3, `ytmusicapi` 1.12.1 installed). Always invoke via `scripts/questionbank/.venv/bin/python` and `scripts/questionbank/.venv/bin/pip` — never bare `python`/`pip`. After adding `anthropic` to `requirements.txt`, install it with `scripts/questionbank/.venv/bin/pip install -r scripts/questionbank/requirements.txt`.
- **Python test command**: `scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v`.
- **Git**: repo is initialized, 2 commits so far (`b1c51da`, `28a72bd`), no remote. Working tree **currently has uncommitted changes** — see the "Constraints" section above for the full list; they are pre-existing, already tested/deployed, and unrelated to this feature. Do not attribute them to this feature's build, and do not revert/discard them.
- **Live deployment**: the app is running in Docker (`docker compose up -d --build`, image `ericfaris/music-trivia:latest`) bound to `127.0.0.1:8900` on this machine. This feature (an offline Python builder change plus a shared-type relaxation) does not require touching the Docker setup, but the Node-side schema change should be verified against a rebuild (`npm run build`) even though a full redeploy is a separate, later, explicitly-gated step (not part of this feature's build phase).
