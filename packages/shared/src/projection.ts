// ============================================================================
// Spectator-safe projections. The server NEVER broadcasts hidden info to a
// client that must not see it. Two surfaces:
//   - PublicRoom:   broadcast to everyone in the room, including the TV.
//   - PrivateState: sent only to the owning socket.
//
// Music trivia has two secrets:
//   1. The ANSWER (title + artist) of the active question — host only, until
//      the reveal. `PublicActiveQuestion.answer` stays null until revealed.
//   2. The CATALOG's song data (titles, artists, videoIds) — the host's own
//      socket only, and only for the one song on deck. The host has to play the
//      song, so they legitimately know it; nobody else may. It appears in
//      exactly one place: PrivateState.hostOnDeck, populated only for the host.
//
// The CATEGORY of the upcoming song is public from ON_DECK onwards
// (PublicRoom.onDeck) — a category name is not an answer. That is the only new
// public information in the round structure, and PublicOnDeck carries nothing
// else about the song.
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
  streak: number; // consecutive correct judges — see ON_FIRE_STREAK in types.ts
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

/**
 * The upcoming song's CATEGORY, plus counters. PUBLIC — everyone, including the
 * TV. It carries no song id, title, artist or videoId, and never may:
 * `PublicActiveQuestion.sectionTitle` already makes the category public from
 * ARMED onwards, so this is purely a phase-shift of information that was
 * already public one step later. Build it field by field.
 */
export interface PublicOnDeck {
  categoryTitle: string; // e.g. "90s Grunge" — the only new public info
  roundNumber: number; // 1..TOTAL_ROUNDS
  indexInRound: number; // 1-based position within the round's queue
  songsInRound: number; // the round's queue length
}

/** Round progress for the TV's status line. Counts only. */
export interface PublicRound {
  number: number;
  songsTotal: number;
  songsPlayed: number;
}

export interface PublicRoom {
  code: string;
  phase: RoomPhase;
  settings: RoomSettings;
  players: PublicPlayer[];
  active: PublicActiveQuestion | null;
  /** Non-null ONLY in ON_DECK. Category title + counters, nothing else. */
  onDeck: PublicOnDeck | null;
  /** Null in LOBBY/GAME_OVER. */
  round: PublicRound | null;
  /** Whole-catalog progress only — counts, never song data. */
  songsTotal: number;
  songsRemaining: number;
  winnerPlayerIds: string[];
  castConnected: boolean;
  pause: PauseState;
  /** server time when projected, so clients can reconcile clock skew. */
  serverNow: number;
}

// ---------- Host-only: the round category picker ----------
/** One pickable category in the host's round picker. Counts only — a category
 *  title is public from ON_DECK anyway; the song data behind it never is. */
export interface CategoryOption {
  id: string; // BankCategory.id
  title: string;
  available: number; // unused songs left this game (0 = "all played", disabled)
}
export interface CategoryGroup {
  slug: string;
  label: string;
  categories: CategoryOption[];
}
export interface CategoryPicker {
  roundNumber: number;
  required: number; // how many to pick (already clamped to what's selectable)
  perCategory: number; // SONGS_PER_CATEGORY_PER_ROUND, for the copy
  groups: CategoryGroup[];
}

/** HOST-ONLY. The one song on deck, as the host needs it: they have to play it.
 *  This must never be projected onto a non-host socket. */
export interface HostSong {
  /** The same opaque `s<i>q<j>` id that is already public as
   *  PublicActiveQuestion.songId — the host sends it back with `setlist:start`. */
  songId: string;
  title: string;
  artist: string;
  videoId: string;
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
  /** Host-only, same gate as hostAnswer. Lets the host (re)open the YouTube
   *  Music link at any point while armed/locked — server-driven so it survives
   *  a reload/reconnect rather than depending on client-local tap-time state. */
  hostVideoId: string | null;
  /** Host-only, and only while phase === 'ROUND_SETUP'. Null for everyone else,
   *  always. There is no free browsing any more — this is counts, not songs. */
  categoryPicker: CategoryPicker | null;
  /** Host-only, and only while phase === 'ON_DECK'. The single song the host is
   *  about to play. Null for everyone else, always. */
  hostOnDeck: HostSong | null;
}
