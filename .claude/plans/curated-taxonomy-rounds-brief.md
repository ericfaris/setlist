# Curated Category Taxonomy + Multi-Round Game Structure — Concept Brief

## Problem

The just-shipped setlist mode builds its category labels via an LLM at bank-build time — unpredictable naming, and the resulting bank is small (7 categories, 8 songs each = 56 songs total), so repeats happen quickly across games. The host also currently free-browses any song from the whole setlist each turn, which the user wants replaced with a more structured, game-show-like round format.

## Goal

1. **Replace AI-invented category names with a fixed, curated taxonomy** the user maintains as an editable config in the offline Python builder (`scripts/questionbank/build_bank.py`) — not decided by an LLM at build time. Each category maps to its own YouTube Music search/playlist-aggregation strategy, aiming for hundreds to low-thousands of songs per category (by aggregating several large curated community playlists per category, not a single search call), so repeats become rare across many games.
2. **Replace the current free-browse-any-song setlist UX with a fixed 3-round game structure**: at the start of each round, the host picks a number of categories (5 for round 1, 4 for round 2, 3 for round 3), the server randomly samples 5 songs from each chosen category, and gameplay auto-advances through those songs in a fixed round-robin order (one song per category, cycling, until that round's pool is exhausted) — fully automatic sequencing, no more host free-picking a song each turn. Round 1 = 25 songs, round 2 = 20 songs, round 3 = 15 songs, 60 songs total per game, then automatic `GAME_OVER`.
3. Before each question starts, the **upcoming category name** is shown to everyone (all players and the TV) — e.g. "Next up: 90s Grunge" — but the song itself (title/artist) stays hidden from everyone except the host, exactly as today (the host still needs to see it to go play it via the existing YouTube Music link + tap-to-arm flow).

This is specifically a rework of **how the bank is categorized** and **how songs get selected/sequenced**, not a rework of the buzz race, scoring, judging, tap-to-arm-and-play-via-YouTube-Music-link mechanics, or the host-never-buzzes rule — all of that carries over unchanged from the currently-shipped design.

## In scope

### Category taxonomy (the offline builder)

A fixed, **config-driven** (not hardcoded-logic) list of categories, each with its own search/aggregation strategy (multiple community-search queries and/or known community playlist ids per category, aggregated and deduped by videoId, same `isExplicit` hard filter as today). The starter taxonomy, agreed with the user in this conversation:

**Plain genre categories** (all eras mixed): Pop, Rock, Hip-Hop/Rap, R&B/Soul, Country.

**Genre × decade sub-categories** (only where the genre has meaningful real content that era):
- Pop, Rock, R&B/Soul, Country: 50s, 60s, 70s, 80s, 90s, 2000s, 2010s, Today's (8 decades each)
- Hip-Hop/Rap: 80s, 90s, 2000s, 2010s, Today's (5 decades — genre didn't meaningfully exist before)

**Rock sub-genres** (Rock only, for this pass — other genres can get the same treatment later since the taxonomy is a config, not a one-time hardcoded decision): Grunge, Classic Rock, Hard Rock, Alternative Rock, Indie Rock, Southern Rock, Psychedelic Rock, Garage Rock, Yacht Rock.

**Cross-genre "hits by era" categories**: 50s & 60s Oldies, 70s Hits, 80s Throwbacks, 90s Nostalgia, 2000s Pop, 2010s Chart Toppers, Today's Hits.

**Special/format categories**: Boy Bands/Girl Groups, Solo Artists, One-Hit Wonders.

Total: 5 + 37 (genre×decade) + 9 (rock sub-genres) + 7 (cross-genre) + 3 (special) = **~61 categories**. This is the starter set — the config format must make it easy for the user to add/remove/edit categories later without needing another full redesign.

### Bank schema

The on-disk `QuestionBank`/`BankCategory`/`BankQuestion` format (`packages/shared/src/questions.ts`) stays structurally unchanged — this is purely a change to *how* `build_bank.py` populates categories, not the schema itself. A category is still `{ id, title, playlistId, questions[] }`; `playlistId` becomes meaningless/null for these aggregate categories (they're not one playlist), matching the existing optional/nullable handling already in place from the AI-categorization feature.

### Game structure (server + client)

- A new step after `LOBBY` (each round, not just once): the host picks categories from the bank's full taxonomy — 5 for round 1, 4 for round 2, 3 for round 3.
- Server samples 5 songs per chosen category, tracking used songs **per game** (across all 3 rounds) so a category picked again in a later round excludes anything already played.
- Gameplay auto-advances round-robin through the round's sampled songs (category A song 1, category B song 1, ... category N song 1, then back to category A song 2, etc.) — the current free-browse "tap any song" UI is replaced; the host no longer chooses which song plays next, only which categories are in the round.
- Before each question, the **category name** is shown to all players and the TV (new: today nothing is shown before a question starts). The song identity itself stays hidden from everyone but the host, exactly as today.
- After round 3's last song, the game automatically ends (`GAME_OVER`, final scores) — no round 4. The host can still end the game early at any point via the existing "End game" action.
- Everything else — buzz race (server-timestamped, first-in-wins), the host's tap-to-arm + YouTube Music link + manual reveal flow, flat scoring, host-never-buzzes exclusion (including its interaction with host-transfer-on-disconnect), reconnect/pause/Cast handshake — carries over unchanged.

## Out of scope

- No changes to the buzz race, scoring formula, judging flow, tap-to-arm/YouTube-Music-link mechanics, or host-exclusion-from-buzzing rules.
- No sub-genre breakdowns for Pop/Hip-Hop/R&B/Country in this pass — Rock gets the deep sub-genre treatment now; the config-driven design should make adding the same depth to other genres later a config change, not a redesign, but building those specific sub-genre lists now is not required.
- No UI/mechanism for a host to build a *custom* ad-hoc round (picking specific songs, not just categories) — round composition is always "N categories, 5 random songs sampled per category."
- No cross-game repeat prevention — used-song tracking is per-game only (resets on rematch/new game), matching how `used` tracking already works today.
- No change to the fundamental reconnect-token/disconnect-grace/pause/Cast-handshake machinery beyond whatever phase-name/state additions this round structure requires.

## Constraints

- **Category taxonomy is a config, not hardcoded logic** — the planner/executor should design a clear, editable data structure (e.g. a Python list of category definitions, each with a name and its search/playlist strategy) in `build_bank.py`, not a long if/elif chain. This is the user's explicit ask given how much the list grew during this conversation, and it directly enables the "add Pop sub-genres later" out-of-scope item to actually be cheap when the user wants it.
- **Volume strategy**: for each category, aggregate **3-5 large community playlists** matching that theme (many "Ultimate 80s Hits"-style playlists run 300-1000+ tracks) via multiple targeted `search_community_playlist` queries per category, not a single search call. Fetch each playlist's **full** track list — remove/raise the current `client.get_playlist(pid, limit=200)` cap (`ytmusicapi` supports fetching a playlist's complete track list; confirm and use that), since a 200-song cap on a 500+ song playlist would silently truncate the best sources. Dedupe by videoId across all aggregated playlists within a category (real overlap is expected and fine — the point is the union, not the sum). Target **at least 300 unique songs per category** where the content exists to support it (broad categories like Rock, Pop, 80s Pop should clear this comfortably); narrow/niche categories (Yacht Rock, Garage Rock, Psychedelic Rock) may genuinely not have 300 real distinct songs available on YouTube Music at all, no matter how many playlists are aggregated — that is a real content ceiling, not an engineering shortfall. Document actual per-category counts after a build rather than enforcing or faking a minimum. Reuse the existing community-playlist ingestion machinery (`parse_playlist_id`, `search_community_playlist`, `client.get_playlist`) already in `build_bank.py` — this is a new *orchestration* layer over existing ingestion primitives, not new low-level YouTube Music API code.
- **Build time**: aggregating multiple full-length playlists across ~61 categories will make a full bank rebuild take meaningfully longer than the current build (likely tens of minutes rather than seconds). The builder should print clear per-category progress (which category, which playlist, running song count) so a long build doesn't look hung.
- **This is a live, deployed app** at `https://setlist.mooseflip.com` (Docker, `docker compose up -d --build`). The existing deployment pattern applies unchanged.
- **Spectator-safety discipline holds**: the upcoming category name is a new *public* field (safe — it's not the answer), but the song identity (title/artist/videoId) stays exactly as privileged as it is today (host-only until reveal, receiver never sees it). Do not accidentally widen any existing secret while adding the category-preview feature.
- **Reuse existing patterns**: the host-only privileged-action pattern (`setlist:start`, etc.), the spectator-safe field-by-field projection discipline (`toPublicRoom`/`toPrivateState`, never spread), the `pickedByPlayerId` host-exclusion mechanism, and the reconnect/pause/Cast machinery are all a stable foundation from the just-shipped setlist redesign — treat them as such, not something to rebuild.

## Acceptance criteria

1. `build_bank.py` produces a bank with categories drawn from the fixed, config-driven taxonomy above (or a clearly documented, easily-editable subset/starter if full coverage isn't achievable in one pass — e.g. some genre×decade combos may yield too few real songs and should be dropped/flagged rather than shipped nearly-empty), not LLM-invented names.
2. Categories aggregate from multiple community playlists per theme where available, materially increasing song counts per category versus the current 8-per-category bank (exact per-category counts will vary by how much real content exists for that theme — document actual results, don't fabricate a guaranteed minimum).
3. At the start of round 1, the host is prompted to pick exactly 5 categories from the bank's available taxonomy; round 2 prompts for 4; round 3 prompts for 3.
4. Each chosen category contributes 5 randomly-sampled, not-yet-used-this-game songs to the round.
5. Gameplay auto-advances through the round's songs in round-robin order by category (not host-picked per question) until the round's pool is exhausted.
6. Before each question, the category name is visible to all players and the TV; the song's title/artist/videoId remain hidden from everyone but the host until reveal, exactly as today.
7. A song already played earlier in the same game (in an earlier round) is never re-sampled if its category is picked again in a later round.
8. After round 3's last question is resolved (judged or auto-skipped after all retries — wait, no, that's the removed substitution feature; after round 3's last question reaches `REVEAL` and the host advances), the game automatically transitions to `GAME_OVER` with final scores — no round 4 is offered.
9. All the existing mechanics — buzz race, tap-to-arm + YouTube Music link, manual reveal, flat scoring, host-never-buzzes (including the `pickedByPlayerId`/host-transfer interaction), reconnect/pause/Cast handshake — continue to work exactly as they do in the currently-shipped build.
10. `npm run typecheck` and `npm test` (server + client workspaces) pass, and the Python builder's test suite (`scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v`) passes, reflecting the new category-config and round-structure logic.

## Open questions & decisions made

- **Plan review**: carried over from this conversation's established pattern — user should be asked explicitly in Phase 1 (not yet asked this turn) whether to review the plan before build; default to reviewing given the size of this change.
- **Category taxonomy**: the ~61-category starter list above, agreed explicitly in this conversation — decided.
- **Sub-genre depth**: Rock gets sub-genres this pass; other genres deferred (config makes this cheap later) — decided.
- **Round structure**: 3 fixed rounds, 5/4/3 categories, always 5 songs per category (25/20/15 songs), 60 total, then automatic `GAME_OVER` — decided.
- **Repeat prevention**: used-song tracking spans the whole game (all 3 rounds), resets on rematch — decided.
- **Still open for the planner to decide and document** (not blocking, but should be resolved explicitly in the plan):
  - The exact search-query/playlist-aggregation strategy per category (which community-search terms or known playlist ids to use for each of the ~61 categories) — the planner should design a reasonable, documented default strategy per category type (e.g., genre×decade → `"{decade} {genre} hits"` style queries; sub-genre → `"{subgenre} songs"` style; cross-genre era categories → `"{era} hits"`/`"{era} classics"`), acknowledging actual results will vary and some categories may need hand-tuning later.
  - Exact UI/UX for the host's category picker each round (how ~61 categories are browsed/searched/selected — a flat list is likely too long; consider grouping by the taxonomy's own structure, e.g. genre sections with decade sub-rows, mirroring how the current setlist screen groups by category).
  - Exact new game-state/phase representation for "host is picking categories for this round" (a new phase distinct from the browsing-a-song phase that's being removed) and how round number (1/2/3) is tracked and surfaced.
  - How a category with fewer than 5 unused songs remaining (e.g., late in round 3, after earlier rounds already used many of its songs) is handled if picked again — planner should decide (e.g., disallow picking it once it can't supply 5 fresh songs, or allow with fewer than 5 sampled) and document the choice.

## Relevant files/areas

- `/home/eric/projects/setlist/scripts/questionbank/build_bank.py` — the primary file for the taxonomy/aggregation rework. Currently has the AI-categorization step (`categories_from_ai`, `build_ai_prompt`, `parse_ai_response`, etc.) which this change replaces with fixed-taxonomy category generation; the existing community-playlist ingestion primitives (`parse_playlist_id`, `search_community_playlist`, `collect_sources`) should be reused/extended, not rewritten from scratch.
- `/home/eric/projects/setlist/scripts/questionbank/test_build_bank.py` — will need substantial new test coverage for the taxonomy-driven category generation, alongside whatever existing tests survive.
- `/home/eric/projects/setlist/packages/shared/src/types.ts` — `SetlistState`/`SetlistSong`/`ActiveQuestion`/`RoomPhase` from the just-shipped setlist redesign; needs new phase(s) for "picking categories this round" and round-tracking fields.
- `/home/eric/projects/setlist/packages/shared/src/projection.ts` — `PublicActiveQuestion`/`PublicRoom`/`PrivateState`; needs a new public "upcoming category" field and whatever the category-picker step needs projected to the host.
- `/home/eric/projects/setlist/packages/server/src/engine/engine.ts` — the core state machine; `startSong`, `buildSetlist`, `eligibleBuzzers`, `pickedByPlayerId`, the host-transfer/buzz-exclusion interaction — all need to be understood and extended, not replaced, for round/category-selection logic.
- `/home/eric/projects/setlist/packages/server/src/engine/project.ts` — spectator-safe projection logic (`toPublicRoom`/`toPrivateState`), field-by-field construction discipline.
- `/home/eric/projects/setlist/packages/client/src/player/screens.tsx` — `SetlistScreen` (the current free-browse UI, being replaced/reworked into a category-picker), `BuzzScreen` (mostly unchanged, but the "now playing" section may need the category preview).
- `/home/eric/projects/setlist/packages/client/src/receiver/App.tsx` — `SetlistTV` and `ArmedTV` (or equivalent) need the category-preview display.
- `/home/eric/projects/setlist/packages/server/src/engine/__tests__/`, `/home/eric/projects/setlist/packages/server/src/net/__tests__/` — heavy rework expected, following the same "test-file disposition table" discipline used in the prior setlist-redesign plan.
- `/home/eric/projects/setlist/README.md` — will need updates describing the new taxonomy/round structure once implemented.

## Repo commands & tree state

- **Repo root**: `/home/eric/projects/setlist`. Working tree is **clean** (confirmed via `git status --short`, no output). Latest commit: `8ec0b04` ("Tap-to-arm the setlist; drop the board-loading sound").
- **Node**: v24.14.0, **npm**: on `PATH` directly.
- **Commands** (from repo root): `npm install`, `npm run build` (shared → client → server order — shared must build first), `npm run typecheck` (workspaces), `npm test` (workspaces, `--if-present`), `npm run dev`.
- **Python**: venv at `scripts/questionbank/.venv` — always invoke via `scripts/questionbank/.venv/bin/python`/`pip`, never bare `python`/`pip`. Test command: `scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v`.
- **Live deployment**: Docker (`docker compose up -d --build`, image `ericfaris/setlist:latest`, container `setlist-app-1`, bound to `127.0.0.1:8900`), publicly reachable at `https://setlist.mooseflip.com` via a Cloudflare Tunnel (remotely managed via the Cloudflare API, already set up). `.env` holds `ANTHROPIC_API_KEY` (may become unused if the AI-categorization step is fully removed — planner's call whether to keep it available for a different purpose or note it as no-longer-needed), `YOUTUBE_API_KEY` (builder-only, opt-in embeddable pre-check — unaffected by this change), `CAST_RECEIVER_APP_ID`, `PUBLIC_BASE_URL`, `QUESTION_BANK_PATH`.
- No pre-existing uncommitted changes to account for.
