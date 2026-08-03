// ============================================================================
// Setlist — canonical server-side game-state data model.
// This is the single source of truth. Clients render projections of it with
// hidden fields stripped (see projection.ts). Nothing in here is broadcast
// verbatim; the projectors decide what each surface may see.
//
// The game is a setlist, not a board: the host browses themed sections of the
// question bank on their own phone, plays the song themselves via a native
// YouTube Music link, then arms the buzzers. Our app plays no media at all.
// ============================================================================
import type { BankQuestion } from './questions.js';

export type RoomPhase =
  | 'LOBBY' // pre-game, players joining
  | 'SETLIST' // host is browsing/choosing the next song
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
  joinOrder: number; // monotonically increasing; drives host succession order
  pendingJoin: boolean; // joined mid-game; plays from the next question on
}

/** One bank category, flattened into a setlist section header. */
export interface SetlistSection {
  index: number;
  id: string; // BankCategory.id
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
  setlist: SetlistState | null; // null while in LOBBY
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
/** The host never buzzes, so a solo game has nobody who could answer. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;
