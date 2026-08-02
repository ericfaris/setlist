// ============================================================================
// Spectator-safe projections. The server NEVER broadcasts hidden info to a
// client that must not see it. Two surfaces:
//   - PublicRoom:   broadcast to everyone in the room, including the TV.
//   - PrivateState: sent only to the owning socket.
//
// Music trivia has three secrets:
//   1. The ANSWER (title + artist) of the active question — host only, until
//      the reveal. `PublicActiveQuestion.answer` stays null until revealed.
//   2. The YouTube videoId of the active question — the TV receiver only. A
//      player who saw it could simply look it up. It appears in exactly one
//      place: PrivateState.receiverPlayback, populated only for receiver sockets.
//   3. Unplayed cells' song data — nobody, ever. Public board cells carry only
//      { categoryIndex, rowIndex, value, questionId, used }.
// ============================================================================
import type {
  BoardCell,
  BoardState,
  JudgeVerdict,
  RoomPhase,
  RoomSettings,
  PauseState,
} from './types.js';

// ---------- Public (everyone, incl. TV) ----------
export interface PublicPlayer {
  id: string;
  displayName: string;
  connected: boolean;
  isHost: boolean;
  canHostCast: boolean;
  score: number;
  joinOrder: number;
  pendingJoin: boolean;
}

/** Answer text — present ONLY once revealed. Never leak title/artist early. */
export interface PublicAnswer {
  title: string;
  artist: string;
}

export interface PublicActiveQuestion {
  cell: BoardCell;
  categoryTitle: string;
  value: number;
  startedAt: number;
  durationSeconds: number;
  lockedPlayerId: string | null;
  lockedOutPlayerIds: string[];
  verdict: JudgeVerdict | null;
  awarded: number;
  revealed: boolean;
  answer: PublicAnswer | null; // null until revealed === true
  playbackError: string | null;
  timedOut: boolean;
  // NOTE: videoId deliberately absent — see PrivateState.receiverPlayback.
}

export interface PublicRoom {
  code: string;
  phase: RoomPhase;
  settings: RoomSettings;
  players: PublicPlayer[];
  /** Cells carry no song data — only position, value and used. */
  board: BoardState | null;
  active: PublicActiveQuestion | null;
  winnerPlayerIds: string[];
  castConnected: boolean;
  pause: PauseState;
  /** server time when projected, so clients can reconcile clip countdowns. */
  serverNow: number;
}

/** What the TV receiver alone needs to actually play audio. */
export interface ReceiverPlayback {
  videoId: string;
  startSeconds: number;
  durationSeconds: number;
  /** Bumped every time playback should (re)start — the receiver watches this. */
  playToken: number;
  paused: boolean;
}

// ---------- Private (only the owning socket) ----------
export interface PrivateState {
  playerId: string | null;
  reconnectToken: string | null;
  isHost: boolean;
  score: number;
  /** True if this socket may buzz right now (armed, not locked out, not the locker). */
  canBuzz: boolean;
  /** Host-only: the answer to judge against, before the reveal. */
  hostAnswer: PublicAnswer | null;
  /** Receiver-only: what to play. Null for player sockets, always. */
  receiverPlayback: ReceiverPlayback | null;
}
