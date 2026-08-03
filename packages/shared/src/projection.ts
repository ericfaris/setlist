// ============================================================================
// Spectator-safe projections. The server NEVER broadcasts hidden info to a
// client that must not see it. Two surfaces:
//   - PublicRoom:   broadcast to everyone in the room, including the TV.
//   - PrivateState: sent only to the owning socket.
//
// Music trivia has two secrets:
//   1. The ANSWER (title + artist) of the active question — host only, until
//      the reveal. `PublicActiveQuestion.answer` stays null until revealed.
//   2. The SETLIST's song data (titles, artists, videoIds) — the host's own
//      socket only. The host has to pick and play the songs, so they
//      legitimately know them; nobody else may. It appears in exactly one
//      place: PrivateState.setlist, populated only for the host.
//
// There is no receiver secret any more: our app never plays media, so the TV
// receiver is now the LEAST privileged surface in the system.
// ============================================================================
import type { JudgeVerdict, RoomPhase, RoomSettings, PauseState } from './types.js';

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
  songId: string; // opaque; carries no song data
  sectionTitle: string; // the theme label — public, like the old category header
  value: number; // always SONG_POINT_VALUE
  startedAt: number;
  lockedPlayerId: string | null;
  lockedOutPlayerIds: string[];
  verdict: JudgeVerdict | null;
  awarded: number;
  revealed: boolean;
  answer: PublicAnswer | null; // null until revealed === true — the one secret left here
  // NOTE: no videoId, no title/artist pre-reveal. Built field by field, never `...a`.
}

export interface PublicRoom {
  code: string;
  phase: RoomPhase;
  settings: RoomSettings;
  players: PublicPlayer[];
  active: PublicActiveQuestion | null;
  /** Progress only — counts, never song data. */
  songsTotal: number;
  songsRemaining: number;
  winnerPlayerIds: string[];
  castConnected: boolean;
  pause: PauseState;
  /** server time when projected, so clients can reconcile clock skew. */
  serverNow: number;
}

/** HOST-ONLY. The host legitimately knows every song — they have to pick and
 *  play them. This must never be projected onto a non-host socket. */
export interface HostSetlistSong {
  id: string;
  title: string;
  artist: string;
  videoId: string;
  used: boolean;
}
export interface HostSetlistSection {
  title: string;
  songs: HostSetlistSong[];
}

// ---------- Private (only the owning socket) ----------
export interface PrivateState {
  playerId: string | null;
  reconnectToken: string | null;
  isHost: boolean;
  score: number;
  /** True if this socket may buzz right now (armed, not locked out, not the locker). */
  canBuzz: boolean;
  /** Host-only. Now populated from the moment the round is ARMED (the host picked
   *  the song, so hiding it is pointless) — but still ONLY for the host socket. */
  hostAnswer: PublicAnswer | null;
  /** Host-only, and only while phase === 'SETLIST'. Null for everyone else, always. */
  setlist: HostSetlistSection[] | null;
}
