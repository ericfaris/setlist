// ============================================================================
// Setlist — canonical server-side game-state data model.
// This is the single source of truth. Clients render projections of it with
// hidden fields stripped (see projection.ts). Nothing in here is broadcast
// verbatim; the projectors decide what each surface may see.
// ============================================================================
import type { BankQuestion } from './questions.js';

export type RoomPhase =
  | 'LOBBY' // pre-game, players joining
  | 'BOARD' // host is picking a cell
  | 'PLAYING' // clip is playing, buzzers armed
  | 'LOCKED' // someone buzzed; music paused, host judges
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

export interface BoardCell {
  categoryIndex: number;
  rowIndex: number;
  /** POINT_VALUES[rowIndex] — the authoritative value, not the bank's suggestion. */
  value: number;
  /** Key into the engine's private question map. Carries no song data itself. */
  questionId: string;
  used: boolean;
}

export interface BoardCategory {
  id: string;
  title: string;
}

export interface BoardState {
  categories: BoardCategory[];
  cells: BoardCell[];
}

export type JudgeVerdict = { titleCorrect: boolean; artistCorrect: boolean };

export interface ActiveQuestion {
  cell: BoardCell;
  /** SERVER-ONLY in full (title/artist are the answer, videoId is a spoiler). */
  question: BankQuestion;
  startedAt: number; // ms epoch when PLAYING began
  startSeconds: number; // resolved clip offset
  durationSeconds: number; // resolved clip length
  lockedPlayerId: string | null; // the buzz winner
  /** SERVER timestamp taken when the buzz was processed. Never client-supplied. */
  lockedAt: number | null;
  lockedOutPlayerIds: string[]; // already guessed wrong on this question
  verdict: JudgeVerdict | null;
  awarded: number; // points delta applied (may be negative)
  revealed: boolean;
  /** Bumped every time playback should (re)start; the receiver watches it. */
  playToken: number;
  playbackError: string | null; // the receiver reported the video won't embed/play
  /** True only when the clip ran out with nobody buzzing (clipExpired()) — not
   * set for a host skip, which reveals via the same phase transition. Drives
   * the "times up" sound on the receiver. */
  timedOut: boolean;
  /** True while the server is searching for / loading a substitute video.
   *  Buzzing is disabled and the clip timer is suspended while true. */
  retrying: boolean;
  /** Server-only from here down — deliberately NOT in PublicActiveQuestion. */
  retryAttempts: number;
  retryCandidates: string[];
  substituteVideoId: string | null;
  retryId: string | null;
  lastPlaybackErrorMessage: string | null;
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
  board: BoardState | null; // null while in LOBBY
  active: ActiveQuestion | null;
  winnerPlayerIds: string[]; // supports ties
  castConnected: boolean; // must be true to leave LOBBY
  createdAt: number;
  /** phase to return to when un-pausing */
  phaseBeforePause: RoomPhase | null;
  pause: PauseState;
}

// ---------- Constants ----------
export const BOARD_ROWS = 5;
export const BOARD_COLUMNS = 5;
export const POINT_VALUES = [100, 200, 300, 400, 500] as const;
/** Solo play is fine — the game has no structural need for a minimum. */
export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 10;
export const DEFAULT_CLIP_START_SECONDS = 30;
export const DEFAULT_CLIP_DURATION_SECONDS = 20;
/** Alternate uploads tried automatically before auto-skipping the question. */
export const MAX_SUBSTITUTION_ATTEMPTS = 3;
