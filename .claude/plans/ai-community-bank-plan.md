# Implementation Plan — AI-Curated Community Question Bank

Concept brief: `/home/eric/projects/music-trivia/.claude/plans/ai-community-bank-brief.md`
(read it too; this plan is the authority where the two differ, since it resolves
the brief's open decisions).

---

## 0. Before you touch anything — working-tree state

The repo `/home/eric/projects/music-trivia` **already has uncommitted changes that
are not yours and not part of this feature**. `git status --short` currently shows:

```
 M packages/client/src/player/App.tsx
 M packages/client/src/player/__tests__/screens.test.tsx
 M packages/client/src/player/screens.tsx
 M packages/client/src/receiver/App.tsx
 M packages/server/src/engine/engine.ts
 M packages/server/src/engine/project.ts
 M packages/server/src/index.ts
 M packages/server/src/net/__tests__/integration.test.ts
?? .claude/plans/ai-community-bank-brief.md
?? .dockerignore
?? Dockerfile
?? docker-compose.yml
```

These come from a prior, already-tested-and-deployed session (answer-leak fix,
board-shuffle fix, cache-bust redirect, TV status strip, Docker packaging).

- **Do not revert, stash, `git checkout`, or "clean up" any of them.**
- **Do not describe them as your work** in any summary or commit message.
- None of them overlap with this feature's files. If `npm test` fails in one of
  those files, that is pre-existing — investigate, report, but do not "fix" it by
  reverting someone else's change.
- Only commit if the user explicitly asks. If asked, stage **only** the files this
  plan tells you to create/modify.

Environment rules (non-negotiable):

- Python: **always** `scripts/questionbank/.venv/bin/python` and
  `scripts/questionbank/.venv/bin/pip`. Never bare `python`/`pip`.
  (venv: Python 3.12.3, `ytmusicapi` 1.12.1 already installed; `anthropic` is not.)
- Node v24.14.0 / npm 11.9.0 are on `PATH`. All npm commands from the repo root.
- The app is **live** in Docker at `127.0.0.1:8900`. This feature does not require
  a redeploy; do **not** run `docker compose` anything. Deployment is a separate,
  explicitly-gated step the user triggers later.
- No network calls at test time, ever. No real `ANTHROPIC_API_KEY` needed to run
  any test.

---

## 1. Summary

`scripts/questionbank/build_bank.py` today reads only the user's own YouTube Music
library playlists and mechanically turns each playlist into one board category
(category title = playlist title, `id = cat_<playlistId>`). This change layers two
capabilities on top, entirely inside that offline builder: (a) **community/public
playlist ingestion** — new repeatable `--community-playlist <ID_OR_URL>` and
`--community-search "<query>"` flags that pull tracks from playlists the user does
not own, via `ytmusicapi`'s `get_playlist()` and `search(filter="community_playlists")`;
and (b) **AI-generated categories** — the pooled songs from all sources (after a
hard, non-negotiable drop of anything YT Music flags `isExplicit: true`) are sent
to Claude in a *single* batch call that groups them into fun cross-cutting themes
("Songs About Cars", "One-Hit Wonders") and simultaneously flags any track whose
title/artist looks inappropriate for a family setting, which is then dropped. If
`ANTHROPIC_API_KEY` is unset or the call fails in any way, the builder logs why and
falls back to today's exact one-category-per-playlist behaviour rather than failing.
Because an AI category draws from many source playlists, `BankCategory.playlistId`
in `packages/shared/src/questions.ts` relaxes from required to optional/nullable —
the only TypeScript-side change in this feature.

---

## 2. Approach & key decisions

These resolve every item the brief left "still open for the planner".

### 2.1 One AI call, not two (categorization + safety in the same request)

**Decision: a single `messages.create()` call returns both the category assignments
and the content-flag list.**

Justification (the deciding factor is not cost):

- **Index alignment.** The prompt enumerates the pooled songs with stable integer
  indices and the model answers in those indices. With one call there is exactly
  one enumeration, so "song 17 is blocked" and "song 17 is in category 2"
  unambiguously refer to the same track. Two calls means two enumerations that must
  be kept byte-identical; any drift (a re-sample, a re-sort, a truncation) silently
  mis-targets the safety verdicts — a correctness hazard on the *safety* path,
  which is the one path we least want to be subtly wrong.
- Cheaper and one round trip; the model reads the song list once.
- The safety verdict and the grouping decision are made with the same context.

Documented tradeoff (write this as a comment in the code, near the prompt): two
calls would isolate parse failures — if categorization JSON is malformed you could
still apply safety flags — and each response would be a simpler shape to parse.
With one call, a parse failure loses both, and we fall back to
one-category-per-playlist with **no** AI safety pass. That is acceptable because
`isExplicit` remains the authoritative filter and always runs (it is applied before
the AI is consulted at all), and the fallback is exactly today's shipped behaviour,
which has never had an AI safety pass. Conservatism is preserved where it matters:
anything the AI *does* flag is always dropped.

### 2.2 Prompt structure

Build the user message from the pooled songs, enumerated:

```
You are helping build a family-friendly music trivia game board.

Below is a numbered list of real songs. Do TWO things:

1. Group them into exactly {n} fun, cross-cutting trivia categories with short,
   punchy titles (e.g. "Songs About Cars", "One-Hit Wonders", "80s Power Ballads").
   Titles must be 40 characters or fewer. Use only the numbers below — never
   invent, rename, or substitute a song. Each song belongs to at most one
   category. It is fine to leave songs out if they fit nowhere. Aim for at least
   {min_songs} songs per category.

2. Separately, flag any song whose title or artist name alone looks inappropriate
   for a family party setting (sexual content, slurs, graphic violence, drug
   glorification). Be conservative: when in doubt, flag it. Flagged songs must NOT
   also appear in any category.

Songs:
1. "Never Gonna Give You Up" — Rick Astley
2. "Take On Me" — a-ha
...

Respond with ONLY a JSON object of this exact shape and nothing else:
{"categories": [{"title": "...", "songs": [1, 5, 9]}], "blocked": [3, 7]}
```

Details:

- Numbering is **1-based** in the prompt (models are more reliable with it) and
  converted to 0-based on the way in. Be explicit about this in code.
- Only `title` and `artist` go in the prompt. No `videoId`, no album, no duration.
  The model never sees or chooses song identity — it only emits integers.
- `{n}` = `opts.categories` (default 5). `{min_songs}` = `opts.min_songs`.
- Request params: `model=<ANTHROPIC_MODEL or claude-haiku-4-5-20251001>`,
  `max_tokens=8000`, `messages=[{"role": "user", "content": prompt}]`. No system
  prompt, no temperature override — mirrors pinpoint's
  `/home/eric/projects/pinpoint/packages/server/src/ai/generator.ts` (read it if you
  want the house shape; it's ~100 lines).
- **Pool cap**: to bound tokens, if the pool exceeds `AI_POOL_LIMIT = 300` songs,
  take a seeded `rng.sample(pool, AI_POOL_LIMIT)` (preserving determinism under
  `--seed`) and log `"AI: pooling a sample of 300 of N songs"`.

### 2.3 Response parsing robustness (the Python mirror of `extractNames()`)

pinpoint's `extractNames()` is "prefer JSON found anywhere in the reply, fall back
to permissive line parsing". Our payload is a *nested* object, so line-parsing is
meaningless; the permissive layer instead becomes fence-stripping, brace-slicing
and per-field tolerance. Implement `parse_ai_response(raw: str) -> AIPlan` with
this ladder, each rung tried in order:

1. `json.loads(raw.strip())`.
2. Strip Markdown code fences (` ```json ... ``` `, ` ``` ... ``` `) and retry.
3. Slice the **brace-balanced** substring starting at the first `{` (walk the string
   counting `{`/`}` outside of string literals, honouring `\"` escapes) and retry.
   This is strictly better than pinpoint's greedy `/\{[\s\S]*\}/` regex here,
   because a truncated reply's trailing prose would otherwise poison the match.
4. As a last resort, retry (3) after removing trailing commas before `}`/`]`
   (`re.sub(r",\s*([}\]])", r"\1", s)`).

If all four fail → raise `AIUnavailable("could not parse the model's reply as JSON")`.

Then normalise the parsed object **tolerantly** (never raise on a weird field, just
skip it):

- Accept `categories` or `groups` for the category list; accept `title` or `name`
  for a category title; accept `songs`, `indices`, `tracks`, or `items` for the
  member list.
- Accept `blocked`, `flagged`, or `excluded` for the block list.
- Coerce numeric strings (`"12"`) to `int`; ignore anything not coercible.
- Ignore indices out of range, indices that repeat within a category, and indices
  already claimed by an earlier category (first category wins).
- Ignore categories with a blank/non-string title; truncate titles over 60 chars.
- A missing `blocked` key means "nothing flagged" (empty list), not an error.
- If, after normalisation, there are **zero** categories → raise `AIUnavailable`,
  which triggers the fallback path.

Also treat these as `AIUnavailable` (→ fallback, never a crash):

- `response.stop_reason == "refusal"` (the model declined).
- `response.stop_reason == "max_tokens"` (truncated → JSON will be invalid anyway;
  fail fast with a clear message rather than a confusing parse error).
- No text block in `response.content`.
- Any exception raised by the client (`APIError`, timeouts, auth errors, anything) —
  catch broad `Exception` at the call site and wrap it.

### 2.4 Category id derivation (no longer depends on `playlistId`)

**Scheme: `cat_ai_<slug>_<hash6>`.**

- `slug`: title lowercased, every run of non-`[a-z0-9]` replaced with `_`, leading/
  trailing `_` stripped, truncated to 40 chars. If the result is empty (e.g. a
  fully non-ASCII title), use `category`.
- `hash6`: first 6 hex chars of `hashlib.sha1(title.encode("utf-8")).hexdigest()`.
  Deterministic — no RNG, no timestamp — so rebuilding with the same AI titles
  yields the same ids (matching the file's existing "ids are derived so a rebuild
  doesn't churn them" contract).
- **Collision handling**: keep a `set` of ids emitted this run; on collision append
  `_2`, `_3`, … until unique. (Only reachable if the AI returns the exact same title
  twice; also dedupe such categories' membership via the first-wins index rule.)
- Example: `"80s Power Ballads"` → `cat_ai_80s_power_ballads_3f2a91`.
- The **fallback** path keeps today's `cat_<playlistId>` unchanged — do not change
  it, `test_builds_a_category_per_playlist` asserts `"cat_PL0"`.

### 2.5 Playlist URL → id extraction

`parse_playlist_id(value: str) -> str`, raising `BuildError` with the offending
string when nothing usable is found. Handle, in order:

1. Trim whitespace. Empty → `BuildError`.
2. If it does **not** start with `http://` or `https://` and contains no `/`, treat
   it as a raw id.
3. Otherwise `urllib.parse.urlparse` it and:
   - take query param `list` if present — covers
     `https://music.youtube.com/playlist?list=PLxxxx`,
     `https://www.youtube.com/playlist?list=PLxxxx`,
     `https://music.youtube.com/watch?v=abc&list=PLxxxx`,
     `https://youtu.be/abc?list=PLxxxx`;
   - else, if a path segment follows `browse/`, use it — covers
     `https://music.youtube.com/browse/VLPLxxxx`;
   - else, if the last non-empty path segment starts with `PL`, `OLAK5uy_`, `RD`,
     `VL`, or `MPREb`, use it.
4. Finally, **strip a leading `VL`** from whatever id we ended up with (YT Music
   browse ids are `VL` + playlistId; `get_playlist()` wants the bare id and adds the
   prefix itself).
5. Validate the result matches `^[A-Za-z0-9_-]{10,}$`; otherwise `BuildError`.

Document the supported formats in both a docstring and the README.

### 2.6 `--community-search` selection

**Decision: first usable result, no ranking.** Iterate `search(query,
filter="community_playlists", limit=20)` results in the order returned and take the
first entry that is a dict, whose `resultType` is `"playlist"` (or absent — the
filter already constrains it), and that yields an id from `playlistId` or `browseId`
(the latter run through the `VL`-stripping in §2.5). No sorting by `itemCount`, no
title-similarity scoring — YT Music's own relevance order is already the ranking,
and any heuristic we add is unexplainable to the user. Instead, **log exactly what
was picked** so it can be sanity-checked:

```
  community search "80s hits" -> "Ultimate 80s" by Tate Henderson (PLK1PkW..., 174 items)
```

If a search returns no usable result, log a warning and continue with the other
sources (do not abort the run). If *no* source at all produced tracks, the existing
`BuildError` paths cover it.

### 2.7 `--categories` default of 5

Add a module constant next to the existing `POINT_VALUES` mirror:

```python
# Mirrors BOARD_COLUMNS in packages/shared/src/types.ts (line ~99). Hardcoded
# rather than parsed out of the TS source: the builder already mirrors
# POINT_VALUES the same way, and a 5-line TS parser is more fragile than a
# constant with a comment.
DEFAULT_CATEGORIES = 5
```

### 2.8 Dependency-injection seam

`build_bank`'s existing signature is `build_bank(client, opts, log=print)`. Extend to:

```python
def build_bank(client, opts, log=print, ai_client=None) -> dict[str, Any]:
```

`ai_client` is **keyword-with-default and last**, so all 20 existing tests keep
compiling and calling it positionally with no edits. `None` means "no AI" → fallback
path. Tests pass a `FakeAnthropic`. `main()` builds a real one via
`make_ai_client(log)` (returns `None` if `ANTHROPIC_API_KEY` is unset or the
`anthropic` package is missing — both logged, never fatal).

Duck-typed contract for `ai_client` (document it in the docstring): an object with
`.messages.create(model=..., max_tokens=..., messages=[...])` returning an object
with `.stop_reason` and `.content` (a list of blocks with `.type` and `.text`).
That is exactly the `anthropic.Anthropic` surface pinpoint uses in TS, and it is
trivial to fake with two small Python classes.

---

## 3. Data / model / API changes

### 3.1 `BankCategory` — before

`packages/shared/src/questions.ts` lines 32–39:

```ts
export interface BankCategory {
  /** `cat_<playlistId>` */
  id: string;
  /** Playlist name → board column header. */
  title: string;
  playlistId: string;
  questions: BankQuestion[];
}
```

### 3.2 `BankCategory` — after

```ts
export interface BankCategory {
  /**
   * `cat_<playlistId>` for a category that mirrors one source playlist, or
   * `cat_ai_<slug>_<hash6>` for an AI-generated cross-cutting category.
   * Derived either way, so a rebuild doesn't churn ids.
   */
  id: string;
  /** Board column header — a playlist name, or an AI-chosen theme. */
  title: string;
  /**
   * The single source playlist, when the category maps 1:1 to one. `null` (or
   * absent) for AI-generated categories, which pull from many playlists.
   */
  playlistId?: string | null;
  questions: BankQuestion[];
}
```

Validator change in `validateQuestionBank` (currently lines 82–84):

```ts
// before
if (!isNonEmptyString(rawCat['playlistId'])) {
  return { ok: false, error: `category ${i} missing playlistId` };
}
// after
const playlistId = rawCat['playlistId'];
if (playlistId !== undefined && playlistId !== null && !isNonEmptyString(playlistId)) {
  return { ok: false, error: `category ${i} has an invalid playlistId` };
}
```

i.e. absent / `null` / non-empty-string all pass; `""`, `0`, `{}` still fail.
Nothing else in the validator changes. Also update the file's header comment block
if it asserts one-category-per-playlist.

### 3.3 Anthropic API shape

- SDK: `anthropic` (PyPI), imported **lazily** inside `make_ai_client()` so
  `--help` and the whole test suite work without it installed (same pattern as the
  existing late `from ytmusicapi import YTMusic` in `make_client`).
- Model: `os.environ.get("ANTHROPIC_MODEL") or "claude-haiku-4-5-20251001"`
  (same env var and default as `/home/eric/projects/pinpoint/.env.example`).
- Key: `ANTHROPIC_API_KEY`. Read by the **Python script only** — no change to the
  Node server's env handling, `docker-compose.yml`, or any `.env.example`.
- Request: `client.messages.create(model=MODEL, max_tokens=8000, messages=[{"role": "user", "content": prompt}])`.
- Expected response text (the only shape we ask for):

```json
{
  "categories": [
    { "title": "Songs About Cars",  "songs": [1, 4, 9, 12, 17] },
    { "title": "One-Hit Wonders",   "songs": [2, 6, 11] }
  ],
  "blocked": [3, 8]
}
```

  (1-based indices into the enumerated prompt list; see §2.3 for every tolerated
  deviation from this shape.)

### 3.4 CLI flags added

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--community-playlist ID_OR_URL` | `append`, repeatable | `[]` | Pull a public playlist by id or share URL (§2.5) |
| `--community-search "QUERY"` | `append`, repeatable | `[]` | `search(filter="community_playlists")`, take the first usable result (§2.6) |
| `--categories N` | `int` | `DEFAULT_CATEGORIES` (5) | How many AI categories to request |
| `--no-ai` | `store_true` | `False` | Skip the AI call entirely; force the one-category-per-playlist path (useful for a quick offline rebuild; also makes the fallback path trivially exercisable by hand) |

Existing flags (`--playlists`, `--max-categories`, `--songs-per-category`,
`--min-songs`, `--seed`, `--out`, `--dry-run`, `--auth-mode`, `--auth-file`) keep
their current names, defaults and meanings.

`BuildOptions.__init__` gains, with defaults, **after** the existing params so
positional callers are unaffected: `community_playlists: Sequence[str] = ()`,
`community_searches: Sequence[str] = ()`, `categories: int = DEFAULT_CATEGORIES`.

Semantics note to document: `--max-categories` (8) now caps **how many source
playlists are read** (it already effectively did); `--categories` (5) caps how many
AI categories come out. On the fallback path they behave as today.

---

## 4. Step-by-step tasks

Each step is independently verifiable. Run the Python suite after every Python step.

### Step 1 — dependency

- Edit `scripts/questionbank/requirements.txt`: add `anthropic>=0.40,<1` under the
  existing `ytmusicapi>=1.7,<2`.
- Install: `scripts/questionbank/.venv/bin/pip install -r scripts/questionbank/requirements.txt`
- Verify: `scripts/questionbank/.venv/bin/pip show anthropic` — note the resolved
  version in your final report. **If `<1` no longer resolves** (a 1.x may have
  shipped), relax the pin to `anthropic>=0.40` and say so in the report.
- Verify nothing else broke: `scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v` → 20 passing.

### Step 2 — `isExplicit` hard filter

- In `build_bank.py`, inside `usable_track()` (currently lines 91–119), after the
  `isAvailable is False` check, add:

  ```python
  # Authoritative, non-negotiable content filter: YT Music's own flag. Applied
  # here so every ingestion path (library, community, AI, fallback) gets it, and
  # so no explicit track can ever reach the AI prompt.
  if track.get("isExplicit") is True:
      return None
  ```

- Use `is True` deliberately — a missing/None/unknown value must not drop the track.
- Verify: existing 20 tests still pass (their fixtures carry no `isExplicit`).

### Step 3 — community ingestion helpers (pure functions first)

Add to `build_bank.py`, above `build_bank()`:

- `parse_playlist_id(value: str) -> str` per §2.5.
- `search_community_playlist(client, query, log) -> dict | None` per §2.6 — calls
  `client.search(query, filter="community_playlists", limit=20)`, returns a
  normalised `{"playlistId": ..., "title": ..., "author": ..., "itemCount": ...}`
  or `None`, and logs the pick. Wrap the `client.search(...)` call in
  `try/except Exception` → log a warning, return `None` (unofficial API, drifts).
- These are pure/near-pure and testable with no `build_bank()` involvement.

### Step 4 — source collection refactor

Restructure the body of `build_bank()` into a helper
`collect_sources(client, opts, rng, log) -> list[dict]`, where each source is
`{"playlistId": str, "title": str, "questions": [...]}`:

1. **Library sources** — only when `opts.playlists` is non-empty **or** no
   community flags were given (i.e. preserve today's "no flags = all my playlists"
   default). Same `get_library_playlists(limit=100)` + `playlist_matches()` logic.
2. **`--community-playlist`** — for each value: `parse_playlist_id()`, then
   `client.get_playlist(pid, limit=200)`; title from the detail response's `title`
   (fall back to the id). Wrap in `try/except Exception` → log `"  skip: could not
   read playlist <id>: <err>"` and continue.
3. **`--community-search`** — for each query: `search_community_playlist()`, then
   the same `get_playlist` path.
4. Dedupe sources by playlist id across all three inputs.
5. For each source, run the existing per-track loop verbatim: `usable_track()`,
   global `seen_video_ids` dedupe, `min_songs` check (including the existing
   "release its ids so a later playlist can still use those songs" behaviour), the
   `f"  {title}: {n} songs ({skipped} skipped)"` log line.
6. Stop collecting once `len(sources) >= opts.max_categories` (preserves
   `test_honours_max_categories`).
7. Keep the two existing `BuildError`s with their exact current messages: "No
   playlists matched…" when nothing was selected, and "No playlist had at least N
   usable songs…" when everything was thin.

Then `build_bank()` becomes: `collect_sources()` → either `categories_from_ai()` or
`categories_from_sources()` → assemble the bank dict (unchanged `version`,
`generatedAt`, `source: "ytmusicapi"`).

- `categories_from_sources(sources, opts, rng)` is today's tail-end logic verbatim:
  `rng.sample` down to `songs_per_category`, `POINT_VALUES[min(i, 4)]` assignment,
  `{"id": f"cat_{pid}", "title": title, "playlistId": pid, "questions": [...]}`.
- Verify: **all 20 existing tests still pass unmodified.** This step must be a pure
  refactor. Do not proceed until that is true.

### Step 5 — AI module

Add to `build_bank.py` (keep it in this one file — the house style is a single
self-contained script; do not create a new module):

- `class AIUnavailable(Exception)` — internal, distinct from `BuildError` because it
  is *never* fatal.
- `DEFAULT_MODEL = "claude-haiku-4-5-20251001"`, `DEFAULT_CATEGORIES = 5`,
  `AI_POOL_LIMIT = 300`.
- `build_ai_prompt(songs, n_categories, min_songs) -> str` — §2.2. Pure, testable.
- `parse_ai_response(raw: str) -> tuple[list[dict], list[int]]` — §2.3, returning
  `(categories, blocked)` with **0-based** indices already converted and normalised.
  Pure, testable, no client involved.
- `call_ai(ai_client, prompt, model, log) -> str` — makes the request, handles
  `stop_reason` refusal/`max_tokens`, extracts the first text block, wraps every
  exception in `AIUnavailable`.
- `categories_from_ai(ai_client, sources, opts, rng, log) -> list[dict]`:
  1. Pool = every question from every source, in source order (already globally
     deduped by video id).
  2. If `len(pool) > AI_POOL_LIMIT`, `rng.sample` down to it; log.
  3. Prompt → `call_ai` → `parse_ai_response`.
  4. Drop every `blocked` index from the pool; log `"AI: dropped N track(s) flagged
     by the content pass"`.
  5. For each returned category in order: map indices → pool entries, skipping
     blocked/out-of-range/already-claimed ones; skip the category if it now has
     `< opts.min_songs` songs (log it); `rng.sample` down to
     `opts.songs_per_category`; assign `POINT_VALUES[min(i, 4)]`; emit
     `{"id": make_category_id(title, used_ids), "title": title, "playlistId": None,
     "questions": [...]}`.
  6. Stop at `opts.categories` categories.
  7. Log how many pooled songs went unassigned (expected and fine — say so in the
     log text so it doesn't read as a bug).
  8. If zero categories survived → raise `AIUnavailable("the model returned no
     usable categories")`.
- `make_category_id(title, used_ids) -> str` — §2.4. Pure, testable.

### Step 6 — wire the AI path + graceful fallback

In `build_bank()`:

```python
if ai_client is not None and not opts.no_ai:
    try:
        categories = categories_from_ai(ai_client, sources, opts, rng, log)
    except AIUnavailable as exc:
        log(f"AI categorisation skipped ({exc}); falling back to one category per playlist.")
        categories = categories_from_sources(sources, opts, rng)
else:
    categories = categories_from_sources(sources, opts, rng)
```

- The fallback message must be printed via `log`, i.e. it reaches stdout in real
  runs and is capturable in tests.
- Add `make_ai_client(log) -> Any | None` next to `make_client()`: returns `None`
  (with a clear log line) when `ANTHROPIC_API_KEY` is unset — *"ANTHROPIC_API_KEY
  not set; using one category per playlist. Set it to get AI-generated
  categories."* — or when `import anthropic` fails — *"the `anthropic` package is
  not installed (pip install -r scripts/questionbank/requirements.txt); using one
  category per playlist."* Never raises.
- `main()` calls `make_ai_client(print)` and passes it as `ai_client=`; nothing in
  `main()` may propagate an AI-related exception.

### Step 7 — CLI flags

In `parse_args()`, add the four flags from §3.4 with helpful `help=` text; thread
them through `BuildOptions` in `main()`. Print an AI-vs-fallback line in the final
summary so a real run makes the mode obvious, e.g.
`"Categories: AI-generated (claude-haiku-4-5-20251001)"` or
`"Categories: one per playlist (no AI)"`.

### Step 8 — shared TypeScript schema relaxation

- Edit `packages/shared/src/questions.ts` exactly as specified in §3.1–3.2.
- Do **not** touch `packages/server/src/questions/bank.ts` — confirmed by reading
  it: it only calls `validateQuestionBank` and passes the result through, with a
  fixture fallback on failure. **No change needed there.** (State this explicitly in
  your report so the check is on record.)
- Do **not** modify `packages/server/src/questions/sample-bank.json`. Every category
  in it already carries a non-empty `playlistId`, which stays valid under the
  relaxed rule.
- `packages/server/src/engine/__tests__/harness.ts:71` builds categories with
  `playlistId: \`PL${c}\``. Still valid; leave it.
- `packages/shared/dist/questions.d.ts` is a build output — do not hand-edit; it
  regenerates via `npm run build`.

### Step 9 — Python tests

Extend `scripts/questionbank/test_build_bank.py` (do not create a second test
file — `unittest discover` picks up this one and the house style keeps it
together). Add near `FakeYTMusic`:

```python
class FakeAnthropic:
    """Stands in for anthropic.Anthropic — no network. `text` is the reply body;
    pass raises=<Exception> to simulate an API failure."""
    def __init__(self, text="", stop_reason="end_turn", raises=None): ...
    # exposes .messages.create(**kwargs), recording kwargs in self.calls
```

with tiny `_Messages`, `_Block`, `_Response` shims (`.type == "text"`, `.text`,
`.stop_reason`, `.content`). Extend `FakeYTMusic` with a `search()` method returning
canned community-playlist results and recording the call, and allow tracks for
arbitrary (non-library) playlist ids.

New tests (grouped into new `TestCase` classes alongside the existing three):

*Playlist id parsing* — `PlaylistIdTests`
1. bare id passes through unchanged
2. `https://music.youtube.com/playlist?list=PLxxx` → `PLxxx`
3. `https://www.youtube.com/watch?v=abc&list=PLxxx` → `PLxxx`
4. `https://music.youtube.com/browse/VLPLxxx` → `PLxxx` (VL stripped)
5. a leading `VL` on a bare id is stripped
6. garbage (`"not a playlist"`, `""`, `"https://example.com/"`) raises `BuildError`

*Community ingestion* — `CommunityTests`
7. `--community-playlist` id only, **no** `--playlists`: bank built from that
   playlist, `get_playlist` was called with it, `get_library_playlists` was **not**
   called (AC 1)
8. URL form of the same flag reaches the same playlist id
9. `--community-search`: `search()` called with `filter="community_playlists"`, the
   first usable result's tracks land in the bank, and the log captured the pick
   (AC 2)
10. a search with no usable results logs and does not crash the run when another
    source exists
11. community + library sources combined dedupe a shared video id

*Explicit filter* — add to `UsableTrackTests`
12. `usable_track(track("v1", isExplicit=True))` → `None`
13. `isExplicit: False` / absent → kept
14. end-to-end: an explicit track never appears in the prompt sent to the fake AI
    (assert on `FakeAnthropic.calls[0]["messages"][0]["content"]`) (AC 3)

*AI categorization* — `AICategoryTests`
15. canned response with two themed categories → bank categories have those titles,
    `playlistId is None`, ids match `^cat_ai_[a-z0-9_]+_[0-9a-f]{6}$`, and are **not**
    one-per-source-playlist (AC 3)
16. exactly one `messages.create` call was made regardless of pool size (batch, not
    per-song)
17. `--categories 3` puts "exactly 3" in the prompt and caps output at 3;
    default `BuildOptions()` puts 5 in the prompt (AC 6)
18. a `blocked` index is excluded from the final bank even though it is also listed
    inside a category (AC 4)
19. out-of-range, duplicate, and string-typed indices are tolerated
20. a song assigned to two categories appears only in the first
21. an AI category below `min_songs` is dropped

*Response parsing* — `AIParseTests` (pure, no client)
22. clean JSON parses
23. JSON wrapped in ` ```json ` fences parses
24. JSON with leading prose ("Here's your board:") parses via brace-slicing
25. trailing-comma JSON parses via the last rung
26. key aliases (`groups`/`name`/`indices`/`flagged`) parse
27. unparseable garbage raises `AIUnavailable`

*Fallback* — `AIFallbackTests`
28. `ai_client=None` → one category per playlist, ids `cat_PL0`… (today's shape),
    and a log line mentioning the fallback (AC 5)
29. `FakeAnthropic(raises=RuntimeError("boom"))` → no exception escapes, fallback
    categories produced, explanatory log line captured (AC 5)
30. `stop_reason="refusal"` → fallback
31. `stop_reason="max_tokens"` → fallback
32. a reply parsing to zero usable categories → fallback

*Schema* — update `SchemaTests`
33. `assert_valid` changes: `id`/`title` must still be non-empty strings;
    `playlistId` must be `str` (non-empty) **or** `None` — mirroring the relaxed
    `validateQuestionBank`
34. new test: an AI-generated bank (via `FakeAnthropic`) passes `assert_valid` with
    `playlistId is None` on every category, and round-trips through `write_bank`
    with `null` in the JSON

Use a `capturing log` helper (`logs = []; log = logs.append`) for the assertions
that check messages. Every test must use `FakeYTMusic` and/or `FakeAnthropic` —
**no test may import `anthropic` or `ytmusicapi`, open a socket, or read
`ANTHROPIC_API_KEY`.** If any new code reads the env var at import time, move it
inside a function.

### Step 10 — README

Add a subsection to `README.md` under `## Question bank`, after the "Build it"
flags paragraph (~line 142–150) and before `### Schema`:

```markdown
### Community playlists and AI categories

Pull songs from playlists you don't own, and let Claude invent the board
categories instead of using one category per playlist.

    # a public playlist by id or pasted share URL (repeatable)
    ... build_bank.py --community-playlist PLxxxxxxxx
    ... build_bank.py --community-playlist "https://music.youtube.com/playlist?list=PLxxxxxxxx"

    # search YT Music's community playlists and take the top match (repeatable)
    ... build_bank.py --community-search "80s power ballads"

    # mix them with your own library, and ask for 6 AI categories
    ... build_bank.py --playlists "Road Trip" --community-search "one hit wonders" --categories 6
```

Cover, in prose:

- Accepted `--community-playlist` URL forms (§2.5) and that a `VL` prefix is stripped.
- `--community-search` takes the **first** usable result and logs which one, so you
  can check it.
- With no source flags at all, behaviour is unchanged: all your own playlists.
- **AI categories**: needs `ANTHROPIC_API_KEY`; model via `ANTHROPIC_MODEL`
  (default `claude-haiku-4-5-20251001`). One batch call per run, sending only
  titles and artists — never video ids, and the AI never invents songs.
- **Content filtering**: anything YT Music flags `isExplicit` is dropped before the
  AI ever sees it (authoritative, non-negotiable); the AI does a second conservative
  pass over titles/artists and anything it flags is dropped too.
- **Fallback**: no key, no `anthropic` package, an API error, or an unparseable
  reply → the builder prints why and falls back to one category per playlist. It
  never fails the run. `--no-ai` forces that path.
- `--categories N` (default 5, matching the board's 5 columns).
- These env vars are read by the **Python builder only** — the Node server has no
  Anthropic dependency.

Also update the `### Schema` block just below: change the sample category to note
`"playlistId": null` for AI categories, and amend the bullet
"`id`s are derived (`cat_<playlistId>`, `q_<videoId>`)" to mention
`cat_ai_<slug>_<hash>` for AI categories.

### Step 11 — full verification

Run everything in §5 and report results.

---

## 5. Testing & verification

### Commands (all from `/home/eric/projects/music-trivia`)

```bash
scripts/questionbank/.venv/bin/pip install -r scripts/questionbank/requirements.txt
scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v
npm run build          # regenerates packages/shared/dist from the changed source
npm run typecheck
npm test
```

Plus two no-network smoke checks of the CLI surface:

```bash
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py --help
# expect: the four new flags listed, exit 0, no import of anthropic required
```

Expected end state: 20 existing + ~34 new Python tests all pass; `npm run typecheck`
and `npm test` pass with no new failures (compare against the pre-existing baseline
you capture in Step 0 if anything looks off).

### Acceptance criteria → proof

| AC | Proven by |
|---|---|
| 1. `--community-playlist <id>` alone pulls a public playlist without `--playlists` | Python test 7 (asserts `get_playlist` called with the id and `get_library_playlists` **not** called) + test 8 for the URL form |
| 2. `--community-search` uses `filter="community_playlists"`, logs the pick, fetches tracks | Python test 9 (asserts the `search` kwargs, the captured log line, and the resulting questions) |
| 3. Batch AI call produces thematic categories; `isExplicit` filtered before the AI | Python tests 14, 15, 16 (one `create` call; AI titles not playlist titles; explicit track absent from the prompt string) |
| 4. AI-flagged non-explicit track excluded | Python test 18 (fabricated track, canned `"blocked": [k]`, asserts its videoId is in no category) |
| 5. No key / API error → no crash, fallback + clear message | Python tests 28–32 (plus `make_ai_client` returning `None` when the env var is absent — assert with `unittest.mock.patch.dict(os.environ, {}, clear=True)`) |
| 6. `--categories N`, default 5 | Python test 17 (prompt content + output cap, both the explicit and default cases) |
| 7. Relaxed schema in `validateQuestionBank`; `sample-bank.json` still validates | `npm test` — `packages/server/src/questions/__tests__/bank.test.ts` already asserts `validateQuestionBank(sampleBank).ok === true` and that the fixture fills a board; it must still pass untouched. Python `SchemaTests` (33, 34) mirror it. |
| 8. All Python tests pass, zero network / zero real keys | `scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v` with `ANTHROPIC_API_KEY` unset in the shell |
| 9. No TypeScript regression | `npm run build && npm run typecheck && npm test` |

Optional manual live check (only if the user asks and has a key): a real run with
`--community-search` and `--dry-run` — it writes nothing and prints the category
summary. Do not run it unprompted; it costs a real API call.

---

## 6. Risks & watch-outs

- **The reply won't always be clean JSON.** Fences, a "Here's your board:"
  preamble, trailing commas, or a `max_tokens` truncation are all realistic. The
  four-rung ladder in §2.3 plus the `stop_reason` checks handle these; every
  failure must land in `AIUnavailable` → fallback, never a traceback. Test all of
  them (tests 22–27, 30–32) — this is the single most likely source of a
  production-only bug.
- **The AI will not account for every song.** Expect a chunk of the pool to be left
  unassigned, and expect categories to come back thinner than requested. Never
  assume a partition. Never index-map by position. Log the unassigned count with
  wording that makes clear it's normal, and enforce `min_songs` per AI category so
  a 2-song "category" can't reach the board (the game needs `BOARD_ROWS` songs per
  column).
- **Category id collisions.** Two identical AI titles → identical slug *and*
  identical hash. The `used_ids` set with a `_2` suffix is required, not optional.
  Also guard the empty-slug case (non-ASCII title) — a bare `cat_ai__3f2a91` is
  ugly but a crash on an empty slug is worse.
- **The schema change could break the TS suite.** `sample-bank.json` and
  `harness.ts` both set `playlistId`; making the field *optional* keeps them valid.
  Do not accidentally make it required-and-nullable in TS (`playlistId: string |
  null` without `?`) — that would break any object literal omitting it. Use
  `playlistId?: string | null`. And do not delete the validator branch entirely: an
  empty-string or numeric `playlistId` must still be rejected.
- **Over-eager content flagging.** A model told "be conservative, flag when in
  doubt" can nuke half a legitimate pool. Mitigations: the prompt names the specific
  concerns (sexual content, slurs, graphic violence, drug glorification) rather than
  saying "anything questionable"; the drop count is always logged so the user sees
  it; and if the survivors fall below what the board needs, the existing
  `min_songs` / "no playlist had enough songs" `BuildError` paths give an
  actionable message. Do **not** add an auto-retry-without-safety escape hatch —
  the brief's v1 rule is a hard drop.
- **`ytmusicapi` search results drift.** Community-playlist results may expose
  `browseId` (`VLPL…`), `playlistId`, or neither, and `itemCount` may be `None`.
  Treat every field as optional exactly like the existing `usable_track()` does,
  and wrap the `search`/`get_playlist` calls in `try/except Exception` so one bad
  source doesn't abort a multi-source run.
- **Refactor regression.** Step 4 moves a lot of working code. Keep the existing
  `BuildError` message strings byte-identical (two tests assert only the exception
  type, but the messages are user-facing), keep the `seen_video_ids` release-on-skip
  behaviour, and do not proceed past Step 4 until the original 20 tests pass
  unmodified.
- **Test-time key leakage.** If `ANTHROPIC_API_KEY` happens to be set in the
  developer's shell, no test may pick it up. `build_bank()` must never construct a
  real client itself — only `main()`/`make_ai_client()` may, and tests never call
  those without patching `os.environ`.

---

## 7. Out of scope (do not build these)

- **No live/in-game AI.** The Anthropic call happens only in the offline Python
  builder. The Node server gets no Anthropic dependency, no new env var, no
  `docker-compose.yml` or `.env.example` change.
- **No per-song AI calls.** Exactly one `messages.create()` per builder run.
- **No AI song selection.** The model only groups, titles and flags songs that
  `ytmusicapi` already returned with real video ids. It never names a song.
- **No adjudication UI / review queue** for uncertain content — v1 is a hard drop.
- **No automated or scheduled bank regeneration** — still a manual script run.
- **No Node/TS gameplay changes** beyond the `BankCategory.playlistId` relaxation:
  no engine, Socket.IO protocol, projection, or client UI changes.
- **No auth changes** — community playlists are read with the same authenticated
  `YTMusic` client; `oauth.json`/`browser.json` handling is untouched.
- **No Docker/deploy work.** Don't rebuild the image or restart the container.
- **No touching the pre-existing uncommitted changes** listed in §0.
