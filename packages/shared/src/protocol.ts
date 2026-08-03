// ============================================================================
// Wire protocol: socket event names + intent/payload shapes shared by client
// and server. Clients send *intents*; the server validates, mutates the
// authoritative state, and broadcasts projections (see projection.ts).
// ============================================================================
import type { JudgeVerdict } from './types.js';
import type { PublicRoom, PrivateState } from './projection.js';

// ---------- Client -> Server intents ----------
export interface ClientToServer {
  /** Host: create a room. Server generates the code, returns it via host:created. */
  'host:create': (
    payload: { canCast: boolean },
    ack: (res: Ack<{ code: string }>) => void,
  ) => void;

  /** Host: report cast session connected/disconnected for their room. */
  'host:castStatus': (payload: { connected: boolean }) => void;

  /** Join a room (lobby or mid-game). reconnectToken optional (reclaim seat). */
  'room:join': (
    payload: {
      code: string;
      displayName: string;
      reconnectToken?: string;
      canCast?: boolean;
    },
    ack: (res: Ack<{ playerId: string; reconnectToken: string }>) => void,
  ) => void;

  /** TV receiver subscribes read-only to a room. */
  'receiver:subscribe': (payload: { code: string }, ack: (res: Ack<{}>) => void) => void;

  /** TV receiver: no room code yet, wait for the host to cast. */
  'receiver:standby': (_: {}) => void;

  /** Host starts the game: LOBBY -> ROUND_SETUP (builds the catalog). */
  'game:start': (_: {}, ack: (res: Ack<{}>) => void) => void;
  /** Host updates room settings (lobby only). */
  'game:settings': (payload: Partial<{ penalizeWrongAnswers: boolean }>) => void;
  /** Host hands the crown to another connected player. */
  'host:transfer': (payload: { playerId: string }, ack: (res: Ack<{}>) => void) => void;

  /** Host picks this round's categories: ROUND_SETUP -> ON_DECK. The server
   *  samples the songs and sequences them; there is no per-song choice. */
  'round:pickCategories': (
    payload: { categoryIds: string[] },
    ack: (res: Ack<{}>) => void,
  ) => void;

  /** Host arms the buzzers on the ON-DECK song: ON_DECK -> ARMED. The songId
   *  must be the one the server put on deck. */
  'setlist:start': (payload: { songId: string }, ack: (res: Ack<{}>) => void) => void;

  /**
   * The race. Deliberately carries NO timestamp field — buzz order is decided
   * solely by the order the server processes these messages.
   */
  'buzz:press': (_: {}, ack: (res: Ack<{}>) => void) => void;

  /** Host marks the locked-in answer: LOCKED -> ARMED (wrong) | REVEAL (right). */
  'judge:answer': (payload: JudgeVerdict, ack: (res: Ack<{}>) => void) => void;
  /** Host ends the round and shows the answer: -> REVEAL. */
  'question:reveal': (_: {}, ack: (res: Ack<{}>) => void) => void;
  /** Host advances: REVEAL -> ON_DECK | ROUND_SETUP | GAME_OVER. */
  'question:next': (_: {}, ack: (res: Ack<{}>) => void) => void;

  /** Host force-ends or restarts. */
  'host:forceEnd': (_: {}) => void;
  'host:rematch': (_: {}, ack: (res: Ack<{}>) => void) => void;
}

// ---------- Server -> Client events ----------
export interface ServerToClient {
  /** Host room created. */
  'host:created': (payload: { code: string }) => void;
  /** Full public room projection (broadcast to all clients in the room). */
  'room:state': (payload: PublicRoom) => void;
  /** Per-socket private state (your seat, host answer, host picker/on-deck). */
  'you:state': (payload: PrivateState) => void;
  /** Room closed / no longer exists. */
  'room:closed': (payload: { reason: string }) => void;
  /** Generic non-fatal error toast. */
  'error': (payload: { message: string }) => void;

  /** Server pushes the room code to a standby receiver when the host casts. */
  'cast:roomCode': (payload: { code: string }) => void;
}

export type Ack<T> = { ok: true; data: T } | { ok: false; error: string };

export const SOCKET_PATH = '/socket';
/** Must match the NS constant in packages/client/receiver.html. */
export const CAST_NAMESPACE = 'urn:x-cast:com.mooseflip.musictrivia';
