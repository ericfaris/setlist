// ============================================================================
// Spectator-safe projectors. Build the broadcast PublicRoom and the per-socket
// PrivateState from the authoritative GameRoom, stripping hidden info.
//
// Two secrets, and exactly where each is allowed to appear:
//   1. The ANSWER (title + artist) — PublicActiveQuestion.answer stays null
//      until `revealed`; before that only the host sees it, via
//      PrivateState.hostAnswer. The host picked the song, so they get it from
//      the moment the round is armed — but on their own socket and nowhere else.
//   2. The SETLIST's song data (titles, artists, videoIds) — only
//      PrivateState.setlist, and only for the host. A player who saw a videoId
//      could just look the song up; a player who saw the list knows what's
//      coming.
//
// The TV receiver is now the LEAST privileged surface: it plays no media, so it
// needs nothing private at all.
// ============================================================================
import type {
  GameRoom,
  HostSetlistSection,
  PrivateState,
  PublicActiveQuestion,
  PublicAnswer,
  PublicRoom,
  SetlistState,
} from '@setlist/shared';
import { SONG_POINT_VALUE } from '@setlist/shared';
import type { GameEngine } from './engine.js';

export function toPublicRoom(room: GameRoom, now: number): PublicRoom {
  let active: PublicActiveQuestion | null = null;
  if (room.active) {
    const a = room.active;
    const answer: PublicAnswer | null = a.revealed
      ? { title: a.question.title, artist: a.question.artist }
      : null;
    active = {
      songId: a.songId,
      sectionTitle: room.setlist?.sections[a.sectionIndex]?.title ?? '',
      value: SONG_POINT_VALUE,
      startedAt: a.startedAt,
      lockedPlayerId: a.lockedPlayerId,
      lockedOutPlayerIds: [...a.lockedOutPlayerIds],
      verdict: a.verdict ? { ...a.verdict } : null,
      awarded: a.awarded,
      revealed: a.revealed,
      answer,
      // `question` (title/artist/videoId) and pickedByPlayerId intentionally
      // omitted. This object is built field by field (never `...a`) precisely
      // so a new server-only field can't leak by accident.
    };
  }

  const songs = room.setlist?.songs ?? [];

  return {
    code: room.code,
    phase: room.phase,
    settings: { ...room.settings },
    players: room.players.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      connected: p.connected,
      isHost: p.isHost,
      canHostCast: p.canHostCast,
      score: p.score,
      joinOrder: p.joinOrder,
      pendingJoin: p.pendingJoin,
    })),
    active,
    // Counts only. There is deliberately NO setlist field on PublicRoom — the
    // songs live on GameRoom now, and this is the sole reason that is safe.
    songsTotal: songs.length,
    songsRemaining: songs.filter((s) => !s.used).length,
    winnerPlayerIds: [...room.winnerPlayerIds],
    castConnected: room.castConnected,
    pause: { ...room.pause },
    serverNow: now,
  };
}

/** Group the setlist into host-facing sections. Field by field, never spread —
 *  a SetlistSong carries the whole BankQuestion. */
function toHostSetlist(setlist: SetlistState): HostSetlistSection[] {
  return setlist.sections
    .map((section) => ({
      title: section.title,
      songs: setlist.songs
        .filter((s) => s.sectionIndex === section.index)
        .map((s) => ({
          id: s.id,
          title: s.question.title,
          artist: s.question.artist,
          videoId: s.question.videoId,
          used: s.used,
        })),
    }))
    .filter((section) => section.songs.length > 0);
}

export function toPrivateState(engine: GameEngine, playerId: string | null): PrivateState {
  const room = engine.room;
  const a = room.active;

  // Receiver (and unseated) sockets: nothing privileged at all.
  if (!playerId) {
    return {
      playerId: null,
      reconnectToken: null,
      isHost: false,
      score: 0,
      canBuzz: false,
      hostAnswer: null,
      hostVideoId: null,
      setlist: null,
    };
  }

  const p = room.players.find((pl) => pl.id === playerId);
  const isHost = p?.isHost ?? false;
  // The host picked the song, so they legitimately know it from the moment the
  // round is armed — but still ONLY on the host's own socket. Do not widen this
  // to `a !== null`: that would hand the answer to every player.
  const hostAnswer: PublicAnswer | null =
    isHost && a ? { title: a.question.title, artist: a.question.artist } : null;
  // Same gate as hostAnswer — lets the host reopen the YouTube Music link at
  // any point while armed/locked, server-driven so a reload/reconnect doesn't
  // strand them without it.
  const hostVideoId: string | null = isHost && a ? a.question.videoId : null;
  // Host-only, and only while browsing: the full setlist, answers and all.
  const setlist =
    isHost && room.phase === 'SETLIST' && room.setlist ? toHostSetlist(room.setlist) : null;

  return {
    playerId,
    reconnectToken: p?.reconnectToken ?? null,
    isHost,
    score: p?.score ?? 0,
    canBuzz: engine.canBuzz(playerId),
    hostAnswer,
    hostVideoId,
    setlist,
  };
}
