# Curated Category Taxonomy + Multi-Round Game Structure — Implementation Plan

Executor note: this file plus the repo is everything you need. Repo root is
`/home/eric/projects/setlist`. Working tree is clean at `8ec0b04`. Node v24.14.0,
`npm` on `PATH`. Python venv at `scripts/questionbank/.venv` — **always** invoke it
explicitly (`scripts/questionbank/.venv/bin/python`), never a bare `python`/`pip`.
The concept brief is at `.claude/plans/curated-taxonomy-rounds-brief.md`; read it
once for context, but this plan is the authority where they differ.

---

## 1. Summary

Two coupled changes. **(a)** The offline bank builder
(`scripts/questionbank/build_bank.py`) stops asking an LLM to invent category
names and instead builds categories from a **fixed, config-driven taxonomy** of
~61 curated categories (plain genres, genre × decade, Rock sub-genres,
cross-genre "hits by era", and special/format categories). Each category is
defined by a small data record carrying its own community-playlist search
queries; the builder aggregates **3–5 large community playlists per category**,
fetching each playlist in **full** (the current `limit=200` cap is removed —
`ytmusicapi`'s `get_playlist(pid, limit=None)` fetches every track), dedupes by
`videoId` within the category, and writes hundreds of songs per category instead
of eight. **(b)** The game stops being a free-browse setlist. After the lobby,
play runs as **3 fixed rounds**: the host picks **5 / 4 / 3** categories at the
start of rounds 1 / 2 / 3; the server samples up to **5 not-yet-used-this-game
songs** from each picked category and sequences them **round-robin by category**,
fully automatically. Before each song, the **category name is shown to everyone**
(players and TV) while the song's title/artist/videoId stay host-only exactly as
today. After round 3's last song is revealed and the host advances, the game ends
automatically at `GAME_OVER`. Everything else — the buzz race, tap-to-arm +
YouTube Music link, manual reveal, flat scoring, host-never-buzzes (including
`pickedByPlayerId` and host-transfer), reconnect/pause/Cast — is carried over
untouched.

---

## 2. Approach & key decisions

These resolve every item the brief left "open for the planner". They are
decisions, not suggestions — implement them as written.

### 2.1 Taxonomy config shape (Python)

A frozen dataclass plus a handful of small, editable tables. **No if/elif
chains.** The full ~61-entry list is *derived* from those tables (e.g.
genre × decade is a nested comprehension over `GENRES` and their allowed
decades), which is what makes "add Pop sub-genres later" a two-line edit.

```python
@dataclass(frozen=True)
class CategoryDef:
    key: str                       # stable slug; drives the bank id. e.g. "90s_grunge"
    title: str                     # display title. e.g. "90s Grunge"
    group: str                     # taxonomy group slug (see §2.4). e.g. "rock_sub"
    queries: tuple[str, ...]       # community-playlist search queries, priority order
    playlist_ids: tuple[str, ...] = ()   # optional hand-pinned playlist ids/URLs
    max_playlists: int = 4         # how many distinct playlists to aggregate
    enabled: bool = True           # flip False to park a category without deleting it
```

`TAXONOMY: tuple[CategoryDef, ...]` is assembled at module level from:
`PLAIN_GENRES`, `GENRE_DECADES` (a `{genre: [decade, ...]}` map),
`ROCK_SUBGENRES`, `ERA_CATEGORIES`, `SPECIAL_CATEGORIES`. Editing any of those
tables changes the taxonomy; nothing else needs touching.

### 2.2 Default query-construction scheme, per category type

Community search is fuzzy, so each category issues **several** queries and takes
the top `--per-query-results` (default **2**) usable hits from each, in order,
until `max_playlists` distinct playlist ids are collected. Documented defaults:

| Type | Group slug | Query templates (in order) |
|---|---|---|
| Plain genre (5) | `genre` | `"best {genre} songs"`, `"{genre} hits playlist"`, `"ultimate {genre} playlist"`, `"top {genre} songs of all time"` |
| Genre × decade (37) | `decade_<genreslug>` | `"{decade} {genre} hits"`, `"best {decade} {genre} songs"`, `"{decade} {genre} playlist"`, `"ultimate {decade} {genre}"` |
| Rock sub-genre (9) | `rock_sub` | `"{sub} songs"`, `"best {sub} songs"`, `"{sub} hits playlist"`, `"ultimate {sub} playlist"` |
| Cross-genre era (7) | `era` | `"{era} hits"`, `"{era} classics"`, `"best songs of the {era}"`, `"{era} party playlist"` |
| Special/format (3) | `special` | hand-written per category (below) |

Decade tokens are the literal strings `"50s" "60s" "70s" "80s" "90s" "2000s"
"2010s"`, plus **"Today's"**, which is a special case: its templates are
`"2020s {genre} hits"`, `"todays {genre} hits"`, `"new {genre} hits 2020s"`,
`"current {genre} hits"` (a literal `"Today's"` search returns junk).

Era-category query tokens: `50s & 60s Oldies` → `"oldies 50s 60s"`,
`"60s oldies"`, `"50s and 60s hits"`, `"oldies party playlist"`. The other six
(`70s Hits`, `80s Throwbacks`, `90s Nostalgia`, `2000s Pop`,
`2010s Chart Toppers`, `Today's Hits`) use the era template with tokens `70s`,
`80s`, `90s`, `2000s`, `2010s`, `2020s` respectively.

Special categories (hand-written, three entries):
- **Boy Bands/Girl Groups** — `"boy band hits"`, `"girl group hits"`, `"best boy bands playlist"`, `"90s boy bands and girl groups"`
- **Solo Artists** — `"biggest solo artist hits"`, `"solo pop stars playlist"`, `"greatest solo hits of all time"`, `"iconic solo artists"`
- **One-Hit Wonders** — `"one hit wonders"`, `"best one hit wonders playlist"`, `"80s one hit wonders"`, `"90s one hit wonders"`

`playlist_ids` on a `CategoryDef` is the hand-tuning escape hatch: pinned ids are
consumed **before** any search, so a category that searches badly can be fixed by
pasting two playlist URLs into its definition without touching code paths.

### 2.3 Round / phase representation

`RoomPhase` loses `'SETLIST'` and gains **two** phases:

- `'ROUND_SETUP'` — the host is picking this round's categories. Nothing else is
  possible in this phase.
- `'ON_DECK'` — the next song is chosen (by the server, not the host); its
  **category** is public; the host privately sees title/artist/YouTube-Music link
  and taps to arm. This is the direct replacement for the old `SETLIST` "browse
  and tap a song" screen, and it is what makes the pre-question category preview
  a phase rather than a bolt-on.

Flow:

```
LOBBY --game:start--> ROUND_SETUP --round:pickCategories--> ON_DECK
                          ^                                    | setlist:start
                          |                                    v
                          |                                  ARMED --(buzz)--> LOCKED
                          |                                    |                 |
                          |         question:reveal            v   judge:answer  v
                          |          +------------------->  REVEAL <-------------+
                          |          |                         | question:next
   round exhausted &      |          |                         v
   round < 3 -------------+          |         more songs in round --> ON_DECK
                                     |         round done & round==3 --> GAME_OVER
                                     |         round done & round<3  --> ROUND_SETUP
```

Round state lives on `GameRoom.round`:

```ts
export interface RoundCategory {
  categoryId: string;    // BankCategory.id, via SetlistSection.id
  title: string;         // denormalised for projection convenience
  songIds: string[];     // the sampled song ids for this round, in draw order
}
export interface RoundState {
  number: number;             // 1..TOTAL_ROUNDS
  categories: RoundCategory[];// in the order the host picked them
  queue: string[];            // round-robin ordered song ids (the play order)
  cursor: number;             // index into queue: the song on deck / in play
}
```

`ROUND_CATEGORY_COUNTS = [5, 4, 3]`, `TOTAL_ROUNDS = 3`,
`SONGS_PER_CATEGORY_PER_ROUND = 5` become exported constants in
`packages/shared/src/types.ts` next to `SONG_POINT_VALUE`.

The existing `SetlistState` / `SetlistSection` / `SetlistSong` types are **kept
by name** (low churn — they are still "the setlist"), but their meaning shifts
from "the browsable list" to "the whole-bank catalog this game draws from".
Update the doc comments on those types to say exactly that.

### 2.4 Used-song tracking (per game, across rounds) — and the videoId trap

`SetlistSong.used` now means **"drawn into a round this game"**, and is set at
**sample time** (when `round:pickCategories` draws it), not at play time. That
makes AC 7 ("never re-sampled in a later round") structurally true rather than
enforced by a second bookkeeping path. Document this on the field.

**Critical interaction:** today `buildSetlist()` dedupes by `videoId` *across*
sections, first section wins. Under the new taxonomy a song legitimately belongs
to several categories (e.g. "Rock", "90s Rock", "90s Grunge"); the old global
dedupe would gut every category after the first. So:

- `buildSetlist()` dedupes by `videoId` **within a section only**. The same
  videoId may appear in several sections as distinct `SetlistSong`s.
- To keep "a song never plays twice in one game", `markUsed` is by **videoId**:
  when a song is drawn, every catalog entry sharing its `videoId` is marked
  `used`. Implement as a private helper `private markUsedByVideoId(videoId)`.
  The sampler only ever draws from `!used`, so this covers both directions.

### 2.5 Category with fewer than 5 unused songs — the rule

**Decided: allow it, contribute what's left.** A category is selectable iff it
has **≥ 1** unused song; it contributes `min(5, unusedCount)` songs. A category
with 0 unused songs is shown in the picker but **disabled** ("all played"). The
picker labels any category with `1 ≤ unused < 5` as "only N left" so the host
picks knowingly.

Rationale: the alternative (disallow below 5) makes small banks — including the
bundled 6×6 `sample-bank.json` — deadlock at round 2, and a deadlocked round is
strictly worse than a short one.

Two companion rules for degenerate banks:

- **required count** for round *n* is `min(ROUND_CATEGORY_COUNTS[n-1],
  selectableCategoryCount)`. With a real ~61-category bank this is always 5/4/3.
- If `selectableCategoryCount === 0` when a round would start, the engine skips
  `ROUND_SETUP` and goes straight to `GAME_OVER`.

### 2.6 Host category-picker UI/UX (~61 categories)

Server-grouped, client-rendered accordion — **not** a flat list.

- The category id encodes its taxonomy group: the builder emits
  `cat_tax_<group>__<key>` (double underscore separator). A shared helper
  `parseCategoryGroup(id)` in `packages/shared/src/taxonomy.ts` extracts the
  group slug and falls back to `'other'` for any id that doesn't match
  (`cat_<playlistId>` from the legacy playlist mode, `cat_ai_*` from old banks,
  and the bundled sample bank all land in `'other'`). `TAXONOMY_GROUPS` in the
  same file maps slug → display label and defines section order:

  | slug | label |
  |---|---|
  | `genre` | Genres |
  | `decade_pop` | Pop by decade |
  | `decade_rock` | Rock by decade |
  | `decade_hiphop` | Hip-Hop by decade |
  | `decade_rnb` | R&B/Soul by decade |
  | `decade_country` | Country by decade |
  | `rock_sub` | Rock sub-genres |
  | `era` | Hits by era |
  | `special` | Special |
  | `other` | All categories |

  Grouping happens **server-side**, in the picker projection, so there is exactly
  one implementation and it is covered by the engine tests.

- Host screen (`RoundSetupScreen`): a sticky header — `Round 2 · pick 4
  categories` and a live `2 / 4 selected` counter with the chosen titles as
  removable chips — then a **search box** filtering titles across all groups,
  then collapsible group sections in `TAXONOMY_GROUPS` order. Sections start
  collapsed except the first one with a match (and all sections auto-expand while
  a search query is active). Each row shows the title, `N songs` and, when
  applicable, `only N left` / `all played` (disabled). Tapping toggles selection;
  selecting beyond the required count is refused client-side. A primary
  `Start round N` button, enabled only at exactly the required count, emits
  `round:pickCategories`.
- Non-host players and the TV during `ROUND_SETUP`: "Round 2 — {host} is picking
  4 categories…" and the scoreboard. **No category list, no counts** — keep the
  picker host-only (it is not a secret, but there is no reason to widen it, and
  the discipline is the point).

### 2.7 Category preview before each question

New **public** field on `PublicRoom`:

```ts
export interface PublicOnDeck {
  categoryTitle: string;   // e.g. "90s Grunge"  <-- the only new public info
  roundNumber: number;     // 1..3
  indexInRound: number;    // 1-based position within the round's queue
  songsInRound: number;    // the round's queue length
}
```

`PublicRoom.onDeck: PublicOnDeck | null` — non-null only in `ON_DECK`. It carries
**no** song id, title, artist or videoId. `PublicActiveQuestion.sectionTitle`
already makes the category public from `ARMED` onwards, so the preview is purely
a phase-shift of information that was already public one step later.

`PublicRoom.round: { number: number; songsTotal: number; songsPlayed: number } |
null` is added alongside for the TV's progress line; `songsTotal`/`songsRemaining`
keep their current meaning (whole-catalog counts) so the existing harness
invariants stay valid.

### 2.8 The ANTHROPIC key

The AI categorisation step is **deleted** (functions, CLI flags, tests, the
`anthropic` requirement). `ANTHROPIC_API_KEY` in `.env`/`.env.example` is left in
place but documented in the README as **no longer used by anything in this
repo** — removing it from a live `.env` is not worth a deploy.

---

## 3. Step-by-step tasks

Do them in order; each is independently verifiable. Run
`npm run typecheck && npm test` after each TypeScript task and the Python
unittest command after each Python task.

### Phase A — the Python builder

**A1. Add the taxonomy config.** In `scripts/questionbank/build_bank.py`, above
the ingestion helpers, add the `CategoryDef` dataclass from §2.1 and the source
tables:

- `PLAIN_GENRES: tuple[tuple[str, str], ...]` — `(slug, display)` for Pop, Rock,
  Hip-Hop/Rap, R&B/Soul, Country. Search token for Hip-Hop/Rap is `"hip hop"`
  and for R&B/Soul is `"r&b soul"` — keep a third tuple element for the search
  token where the display name is a poor query.
- `DECADES: tuple[str, ...]` = `("50s","60s","70s","80s","90s","2000s","2010s","Today's")`.
- `GENRE_DECADES: dict[str, tuple[str, ...]]` — Pop/Rock/R&B/Country get all 8;
  Hip-Hop gets `("80s","90s","2000s","2010s","Today's")`.
- `ROCK_SUBGENRES: tuple[str, ...]` — the 9 from the brief.
- `ERA_CATEGORIES: tuple[tuple[str, str], ...]` — `(display title, era token)`,
  the 7 from the brief.
- `SPECIAL_CATEGORIES: tuple[tuple[str, tuple[str, ...]], ...]` — title + its
  hand-written queries, the 3 from the brief.

Then four small builder functions (`_genre_defs()`, `_genre_decade_defs()`,
`_rock_sub_defs()`, `_era_defs()`, `_special_defs()`) that expand those tables
into `CategoryDef`s using the templates in §2.2, and
`TAXONOMY: tuple[CategoryDef, ...] = (*_genre_defs(), *_genre_decade_defs(), ...)`.
Add `def taxonomy_categories(filters: Sequence[str] = ()) -> list[CategoryDef]`
that returns enabled defs, optionally narrowed by case-insensitive key/title
substring. Add `def make_taxonomy_category_id(cat: CategoryDef) -> str` returning
`f"cat_tax_{cat.group}__{cat.key}"`.

Assert in a test that `len(TAXONOMY) == 61` and that every id is unique.

**A2. Full-playlist fetch.** Change the single `client.get_playlist(pid,
limit=200)` call site in `collect_sources()` to `limit=None`, and use `limit=None`
in the new taxonomy path. `ytmusicapi` 1.12.1's signature is
`get_playlist(playlistId, limit: int | None = 100, ...)` and its docstring states
`None` retrieves them all — verified against the installed package; do not
"optimise" this into a manual pagination loop.

**A3. Multi-hit community search.** Refactor `search_community_playlist()` into
`search_community_playlists(client, query, log, max_results=1) -> list[dict]`
returning up to `max_results` usable hits (same shape and same "no ranking, log
the pick" behaviour). Keep `search_community_playlist(client, query, log)` as a
one-line wrapper returning the first hit or `None`, so `collect_sources()` and its
existing tests are untouched.

**A4. Per-category aggregation.** Add:

```python
def collect_category_playlists(client, cat, opts, log) -> list[tuple[str, str]]
def collect_category_songs(client, cat, opts, log, sleep=None) -> list[dict]
```

`collect_category_playlists` yields `(playlistId, title)` candidates: pinned
`cat.playlist_ids` (through `parse_playlist_id`) first, then each query in order
contributing up to `opts.per_query_results` hits, stopping at
`cat.max_playlists` distinct ids.

`collect_category_songs` fetches each candidate with
`client.get_playlist(pid, limit=None)` inside a `try/except` (one bad playlist
must never abort the run — same discipline as `collect_sources`), runs every
track through the existing `usable_track()` (so the `isExplicit` hard filter and
all the field-tolerance stay exactly as they are), dedupes by `videoId`
**within this category only**, and returns the list. Calls the injected `sleep`
(default `time.sleep`, tests pass a no-op) for `opts.sleep_ms` between playlist
fetches.

Logging, one line per playlist, matching the existing `log(...)` style:

```
[12/61] 90s Grunge
  community search '90s grunge songs' -> 'Ultimate 90s Grunge' by … (PL…, 402 items)
  + 'Ultimate 90s Grunge' (PL…): 361 usable, 41 skipped — category total 361
  + 'Grunge Essentials' (PL…): 188 usable, 12 skipped (95 dupes) — category total 454
  90s Grunge: 454 songs from 3 playlists
```

**A5. Taxonomy category assembly.** Add:

```python
def categories_from_taxonomy(client, opts, rng, log, sleep=None) -> list[dict[str, Any]]
```

Iterates `taxonomy_categories(opts.category_filters)`, calls
`collect_category_songs`, drops (with a warning, collected into a summary list)
any category below `opts.min_category_songs`, optionally truncates to
`opts.max_songs_per_category` via `rng.sample` when that option is set, sets
every question's `value = POINT_VALUES[0]`, and emits
`{"id": make_taxonomy_category_id(cat), "title": cat.title, "playlistId": None,
"questions": [...]}`. Raise `BuildError` only if **zero** categories survive.

**A6. Wire it into `build_bank()` and the CLI.** Add `mode` to `BuildOptions`
(`"taxonomy"` default, `"playlists"` legacy) plus the new fields
(`category_filters`, `max_playlists_per_category`, `per_query_results`,
`min_category_songs`, `max_songs_per_category`, `sleep_ms`). In `build_bank()`,
`mode == "taxonomy"` calls `categories_from_taxonomy()` and skips
`collect_sources()`/`filter_embeddable()` entirely; `mode == "playlists"` keeps
today's `collect_sources()` → `categories_from_sources()` path verbatim.

New CLI flags: `--mode {taxonomy,playlists}` (default `taxonomy`), `--category`
(repeatable filter), `--list-categories` (print the taxonomy as
`group  key  title  n_queries` and exit 0), `--max-playlists-per-category` (4),
`--per-query-results` (2), `--min-category-songs` (25),
`--max-songs-per-category` (0 = unlimited), `--sleep-ms` (250),
`--merge` (merge the produced categories into an existing `--out` file, replacing
same-id categories and keeping the rest — makes rebuilding one category cheap).

**A7. Delete the AI path.** Remove `AIUnavailable`, `AI_POOL_LIMIT`,
`DEFAULT_MODEL`, `build_ai_prompt`, `_balanced_json_slice`, `_strip_fences`,
`_first_list`, `_as_index`, `parse_ai_response`, `call_ai`, `make_category_id`,
`categories_from_ai`, `make_ai_client`, the `ai_client` parameter of
`build_bank()`, the `--no-ai`/`--categories` flags, `opts.no_ai`,
`opts.categories`, `DEFAULT_CATEGORIES`, and the AI summary lines in `main()`.
Drop `anthropic>=0.40,<1` from `scripts/questionbank/requirements.txt`.

**A8. Build summary.** `main()` prints the per-category table it already prints
(title + song count + total), plus a **dropped-categories** section listing every
taxonomy category that fell below `--min-category-songs` and why, plus wall-clock
elapsed. This is the artifact the user reads after a real build.

**A9. Python tests** (`scripts/questionbank/test_build_bank.py`). Delete
`AICategoryTests`, `AIParseTests`, `AIFallbackTests` and the AI imports/fakes
(`FakeAnthropic`, `_Block`, `_Response`, `_Messages`, `ai_reply`). Keep
`UsableTrackTests`, `PlaylistIdTests`, `CommunityTests`, `YoutubeEmbeddableTests`,
`SchemaTests` and `BuildBankTests` (the latter now constructing
`BuildOptions(mode="playlists", ...)`). Extend `FakeYTMusic` so `get_playlist`
records the `limit` it was called with and `search` can return **different**
results per query (a `dict[str, list]` keyed by query, falling back to the flat
list). Add `TaxonomyTests`:

- the taxonomy has 61 enabled categories, unique keys and unique ids
- every `CategoryDef` has ≥1 query or ≥1 pinned playlist id
- ids match `^cat_tax_[a-z0-9_]+__[a-z0-9_]+$` and are stable across two calls
- `--list-categories` prints every title and exits 0
- `collect_category_playlists` prefers pinned ids, then fills from queries in
  order, and stops at `max_playlists`
- `collect_category_songs` **calls `get_playlist` with `limit=None`** (the
  no-truncation guard)
- it aggregates across playlists and dedupes by videoId within the category
- an exploding `get_playlist` skips that playlist and keeps the rest
- explicit tracks are still dropped in the taxonomy path
- the **same videoId in two different categories is kept in both** (the
  no-global-dedupe guard — the counterpart of the engine change in B3)
- a category below `--min-category-songs` is dropped and named in the log
- `--category` narrows the run, and only the requested categories are searched
- `--merge` replaces same-id categories and preserves the others
- the taxonomy bank validates against the documented schema (extend
  `SchemaTests`, which already covers null `playlistId`s)
- the injected `sleep` is called between playlist fetches (assert with a counter)

Every one of these runs against `FakeYTMusic`. **No test may perform a live
build.** There is no network access in the suite and there must never be.

### Phase B — shared types and the engine

**B1. `packages/shared/src/types.ts`.** Replace `'SETLIST'` in `RoomPhase` with
`'ROUND_SETUP' | 'ON_DECK'`. Add `RoundCategory` and `RoundState` (§2.3) and
`GameRoom.round: RoundState | null`. Add the constants
`TOTAL_ROUNDS = 3`, `ROUND_CATEGORY_COUNTS = [5, 4, 3] as const`,
`SONGS_PER_CATEGORY_PER_ROUND = 5`. Update the doc comments on `SetlistState`
(now "the whole-bank catalog this game draws from") and `SetlistSong.used` (now
"drawn into a round this game — set at sample time, and mirrored to every catalog
entry with the same videoId").

**B2. New `packages/shared/src/taxonomy.ts`.** `TAXONOMY_GROUPS: readonly
{ slug: string; label: string }[]` in the §2.6 order, `parseCategoryGroup(id:
string): string` (regex `^cat_tax_([a-z0-9_]+)__`, else `'other'`), and
`groupLabel(slug: string): string`. Export from `packages/shared/src/index.ts`.

**B3. `packages/server/src/engine/engine.ts` — catalog build.** In
`buildSetlist()`, change the videoId dedupe from global to **per-section**
(`seenVideoIds` reset at the top of each category). Keep song ids positional and
opaque (`s<section>q<index>`) — the index must be the index **within the section
after dedupe**, exactly as now, so ids stay unique and leak nothing.

**B4. Engine — round machinery.** Add, all private unless noted:

- `private unusedByCategory(): Map<number, number>` — sectionIndex → unused count.
- `private selectableSections(): number[]` — sections with ≥1 unused song.
- `private requiredCategoryCount(roundNumber): number` —
  `min(ROUND_CATEGORY_COUNTS[n-1], selectableSections().length)`.
- `private markUsedByVideoId(videoId: string): void` — §2.4.
- `private beginRound(number: number): void` — if `selectableSections().length === 0`
  call `endGame()`; else set `room.round = { number, categories: [], queue: [],
  cursor: 0 }` and `room.phase = 'ROUND_SETUP'`.
- **public** `pickCategories(hostId: string, categoryIds: string[]): EngineResult`
  — host-only; phase must be `ROUND_SETUP`; ids must be distinct, must all resolve
  to catalog sections, each must have ≥1 unused song, and `categoryIds.length`
  must equal `requiredCategoryCount(round.number)`. Errors, verbatim strings:
  `'Only the host can pick categories.'`, `'Not picking categories right now.'`,
  `'Pick exactly N categories.'`, `'No such category.'`, `'Duplicate category.'`,
  `'That category has no songs left.'`. On success: for each id in the given
  order, `rng`-sample `min(5, unused)` unused songs from that section, mark each
  used (by videoId), record a `RoundCategory`; build `queue` round-robin
  (`for i in 0..maxLen-1: for each category: category.songIds[i]` skipping
  absent entries); `cursor = 0`; `phase = 'ON_DECK'`.
- `private onDeckSongId(): string | null` — `round.queue[round.cursor] ?? null`.
- **public** `onDeckSong(): SetlistSong | null` — for the projector.

**B5. Engine — `start()`.** Replace `this.room.phase = 'SETLIST'` with
`this.room.round = null;` then `this.beginRound(1)`. Keep every existing guard
(host, phase, cast connected, MIN/MAX players, score reset) exactly as is. The
`'The question bank has no songs.'` error and its test stay.

**B6. Engine — `startSong()`.** Now "arm the on-deck song": require phase
`'ON_DECK'` (error `'Not choosing a song right now.'` becomes
`'No song is on deck.'` — update the one test that asserts it), require the
supplied `songId` to equal `onDeckSongId()` (error `'That song is not on deck.'`
— guards a double-tap or a stale client). The song is already `used`; do **not**
re-mark it. Everything else — the `ActiveQuestion` construction including
`pickedByPlayerId: hostId`, `startedAt: this.now()` — is unchanged.

**B7. Engine — `nextQuestion()`.** After the existing `pendingJoin` promotion and
`room.active = null`:

```
round.cursor += 1
if (round.cursor < round.queue.length)      phase = 'ON_DECK'
else if (round.number < TOTAL_ROUNDS)       beginRound(round.number + 1)
else                                        endGame()
```

Delete the old `allUsed` check. `beginRound` itself handles "no categories left"
by ending the game (§2.5).

**B8. Engine — housekeeping.** `IN_PROGRESS_PHASES` becomes
`['ROUND_SETUP', 'ON_DECK', 'ARMED', 'LOCKED', 'REVEAL']`. `rematch()` also sets
`room.round = null`. `forceEnd()` unchanged. `eligibleBuzzers`, `buzz`, `judge`,
`revealQuestion`, `canBuzz`, `disconnect`, `transferHost`,
`transferHostOnDisconnect`, `pause`, `maybeResume` are **not** to be modified —
the `pickedByPlayerId` host-exclusion and its host-transfer interaction must come
through this change byte-identical.

**B9. Projection types** (`packages/shared/src/projection.ts`). Add
`PublicOnDeck` and `PublicRoom.onDeck`, `PublicRoom.round` (§2.7). Add the
host-only picker types:

```ts
export interface CategoryOption {
  id: string;            // BankCategory.id
  title: string;
  available: number;     // unused songs left this game
}
export interface CategoryGroup { slug: string; label: string; categories: CategoryOption[] }
export interface CategoryPicker {
  roundNumber: number;
  required: number;      // how many to pick (already clamped, §2.5)
  perCategory: number;   // SONGS_PER_CATEGORY_PER_ROUND, for the copy
  groups: CategoryGroup[];
}
export interface HostSong { title: string; artist: string; videoId: string }
```

On `PrivateState`: **remove** `setlist: HostSetlistSection[] | null`, and remove
`HostSetlistSong`/`HostSetlistSection` entirely (free browsing is gone). **Add**
`categoryPicker: CategoryPicker | null` (host-only, `ROUND_SETUP` only) and
`hostOnDeck: HostSong | null` (host-only, `ON_DECK` only). Keep `hostAnswer` and
`hostVideoId` and their current gate (host + `room.active`) untouched.

**B10. `packages/server/src/engine/project.ts`.** In `toPublicRoom`, add `onDeck`
(built field by field from `engine`/`room.round` — **category title only**) and
`round`. Delete `toHostSetlist`. In `toPrivateState`, build `categoryPicker`
(only when `isHost && room.phase === 'ROUND_SETUP' && room.setlist`) by grouping
selectable+unselectable sections with `parseCategoryGroup`, dropping empty groups,
preserving `TAXONOMY_GROUPS` order; and `hostOnDeck` (only when
`isHost && room.phase === 'ON_DECK'`). Preserve the field-by-field construction
discipline — **never** spread a `SetlistSong` or `ActiveQuestion`.

`toPublicRoom` must not gain any path that can reach `question.title`,
`question.artist` or `question.videoId` other than the existing revealed-answer
branch. This is the single highest-risk line of the whole change; the invariant
checker in B12 is what proves it.

**B11. Protocol** (`packages/shared/src/protocol.ts`). Add
`'round:pickCategories': (payload: { categoryIds: string[] }, ack: (res: Ack<{}>) => void) => void;`
Update the doc comments on `'game:start'` (→ `ROUND_SETUP`), `'setlist:start'`
(→ arms the **on-deck** song), and `'question:next'`
(→ `ON_DECK | ROUND_SETUP | GAME_OVER`). Wire it in
`packages/server/src/net/server.ts` next to `setlist:start`:

```ts
socket.on('round:pickCategories', ({ categoryIds }, ack) => {
  acked(ack, (rt, hostId) => rt.engine.pickCategories(hostId, categoryIds));
});
```

No other server.ts change is needed.

**B12. Server test harness + suites.** See the disposition table in §5.

### Phase C — client

**C1. `packages/client/src/common/store.ts`.** Add
`async pickCategories(categoryIds: string[]): Promise<boolean>` mirroring the
existing `startSong`/`judge` shape (emit, toast on `!ok`, return `res.ok`). Leave
`startSong` as-is.

**C2. `packages/client/src/player/screens.tsx`.** Replace `SetlistScreen` with:

- `RoundSetupScreen` — the picker from §2.6. Local state: `selected: string[]`,
  `query: string`, `openGroups: Set<string>`. Renders from
  `priv.categoryPicker`; renders the non-host waiting card (with **no** category
  list) when `!priv.categoryPicker`. Reuse existing CSS classes (`card`, `stack`,
  `spread`, `h2`, `pill`, `muted`, `small`, `setlist`, `sechead`, `song`,
  `song used`, `primary`, `ghost small`) — add at most a `.chip`/`.chiprow` rule
  to `packages/client/src/common/styles.css` if needed. Keep the
  `🏁 End game & show scores` button that lived on `SetlistScreen`.
- `OnDeckScreen` — everyone sees `Next up` + `priv`-independent
  `pub.onDeck.categoryTitle` in large type, plus
  `Round {n} · song {i} of {total}` and the `ScoreStrip`. The **host** also sees
  a card with `priv.hostOnDeck` title/artist and the
  `▶ Open in YouTube Music` link (same `youtubeMusicUrl(...)`, `target="_blank"`,
  `rel="noopener noreferrer"` as `BuzzScreen`), and the
  `🔔 Start round — arm buzzers` button calling
  `store.startSong(<the on-deck id>)`. The host needs an id to send: expose it as
  `PrivateState.hostOnDeck` — **add a `songId` field to `HostSong`** (it is the
  same opaque `s<i>q<j>` id already published as
  `PublicActiveQuestion.songId`, so it leaks nothing). Guard the button with an
  in-flight `arming` boolean exactly like today's `SetlistScreen` does.
- `BuzzScreen`, `HostJudge`, `Reveal`, `GameOver`, `Paused`, `Lobby`,
  `ScoreStrip` — unchanged.

**C3. `packages/client/src/player/App.tsx`.** Route
`pub.phase === 'ROUND_SETUP'` → `RoundSetupScreen`, `pub.phase === 'ON_DECK'` →
`OnDeckScreen`; drop the `SETLIST` branch and the `SetlistScreen` import.

**C4. `packages/client/src/receiver/App.tsx`.** Replace `SetlistTV` with:

- `RoundSetupTV` — `Round {n}` brand, `🎛` glyph, `{host} is picking {required}
  categories…`. It has no access to `required` (private) — use the shared
  `ROUND_CATEGORY_COUNTS[pub.round.number - 1]` clamped only for display, or
  simply "…is picking this round's categories". Prefer the latter; do not invent
  a public field for it.
- `OnDeckTV` — the money screen: small `Round {n} · {i} of {total}` line, then
  `Next up` and `pub.onDeck.categoryTitle` at `.huge`, then `Scores`. No song
  data of any kind reaches this component; it only ever reads `pub`.

Route both in the `App` phase chain (`ROUND_SETUP`, `ON_DECK`), replacing the
current `else → SetlistTV` fallback with explicit branches plus a null-safe
default.

**C5. Client fixtures** (`packages/client/src/test/fixtures.ts`). Remove
`makeHostSetlist` and the `HostSetlistSection` import; add `makeCategoryPicker()`
(2 groups × 3 categories, one with `available: 2`, one with `available: 0`),
`makeOnDeck()`, and `makeRound()`. Update `makePub`/`makePriv` defaults with the
new fields (`onDeck: null`, `round: makeRound()`, `categoryPicker: null`,
`hostOnDeck: null`).

**C6. Client tests** (`packages/client/src/player/__tests__/screens.test.tsx`).
Replace the `SetlistScreen` describe with `RoundSetupScreen` and add
`OnDeckScreen` — details in §5.

### Phase D — docs

**D1. README.** Rewrite: the "How the game works" **Setlist** and **Host
playback** bullets → **Rounds** (3 rounds, 5/4/3 categories, 5 songs each,
round-robin, auto `GAME_OVER`), **Category preview**, and **Host playback**
(unchanged mechanics, now on the on-deck screen). Replace the "Community
playlists and AI categories" section with **"Curated category taxonomy"**:
the ~61 categories and their groups, the query scheme per type, the new flags
(§A6), the expected build time ("tens of minutes — the builder prints per-category
progress"), how to add/edit a category (edit one table in `build_bank.py`), and
how to re-tune a single category (`--category "Yacht Rock" --merge`). Update the
Schema section for `cat_tax_<group>__<key>` ids and `playlistId: null`. Note
under Environment that `ANTHROPIC_API_KEY` is now unused. Update the Test section
to describe the new coverage.

---

## 4. Data / model / API changes (consolidated reference)

**Python — category-definition schema** (`build_bank.py`): the `CategoryDef`
dataclass of §2.1. On-disk bank format is **unchanged**: still
`{version, generatedAt, source, categories: [{id, title, playlistId, questions}]}`.
Taxonomy categories carry `playlistId: null` (already permitted by
`validateQuestionBank`) and ids of the form `cat_tax_<group>__<key>`.

**Shared types** (`types.ts`): `RoomPhase` −`SETLIST` +`ROUND_SETUP` +`ON_DECK`;
new `RoundCategory`, `RoundState`; `GameRoom.round`; constants `TOTAL_ROUNDS`,
`ROUND_CATEGORY_COUNTS`, `SONGS_PER_CATEGORY_PER_ROUND`.

**Shared taxonomy** (`taxonomy.ts`, new): `TAXONOMY_GROUPS`,
`parseCategoryGroup`, `groupLabel`.

**Projection** (`projection.ts`): `PublicRoom.onDeck: PublicOnDeck | null` (the
new public field — **category title only**), `PublicRoom.round`;
`PrivateState.categoryPicker: CategoryPicker | null`,
`PrivateState.hostOnDeck: HostSong | null`; `PrivateState.setlist` and the
`HostSetlistSong`/`HostSetlistSection` types **removed**.

**Socket.IO**: one new client→server event,
`'round:pickCategories'` with `{ categoryIds: string[] }` and an `Ack<{}>`.
`'setlist:start'` keeps its name and `{ songId }` payload but now means "arm the
on-deck song". No new server→client events — everything rides the existing
`room:state` / `you:state` broadcast.

---

## 5. Testing & verification

### 5.1 Commands

```bash
cd /home/eric/projects/setlist
npm run typecheck
npm test
scripts/questionbank/.venv/bin/python -m unittest discover -s scripts/questionbank -v
```

All three must pass. `npm run build` must also succeed (shared → client →
server order matters).

### 5.2 Test-file disposition

| File | Disposition |
|---|---|
| `scripts/questionbank/test_build_bank.py` | Delete `AICategoryTests`/`AIParseTests`/`AIFallbackTests` + AI fakes; keep the rest (retarget `BuildBankTests` to `mode="playlists"`); add `TaxonomyTests` (§A9) |
| `packages/server/src/engine/__tests__/harness.ts` | Rework: `makeBank` gains taxonomy-style ids; add `pickRound(engine, hostId, n?)` and `playSong(engine, hostId, buzzerId, verdict)` helpers driving `ROUND_SETUP → ON_DECK → ARMED → … → REVEAL → next`; drop `firstUnusedSongId` in favour of `onDeckSongId(engine)`; update `checkInvariants` (below) |
| `packages/server/src/engine/__tests__/setlist.test.ts` | Rename to `rounds.test.ts`; keep the catalog-construction tests (opaque ids, small sections kept, empty-bank refusal, rematch resets); **replace** the global-dedupe test with a per-section-dedupe test; add the whole round-structure suite |
| `packages/server/src/engine/__tests__/flow.test.ts` | Update every `SETLIST` assertion to `ROUND_SETUP`/`ON_DECK`; rewrite "ends the game exactly when the last song is used" as "ends after round 3"; keep the pause/resume tests (now restoring `ON_DECK` and `ROUND_SETUP`) |
| `packages/server/src/engine/__tests__/buzz.test.ts` | Mechanically retarget to the new arming helper. **No behavioural change permitted** — this file is the regression net for the buzz race and host exclusion |
| `packages/server/src/engine/__tests__/host.test.ts` | Same: retarget helpers only; add `pickCategories` to the "gates every privileged method behind the host" list |
| `packages/server/src/engine/__tests__/scoring.test.ts` | Retarget helpers only; no behavioural change |
| `packages/server/src/net/__tests__/harness.ts` | `firstSongId` now reads `host.priv.hostOnDeck.songId`; `armRound` becomes `start → pickCategories(first N selectable ids from the host's picker) → setlist:start` |
| `packages/server/src/net/__tests__/integration.test.ts` | Update the phase walk; keep the videoId-leak test (now also asserting no videoId in `onDeck`); add a "the TV and a non-host see the upcoming category but no song data" test |
| `packages/server/src/net/__tests__/race.test.ts` | Retarget through the new `armRound` only. **No behavioural change** |
| `packages/server/src/net/__tests__/rooms.test.ts` | Retarget through the new `armRound` only |
| `packages/server/src/questions/__tests__/bank.test.ts` | Unchanged (bank schema is unchanged) |
| `packages/client/src/player/__tests__/screens.test.tsx` | Replace the `SetlistScreen` describe with `RoundSetupScreen` + `OnDeckScreen`; `BuzzScreen`/`HostJudge`/`Reveal`/`Lobby` describes unchanged |
| `packages/client/src/test/fixtures.ts` | §C5 |

### 5.3 `checkInvariants` additions (engine harness)

Keep every existing assertion. Change the host-projection assertions from
`priv.setlist === null` (field is gone) to:

- `priv.categoryPicker === null` for every non-host, always; for the host,
  non-null **iff** `phase === 'ROUND_SETUP'`.
- `priv.hostOnDeck === null` for every non-host, always; for the host, non-null
  **iff** `phase === 'ON_DECK'`.
- `priv.hostAnswer === null` iff `!room.active` (unchanged).

Add:

- If `room.round` exists: `queue.length === sum(categories[].songIds.length)`,
  every queue entry is a real catalog song id, no duplicates in the queue, and
  `0 <= cursor <= queue.length`.
- Every song id in every round queue has `used === true`.
- No two songs *drawn this game* share a `videoId`.
- The existing whole-`pub` serialisation leak check already covers `onDeck`
  (it stringifies the whole `PublicRoom`), so a category title is fine but any
  song title/artist/videoId appearing there fails the build. **Do not weaken it.**

### 5.4 How each acceptance criterion is proven

| AC | Proof |
|---|---|
| 1 — fixed config-driven taxonomy, no LLM names | `TaxonomyTests`: 61 enabled defs, unique `cat_tax_*` ids, `--list-categories` output; plus the AI code and its tests no longer exist (grep for `parse_ai_response` returns nothing) |
| 2 — multi-playlist aggregation raises counts | `TaxonomyTests`: a fake with 3 playlists per query yields a category whose count is the deduped union and strictly greater than any single playlist; `get_playlist` asserted called with `limit=None`; real counts documented by the manual build (§5.5) |
| 3 — 5 / 4 / 3 categories per round | Engine test: `pickCategories` with 4 ids in round 1 → `'Pick exactly 5 categories.'`; with 5 → ok; after round 1 completes, phase is `ROUND_SETUP` and `priv.categoryPicker.required === 4`; likewise 3 for round 3 |
| 4 — 5 sampled unused songs per category | Engine test on a bank with ≥10 songs/category: `round.categories.every(c => c.songIds.length === 5)`, `queue.length === 25`, all drawn songs distinct; plus the short-category test (`available: 3` contributes 3) |
| 5 — automatic round-robin sequencing | Engine test: with categories A,B,C,D,E the queue's section indices are `A B C D E A B C D E …`; `startSong` with any id other than `onDeckSongId()` → `'That song is not on deck.'`; there is no engine method to choose an arbitrary song |
| 6 — category public, song private | `checkInvariants` (§5.3) after every mutation; the net integration test asserting the receiver's and a guest's `you:state`/`room:state` contain `onDeck.categoryTitle` and **no** title/artist/videoId; client test: `OnDeckScreen` rendered with a non-host `priv` contains the category and none of the fixture song strings |
| 7 — no cross-round repeats | Engine test: play round 1 with category X, pick X again in round 2, assert the round-2 draw shares no song id **and no videoId** with round 1; plus the harness invariant "no two drawn songs share a videoId" |
| 8 — auto `GAME_OVER` after round 3 | Engine test playing all three rounds to completion on a bank sized for it: phase is `GAME_OVER`, `winnerPlayerIds` set, and `pickCategories` afterwards errors. Also: no round-4 `ROUND_SETUP` ever appears |
| 9 — existing mechanics intact | `buzz.test.ts`, `host.test.ts`, `scoring.test.ts`, `race.test.ts`, `rooms.test.ts` pass with **helper-only** edits; the `pickedByPlayerId`/demoted-ex-host test and the 2-player host-drop auto-reveal test are unchanged in substance; pause/resume tests restore `ON_DECK`/`ROUND_SETUP` |
| 10 — all suites green | The three commands in §5.1 |

### 5.5 Manual verification (NOT automated — never in the test suite)

A real bank build hits the user's live YouTube Music account and will take **tens
of minutes**. It is a manual step. Document it in the README and run it (or hand
it to the user) only after the automated suites are green:

```bash
# 1. sanity: the taxonomy itself, no network
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py --list-categories

# 2. one narrow category end-to-end (~1 minute, real network)
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py \
    --category "Yacht Rock" --dry-run

# 3. the full build (tens of minutes) — watch the per-category progress
time scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py \
    | tee /tmp/bank-build.log

# 4. record actual per-category counts from the summary table; hand-tune any
#    category that came in low by adding pinned playlist_ids to its CategoryDef
#    and rebuilding just that one:
scripts/questionbank/.venv/bin/python scripts/questionbank/build_bank.py \
    --category "Garage Rock" --merge
```

Then a live play-through against the built bank via `npm run dev` + the
**"Open TV view"** fallback (no Chromecast needed): host + 2 guests, confirm the
picker groups, the "Next up: …" preview on both phone and TV, a full round 1, a
round-2 pick that re-uses a round-1 category, and the automatic `GAME_OVER`.
Deploy as usual with `docker compose up -d --build`.

Do **not** enforce a per-category minimum in code beyond `--min-category-songs`
(which only *drops* thin categories); report the real counts, don't fabricate a
guarantee.

---

## 6. Risks & watch-outs

1. **`get_playlist` full fetch.** Verified against the installed `ytmusicapi`
   1.12.1: `get_playlist(playlistId, limit: int | None = 100, ...)`, and its
   docstring says `None` retrieves them all. Pass `limit=None`. Do not
   hand-roll pagination, and do not leave any call site at `200`. A test asserts
   the `limit` the fake received — that assertion is the guard.
2. **Build time / rate limits.** ~61 categories × up to 4 playlists × up to 4
   search calls ≈ 400–500 unofficial-API requests. Default `--sleep-ms 250`
   between playlist fetches, keep every request inside `try/except` so one
   failure never aborts a 30-minute run, print per-category progress with a
   `[n/61]` counter, and print elapsed time at the end. `--category` +
   `--merge` exist precisely so a failed or thin category can be redone without
   a full rebuild.
3. **Category-preview leakage.** `PublicRoom.onDeck` is the one new public field
   and must carry *only* the category title plus counters. Build it field by
   field. The harness leak check stringifies the whole `PublicRoom` and asserts
   no bank title/artist/videoId appears — it will catch a mistake here, so never
   weaken or skip it, and never `...spread` a `SetlistSong` into a projection.
4. **Global vs per-section videoId dedupe.** This is the subtlest change in the
   plan. `buildSetlist` must dedupe **within** a section (so "Rock" and "90s
   Rock" can both contain the same track), while `markUsedByVideoId` prevents the
   same track playing twice in one game. Get one of those two halves wrong and
   you either gut every category after the first or replay songs. Both halves get
   a dedicated test.
5. **Used-at-sample-time semantics.** `used` flips when a song is *drawn*, not
   when it is *played*. That is what makes AC 7 structural, but it means
   `songsRemaining` drops by 25 the moment round 1 is picked. Don't "fix" that —
   the TV shows round progress (`pub.round`), not the catalog count.
6. **`pickedByPlayerId` and host transfer.** Do not touch `eligibleBuzzers`,
   `buzz`, `canBuzz`, `disconnect` or `transferHostOnDisconnect`. Under the new
   structure the host still arms every song, so `pickedByPlayerId` is still the
   host at arm time and a demoted ex-host must stay excluded for the rest of that
   question. The 2-player host-drop auto-reveal path must still fire from `ARMED`.
7. **Reconnect / pause / Cast.** The only permitted change is the
   `IN_PROGRESS_PHASES` membership swap. `phaseBeforePause` must be able to
   restore `ROUND_SETUP` and `ON_DECK`; add a test for each (the existing
   "a pause while browsing restores SETLIST" test becomes two).
8. **Small banks / the bundled sample bank.** `sample-bank.json` is 6 categories
   × 6 songs. Round 1 (5 categories × 5 songs) leaves most categories with 1 song
   left, so round 2 exercises the clamped `required` and the "fewer than 5" rule
   on every run. That is deliberate coverage, not a bug — but it means the
   degradation rules in §2.5 must be implemented exactly, or the bundled-bank
   experience deadlocks. Do **not** enlarge the sample bank.
9. **Category id stability.** `cat_tax_<group>__<key>` is derived from the config,
   so rebuilds are stable — but changing a `key` or a `group` renames the category
   and orphans it in any bank built earlier. Change `title` freely; treat `key`
   and `group` as identifiers.
10. **`parseCategoryGroup` fallback.** Any bank not built by the new taxonomy
    path (the sample bank, a legacy `cat_<playlistId>` or `cat_ai_*` bank) must
    land wholesale in the `'other'` → "All categories" group and remain fully
    playable. Test it with the sample bank.

---

## 7. Out of scope

Restated from the brief; do not do any of these:

- No changes to the buzz race, the scoring formula, the judging flow, the
  tap-to-arm / YouTube-Music-link mechanics, or the host-never-buzzes rule.
- No sub-genre breakdowns for Pop / Hip-Hop / R&B / Country this pass. Rock only.
  (The config makes adding them later a table edit — that is the point, but don't
  add them now.)
- No UI or mechanism for a host to build a custom ad-hoc round by picking
  individual songs. Round composition is always "N categories, up to 5 randomly
  sampled songs each".
- No cross-game repeat prevention. Used-song tracking is per game and resets on
  rematch, exactly like today.
- No changes to the reconnect-token / disconnect-grace / pause / Cast-handshake
  machinery beyond the phase-name additions listed in §B8 and risk 7.
