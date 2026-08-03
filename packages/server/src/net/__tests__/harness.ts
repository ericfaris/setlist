// Net-test harness: boot a real http.Server + Socket.IO on an ephemeral port
// and talk to it over actual WebSockets.
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import {
  SOCKET_PATH,
  type Ack,
  type PrivateState,
  type PublicRoom,
  type QuestionBank,
} from '@setlist/shared';
import { sampleQuestionBank } from '../../questions/bank.js';
import { RoomManager } from '../rooms.js';
import { attachSocketServer } from '../server.js';
import type { YouTubeSearchClient, YouTubeSearchResult } from '../youtube.js';

/** Real (short) grace period so tests exercise it without burning 60s each. */
export const TEST_DISCONNECT_GRACE_MS = 60;

export interface TestServer {
  port: number;
  rooms: RoomManager;
  close(): Promise<void>;
}

/**
 * Fake YouTube search client. Records every query it is asked; returns canned
 * results. No test ever touches the network or needs a real YOUTUBE_API_KEY.
 * `gate` (when set) defers resolution so a test can inspect the mid-search
 * "retrying" window.
 */
export interface FakeYouTube extends YouTubeSearchClient {
  queries: string[];
  results: YouTubeSearchResult[];
  /** Set to a promise to hold every search open until it resolves. */
  gate: Promise<void> | null;
  /** Set to make searchVideos reject (the real client never does). */
  throws: boolean;
}

export function fakeYouTube(results: YouTubeSearchResult[] = []): FakeYouTube {
  const fake: FakeYouTube = {
    queries: [],
    results,
    gate: null,
    throws: false,
    async searchVideos(query: string): Promise<YouTubeSearchResult[]> {
      fake.queries.push(query);
      if (fake.gate) await fake.gate;
      if (fake.throws) throw new Error('search exploded');
      return fake.results;
    },
  };
  return fake;
}

/** A manually-resolvable gate for deferring a fake search. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

export async function startTestServer(opts: {
  bank?: QuestionBank;
  clipDurationSeconds?: number;
  /** Default null = substitution off, i.e. exactly the pre-feature behavior. */
  youtube?: YouTubeSearchClient | null;
} = {}): Promise<TestServer> {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer, { path: SOCKET_PATH });
  const rooms = new RoomManager(opts.bank ?? sampleQuestionBank(), {
    // Long by default so the clip timer never fires mid-test unless asked.
    clipDurationSeconds: opts.clipDurationSeconds ?? 3600,
  });
  attachSocketServer(io as never, rooms, {
    disconnectGraceMs: TEST_DISCONNECT_GRACE_MS,
    youtube: opts.youtube ?? null,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as { port: number }).port;
  return {
    port,
    rooms,
    async close() {
      io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** A test client wrapping a socket with the latest public + private state. */
export class Client {
  socket: ClientSocket;
  pub: PublicRoom | null = null;
  priv: PrivateState | null = null;
  playerId = '';
  token = '';

  constructor(port: number) {
    this.socket = ioc(`http://localhost:${port}`, { path: SOCKET_PATH, forceNew: true });
    this.socket.on('room:state', (s: PublicRoom) => (this.pub = s));
    this.socket.on('you:state', (s: PrivateState) => (this.priv = s));
  }
  emit<T>(event: string, payload: unknown): Promise<Ack<T>> {
    return new Promise((resolve) => this.socket.emit(event, payload, resolve));
  }
  connected(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.connected) resolve();
      else this.socket.on('connect', () => resolve());
    });
  }
  close() {
    this.socket.disconnect();
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 30));

/** Create a room, attach a receiver, and join `n` players (first is host). */
export async function makeRoom(
  port: number,
  n: number,
): Promise<{ code: string; receiver: Client; players: Client[]; closeAll(): void }> {
  const host = new Client(port);
  await host.connected();
  const created = await host.emit<{ code: string }>('host:create', { canCast: true });
  if (!created.ok) throw new Error(created.error);
  const code = created.data.code;

  const receiver = new Client(port);
  await receiver.connected();
  const sub = await receiver.emit('receiver:subscribe', { code });
  if (!sub.ok) throw new Error(sub.error);

  const players: Client[] = [];
  for (let i = 0; i < n; i++) {
    const c = i === 0 ? host : new Client(port);
    if (i > 0) await c.connected();
    const r = await c.emit<{ playerId: string; reconnectToken: string }>('room:join', {
      code,
      displayName: `P${i}`,
      canCast: i === 0,
    });
    if (!r.ok) throw new Error(r.error);
    c.playerId = r.data.playerId;
    c.token = r.data.reconnectToken;
    players.push(c);
  }
  await tick();
  return {
    code,
    receiver,
    players,
    closeAll() {
      receiver.close();
      for (const p of players) p.close();
    },
  };
}
