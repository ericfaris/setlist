// ============================================================================
// Spectator-safe projectors. Build the broadcast PublicRoom and the per-socket
// PrivateState from the authoritative GameRoom, stripping hidden info.
//
// Three secrets, and exactly where each is allowed to appear:
//   1. The ANSWER (title + artist) — PublicActiveQuestion.answer stays null
//      until `revealed`; before that only the host sees it, via
//      PrivateState.hostAnswer.
//   2. The videoId — only PrivateState.receiverPlayback, and only for sockets
//      flagged isReceiver. A player who saw it could just look the song up.
//   3. Unplayed cells' song data — never projected at all; public cells carry
//      position/value/used and an opaque questionId.
// ============================================================================
import type {
  GameRoom,
  PrivateState,
  PublicActiveQuestion,
  PublicAnswer,
  PublicRoom,
  ReceiverPlayback,
} from '@setlist/shared';
import type { GameEngine } from './engine.js';

export function toPublicRoom(room: GameRoom, now: number): PublicRoom {
  let active: PublicActiveQuestion | null = null;
  if (room.active) {
    const a = room.active;
    const answer: PublicAnswer | null = a.revealed
      ? { title: a.question.title, artist: a.question.artist }
      : null;
    active = {
      cell: { ...a.cell },
      categoryTitle: room.board?.categories[a.cell.categoryIndex]?.title ?? '',
      value: a.cell.value,
      startedAt: a.startedAt,
      durationSeconds: a.durationSeconds,
      lockedPlayerId: a.lockedPlayerId,
      lockedOutPlayerIds: [...a.lockedOutPlayerIds],
      verdict: a.verdict ? { ...a.verdict } : null,
      awarded: a.awarded,
      revealed: a.revealed,
      answer,
      playbackError: a.playbackError,
      timedOut: a.timedOut,
      retrying: a.retrying,
      // videoId intentionally omitted — see PrivateState.receiverPlayback.
      // So are substituteVideoId / retryCandidates: a candidate id is exactly
      // as much of a spoiler as the original. This object is built field by
      // field (never `...a`) precisely so a new server-only field can't leak.
    };
  }

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
    board: room.board
      ? {
          categories: room.board.categories.map((c) => ({ ...c })),
          cells: room.board.cells.map((c) => ({ ...c })),
        }
      : null,
    active,
    winnerPlayerIds: [...room.winnerPlayerIds],
    castConnected: room.castConnected,
    pause: { ...room.pause },
    serverNow: now,
  };
}

export interface PrivateOpts {
  /** True only for TV receiver sockets. Player sockets must never pass this. */
  isReceiver?: boolean;
}

export function toPrivateState(
  engine: GameEngine,
  playerId: string | null,
  opts: PrivateOpts = {},
): PrivateState {
  const room = engine.room;
  const a = room.active;

  // Receiver sockets have no seat but do need the one thing nobody else may
  // see: which video to play, from where.
  // When runtime song substitution has swapped in an alternate upload, that
  // substitute id travels through this same receiver-only channel — no new
  // event, no new surface, so the videoId secret keeps exactly one home.
  let receiverPlayback: ReceiverPlayback | null = null;
  if (opts.isReceiver && a) {
    receiverPlayback = {
      videoId: a.substituteVideoId ?? a.question.videoId,
      startSeconds: a.startSeconds,
      durationSeconds: a.durationSeconds,
      playToken: a.playToken,
      // Buzzing cuts the music — that's the Jeopardy feel — and so does the
      // reveal, where the TV is showing the answer instead.
      paused: room.phase !== 'PLAYING',
    };
  }

  if (!playerId) {
    return {
      playerId: null,
      reconnectToken: null,
      isHost: false,
      score: 0,
      canBuzz: false,
      hostAnswer: null,
      receiverPlayback,
    };
  }

  const p = room.players.find((pl) => pl.id === playerId);
  const isHost = p?.isHost ?? false;
  // The host needs the answer to judge against — but not a moment before
  // someone (possibly the host themselves) has actually locked in. Sending it
  // any earlier would spoil the clip for a host who is also playing.
  const questionLocked = !!a && (a.lockedPlayerId !== null || a.revealed);
  const hostAnswer: PublicAnswer | null =
    isHost && questionLocked ? { title: a!.question.title, artist: a!.question.artist } : null;

  return {
    playerId,
    reconnectToken: p?.reconnectToken ?? null,
    isHost,
    score: p?.score ?? 0,
    canBuzz: engine.canBuzz(playerId),
    hostAnswer,
    receiverPlayback,
  };
}
