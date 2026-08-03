// Socket.IO wiring: clients send intents, the server validates via the engine
// and broadcasts spectator-safe projections. Also schedules the clip timer.
import type { Server, Socket } from 'socket.io';
import { MAX_SUBSTITUTION_ATTEMPTS } from '@setlist/shared';
import type { Ack, ClientToServer, ServerToClient } from '@setlist/shared';
import { toPrivateState, toPublicRoom } from '../engine/project.js';
import type { RoomManager, RoomRuntime } from './rooms.js';
import { pickCandidates } from './songmatch.js';
import type { YouTubeSearchClient } from './youtube.js';

type IO = Server<ClientToServer, ServerToClient>;
type Sock = Socket<ClientToServer, ServerToClient>;

interface SocketData {
  code?: string;
  playerId?: string;
  isReceiver?: boolean;
}

const okAck = <T>(data: T): Ack<T> => ({ ok: true, data });
const errAck = (error: string): Ack<never> => ({ ok: false, error });

// How long a disconnected player gets before it actually registers. A
// background tab / brief network drop looks identical to a real disconnect at
// the socket level; assume it's temporary and stay silent about it unless it
// outlasts this window. Combined with the ~60s Socket.IO pingTimeout
// (index.ts), that's a ~2min total tolerance for a player to wander off and
// come back unnoticed. Overridable so tests don't burn real seconds.
const DEFAULT_DISCONNECT_GRACE_MS = 60_000;

/** Small pad so the timer never fires a hair before the clip's own deadline. */
const CLIP_TIMER_PAD_MS = 250;

export function attachSocketServer(
  io: IO,
  rooms: RoomManager,
  opts: { disconnectGraceMs?: number; youtube?: YouTubeSearchClient | null } = {},
): void {
  const disconnectGraceMs = opts.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
  /** null = runtime song substitution is off; the server behaves as it did
   *  before the feature existed. */
  const youtube = opts.youtube ?? null;
  const data = (s: Sock) => s.data as SocketData;
  const standbyReceivers = new Set<string>(); // socketIds waiting for a room code

  function broadcast(runtime: RoomRuntime): void {
    const now = Date.now();
    const pub = toPublicRoom(runtime.engine.room, now);
    io.to(runtime.engine.room.code).emit('room:state', pub);
    for (const [socketId, playerId] of runtime.sockets) {
      io.to(socketId).emit('you:state', toPrivateState(runtime.engine, playerId));
    }
    for (const socketId of runtime.receivers) {
      // The one place isReceiver is set — this is what unlocks the videoId.
      io.to(socketId).emit('you:state', toPrivateState(runtime.engine, null, { isReceiver: true }));
    }
    reconcileTimer(runtime);
  }

  /**
   * Re-arm the single per-room timer. Only PLAYING has an automatic action:
   * the clip running out with nobody buzzing. Cleared on every phase change so
   * a stale timer can never yank a question out from under a locked-in buzz.
   */
  function reconcileTimer(runtime: RoomRuntime): void {
    if (runtime.timer) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }
    const room = runtime.engine.room;
    // `!retrying`: a clip that failed at second 19 must not expire and reveal
    // the answer while we're mid-search. playSubstitute() re-stamps startedAt,
    // so the substitute gets a full clip.
    if (room.phase === 'PLAYING' && room.active && !room.active.retrying) {
      const deadline = room.active.startedAt + room.active.durationSeconds * 1000;
      const delay = Math.max(0, deadline - Date.now());
      runtime.timer = setTimeout(() => {
        runtime.timer = null;
        const res = runtime.engine.clipExpired();
        if (res.ok) broadcast(runtime);
      }, delay + CLIP_TIMER_PAD_MS);
    }
  }

  /**
   * Runtime song substitution. The engine holds all state and enforces the
   * 2-attempt cap; this function only performs the I/O and hands the result
   * back. Mirrors reconcileTimer's shape: side effect out here, decision in the
   * engine. Never throws — every failure path ends in exhaustRetries().
   */
  async function trySubstitute(runtime: RoomRuntime): Promise<void> {
    const engine = runtime.engine;
    const begun = engine.beginRetry();
    if (!begun.ok) return; // cap hit, wrong phase, already retrying
    broadcast(runtime); // players see "finding another version…"

    if (begun.needSearch) {
      let results: Awaited<ReturnType<YouTubeSearchClient['searchVideos']>> = [];
      try {
        results = await youtube!.searchVideos(`${begun.title} ${begun.artist}`);
      } catch (e) {
        // The real client never rejects; a fake or a future one might.
        console.warn(`[youtube] search threw: ${(e as Error).message}`);
        results = [];
      }
      const picked = pickCandidates({ title: begun.title, artist: begun.artist }, results, {
        excludeVideoIds: begun.excludeVideoIds,
        limit: MAX_SUBSTITUTION_ATTEMPTS,
      });
      const applied = engine.resolveRetrySearch(begun.retryId, picked.map((c) => c.videoId));
      // Stale: the question has moved on. Do nothing at all — no engine call,
      // no broadcast — so the *new* question's state is never disturbed.
      if (!applied.ok) return;
    }

    const played = engine.playSubstitute();
    if (!played.ok) engine.exhaustRetries();
    broadcast(runtime);
  }

  function runtimeForSocket(s: Sock): RoomRuntime | undefined {
    const code = data(s).code;
    return code ? rooms.get(code) : undefined;
  }

  io.on('connection', (socket: Sock) => {
    /** Fire-and-forget intents (no ack): run then broadcast if it applied. */
    const withPlayer = (fn: (rt: RoomRuntime, playerId: string) => void) => {
      const runtime = runtimeForSocket(socket);
      const playerId = data(socket).playerId;
      if (runtime && playerId) {
        fn(runtime, playerId);
        broadcast(runtime);
      }
    };
    /** Ack-bearing intents: surface the engine's error verbatim to the caller. */
    const acked = (
      ack: (res: Ack<{}>) => void,
      fn: (rt: RoomRuntime, playerId: string) => { ok: true } | { ok: false; error: string },
    ) => {
      const runtime = runtimeForSocket(socket);
      const playerId = data(socket).playerId;
      if (!runtime || !playerId) return ack(errAck('Not in a room.'));
      const res = fn(runtime, playerId);
      if (!res.ok) return ack(errAck(res.error));
      ack(okAck({}));
      broadcast(runtime);
    };

    // ---- Host creates a room (cast handshake happens client-side first) ----
    socket.on('host:create', (payload, ack) => {
      try {
        const runtime = rooms.create();
        const code = runtime.engine.room.code;
        console.log(`[room] ${code} created`);
        data(socket).code = code;
        socket.join(code);
        socket.emit('host:created', { code });
        if (payload.canCast) {
          rooms.setPendingCastCode(code);
          for (const sid of standbyReceivers) io.to(sid).emit('cast:roomCode', { code });
          standbyReceivers.clear();
        }
        ack(okAck({ code }));
      } catch (e) {
        ack(errAck((e as Error).message));
      }
    });

    socket.on('host:castStatus', ({ connected }) => {
      const runtime = runtimeForSocket(socket);
      if (!runtime) return;
      runtime.engine.setCastConnected(connected);
      if (connected && standbyReceivers.size > 0) {
        const code = runtime.engine.room.code;
        for (const sid of standbyReceivers) io.to(sid).emit('cast:roomCode', { code });
        standbyReceivers.clear();
      }
      broadcast(runtime);
    });

    socket.on('receiver:standby', () => {
      const code = rooms.getPendingCastCode();
      if (code) {
        io.to(socket.id).emit('cast:roomCode', { code });
      } else {
        standbyReceivers.add(socket.id);
      }
    });

    // ---- Join (lobby or mid-game; reconnect via token) ----
    socket.on('room:join', ({ code, displayName, reconnectToken, canCast }, ack) => {
      const runtime = rooms.get(code);
      if (!runtime) return ack(errAck('Room not found.'));
      const res = runtime.engine.join({ displayName, reconnectToken, canCast });
      if (!res.ok) return ack(errAck(res.error));
      // They're back — don't let a stale delayed disconnect land on top of them.
      const pendingGrace = runtime.disconnectGraceTimers.get(res.player.id);
      if (pendingGrace) {
        clearTimeout(pendingGrace);
        runtime.disconnectGraceTimers.delete(res.player.id);
      }
      data(socket).code = code;
      data(socket).playerId = res.player.id;
      runtime.sockets.set(socket.id, res.player.id);
      socket.join(code);
      ack(okAck({ playerId: res.player.id, reconnectToken: res.player.reconnectToken }));
      broadcast(runtime);
    });

    // ---- TV receiver subscribes read-only ----
    socket.on('receiver:subscribe', ({ code }, ack) => {
      const runtime = rooms.get(code);
      if (!runtime) {
        console.log(`[receiver] subscribe to ${code} failed: room not found`);
        return ack(errAck('Room not found.'));
      }
      console.log(`[receiver] subscribed to ${code}`);
      data(socket).code = code;
      data(socket).isReceiver = true;
      runtime.receivers.add(socket.id);
      socket.join(code);
      runtime.engine.setCastConnected(true);
      ack(okAck({}));
      broadcast(runtime);
    });

    socket.on('receiver:playbackError', ({ message, playToken }) => {
      const runtime = runtimeForSocket(socket);
      if (!runtime || !data(socket).isReceiver) return;
      const res = runtime.engine.reportPlaybackError(message, playToken);
      if (!res.ok) return; // stale / duplicate onError — ignore silently
      console.log(`[receiver] playback error in ${runtime.engine.room.code}: ${message}`);
      // Broadcast first so the no-substitution path is byte-identical to the
      // pre-feature behavior and the host sees something immediately; the
      // async attempt broadcasts again when it changes state.
      broadcast(runtime);
      if (youtube) void trySubstitute(runtime);
    });

    // ---- Lobby ----
    socket.on('game:settings', (patch) => {
      withPlayer((rt, hostId) => rt.engine.updateSettings(hostId, patch));
    });
    socket.on('game:start', (_payload, ack) => {
      acked(ack, (rt, hostId) => rt.engine.start(hostId));
    });
    socket.on('host:transfer', ({ playerId }, ack) => {
      acked(ack, (rt, hostId) => rt.engine.transferHost(hostId, playerId));
    });

    // ---- Board / play ----
    socket.on('board:select', ({ categoryIndex, rowIndex }, ack) => {
      acked(ack, (rt, hostId) => rt.engine.selectCell(hostId, categoryIndex, rowIndex));
    });
    socket.on('buzz:press', (_payload, ack) => {
      // The race. The engine's guard decides it; everyone else gets an error
      // ack AND, more importantly, the broadcast below flips their UI to locked
      // regardless of ack ordering.
      acked(ack, (rt, pid) => rt.engine.buzz(pid));
    });
    socket.on('judge:answer', (verdict, ack) => {
      acked(ack, (rt, hostId) => rt.engine.judge(hostId, verdict));
    });
    socket.on('question:skip', (_payload, ack) => {
      acked(ack, (rt, hostId) => rt.engine.skipQuestion(hostId));
    });
    socket.on('playback:replay', (_payload, ack) => {
      acked(ack, (rt, hostId) => rt.engine.replayClip(hostId));
    });
    socket.on('question:next', (_payload, ack) => {
      acked(ack, (rt, hostId) => rt.engine.nextQuestion(hostId));
    });

    // ---- Host powers ----
    socket.on('host:forceEnd', () => {
      withPlayer((rt, hostId) => rt.engine.forceEnd(hostId));
    });
    socket.on('host:rematch', (_payload, ack) => {
      acked(ack, (rt, hostId) => rt.engine.rematch(hostId));
    });

    // ---- Disconnect ----
    socket.on('disconnect', () => {
      standbyReceivers.delete(socket.id);
      const code = data(socket).code;
      if (!code) return;
      const runtime = rooms.get(code);
      if (!runtime) return;
      if (data(socket).isReceiver) {
        runtime.receivers.delete(socket.id);
        console.log(
          `[receiver] disconnected from ${code} (${runtime.receivers.size} receivers left)`,
        );
        if (runtime.receivers.size === 0) runtime.engine.setCastConnected(false);
        if (rooms.closeIfEmpty(code)) {
          console.log(`[room] ${code} closed (empty)`);
        } else {
          broadcast(runtime);
        }
        return;
      }

      const playerId = runtime.sockets.get(socket.id);
      runtime.sockets.delete(socket.id);
      if (!playerId) return;

      // Don't react the instant a socket drops — a backgrounded tab or brief
      // blip is indistinguishable from a real disconnect at this level. Give
      // them a window to come back silently (room:join cancels this timer).
      const existingGrace = runtime.disconnectGraceTimers.get(playerId);
      if (existingGrace) clearTimeout(existingGrace);
      const graceTimer = setTimeout(() => {
        runtime.disconnectGraceTimers.delete(playerId);
        if (rooms.get(code) !== runtime) return; // room was replaced/closed meanwhile
        runtime.engine.disconnect(playerId);
        if (rooms.closeIfEmpty(code)) {
          console.log(`[room] ${code} closed (empty)`);
        } else {
          broadcast(runtime);
        }
      }, disconnectGraceMs);
      runtime.disconnectGraceTimers.set(playerId, graceTimer);
    });
  });
}
