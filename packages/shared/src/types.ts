// ============================================================================
// Setlist — canonical server-side game-state data model.
// This is the single source of truth. Clients render projections of it with
// hidden fields stripped (see projection.ts). Nothing in here is broadcast
// verbatim; the projectors decide what each surface may see.
//
// The game is a setlist, not a board: play runs as three fixed rounds. At the
// start of each round the host picks 5/4/3 categories; the server samples up to
// 5 not-yet-used songs from each and sequences them round-robin. The host plays
// each song themselves via a native YouTube Music link, then arms the buzzers.
// Our app plays no media at all.
// ============================================================================
import type { BankQuestion } from './questions.js';

export type RoomPhase =
  | 'LOBBY' // pre-game, players joining
  | 'ROUND_SETUP' // host is picking this round's categories
  | 'ON_DECK' // next song chosen by the server; its CATEGORY is public
  | 'ARMED' // host has started the round; buzzers are live
  | 'LOCKED' // someone buzzed; host judges
  | 'REVEAL' // answer shown to everyone
  | 'GAME_OVER'
  | 'PAUSED'; // host dropped / cast dropped; see `pause`

export interface Player {
  id: string; // stable server-assigned id
  reconnectToken: string; // secret; how a returning player reclaims this seat
  displayName: string; // unique within the room (case-insensitive)
  connected: boolean;
  isHost: boolean; // exactly one at a time; transferable (see engine.transferHost)
  canHostCast: boolean; // this device reported Cast Sender support (Chrome)
  score: number; // may go negative when penalizeWrongAnswers is on
  streak: number; // consecutive correct judges; any wrong judge resets it to 0
  joinOrder: number; // monotonically increasing; drives host succession order
  pendingJoin: boolean; // joined mid-game; plays from the next question on
}

/** One bank category, flattened into a catalog section header. */
export interface SetlistSection {
  index: number;
  id: string; // BankCategory.id
  title: string; // BankCategory.title — the category label rounds are picked by
}

/** SERVER-ONLY in full: `question` carries the answer and the videoId. */
export interface SetlistSong {
  /** Opaque + positional (`s<section>q<index>`). NEVER derived from the bank id. */
  id: string;
  sectionIndex: number;
  question: BankQuestion;
  /**
   * Drawn into a round this game — set at SAMPLE time (when
   * `round:pickCategories` draws it), not at play time, and mirrored onto every
   * catalog entry with the same videoId. That is what makes "a song picked in
   * an earlier round is never re-sampled later" structurally true rather than
   * enforced by a second bookkeeping path.
   */
  used: boolean;
}

/**
 * The WHOLE-BANK CATALOG this game draws from — not a browsable list. Under the
 * round structure nobody browses this: the host picks categories, the server
 * samples from the unused songs of each.
 *
 * A videoId may appear in SEVERAL sections (a track legitimately belongs to
 * "Rock", "90s Rock" and "90s Grunge"), deduped only WITHIN a section. The
 * "never play the same song twice in one game" rule is enforced by marking
 * `used` by videoId at draw time instead.
 */
export interface SetlistState {
  sections: SetlistSection[];
  songs: SetlistSong[];
}

/** One category chosen for a round, with the songs drawn from it. */
export interface RoundCategory {
  categoryId: string; // BankCategory.id, via SetlistSection.id
  title: string; // denormalised for projection convenience
  songIds: string[]; // the sampled song ids for this round, in draw order
}

export interface RoundState {
  number: number; // 1..TOTAL_ROUNDS
  categories: RoundCategory[]; // in the order the host picked them
  queue: string[]; // round-robin ordered song ids (the play order)
  cursor: number; // index into queue: the song on deck / in play
}

export type JudgeVerdict = { titleCorrect: boolean; artistCorrect: boolean };

export interface ActiveQuestion {
  songId: string;
  sectionIndex: number;
  /** SERVER-ONLY (title/artist are the answer; videoId is a spoiler). */
  question: BankQuestion;
  /** Who armed this round. Permanently ineligible to buzz on it (see plan §2.7). */
  pickedByPlayerId: string;
  startedAt: number; // ms epoch when ARMED began
  lockedPlayerId: string | null; // the buzz winner
  /** SERVER timestamp taken when the buzz was processed. Never client-supplied. */
  lockedAt: number | null;
  lockedOutPlayerIds: string[]; // already guessed wrong on this question
  verdict: JudgeVerdict | null;
  awarded: number; // points delta applied (may be negative)
  revealed: boolean;
}

export interface RoomSettings {
  /** Wrong on both title and artist costs value/2. Off for a friendlier game. */
  penalizeWrongAnswers: boolean;
}

export interface PauseState {
  active: boolean;
  reason: 'PLAYER_DISCONNECT' | 'CAST_DROPPED' | null;
  waitingForPlayerId: string | null;
}

export interface GameRoom {
  code: string; // 4-digit join code
  phase: RoomPhase;
  settings: RoomSettings;
  players: Player[];
  setlist: SetlistState | null; // the catalog; null while in LOBBY
  round: RoundState | null; // null while in LOBBY / GAME_OVER
  active: ActiveQuestion | null;
  winnerPlayerIds: string[]; // supports ties
  castConnected: boolean; // must be true to leave LOBBY
  createdAt: number;
  /** phase to return to when un-pausing */
  phaseBeforePause: RoomPhase | null;
  pause: PauseState;
}

// ---------- Constants ----------
/** Flat per-song value. Title = half, artist = half, both wrong = minus half. */
export const SONG_POINT_VALUE = 100;
/** Three fixed rounds, then GAME_OVER. There is no round 4. */
export const TOTAL_ROUNDS = 3;
/** How many categories the host picks in round 1 / 2 / 3. */
export const ROUND_CATEGORY_COUNTS = [5, 4, 3] as const;
/** How many unused songs each picked category contributes (fewer if it's short). */
export const SONGS_PER_CATEGORY_PER_ROUND = 5;
/** The host never buzzes, so a solo game has nobody who could answer. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;
/** Consecutive correct judges before a player's scorecard is "on fire" (TV
 * flame animation + toast). Any wrong judge resets a player's streak to 0. */
export const ON_FIRE_STREAK = 3;
