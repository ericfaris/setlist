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

/** Real (short) grace period so tests exercise it without burning 60s each. */
export const TEST_DISCONNECT_GRACE_MS = 60;

export interface TestServer {
  port: number;
  rooms: RoomManager;
  close(): Promise<void>;
}

export async function startTestServer(
  opts: { bank?: QuestionBank } = {},
): Promise<TestServer> {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer, { path: SOCKET_PATH });
  const rooms = new RoomManager(opts.bank ?? sampleQuestionBank());
  attachSocketServer(io as never, rooms, { disconnectGraceMs: TEST_DISCONNECT_GRACE_MS });
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

/** The id of the song on deck, off the host's own (host-only) projection. */
export function firstSongId(host: Client): string {
  const onDeck = host.priv?.hostOnDeck;
  if (!onDeck) throw new Error('no song on deck in the host projection');
  return onDeck.songId;
}

/** Pick this round's categories: the first `required` with songs left. */
export async function pickRound(host: Client): Promise<string[]> {
  const picker = host.priv?.categoryPicker;
  if (!picker) throw new Error('no category picker in the host projection');
  const categoryIds = picker.groups
    .flatMap((g) => g.categories)
    .filter((c) => c.available > 0)
    .slice(0, picker.required)
    .map((c) => c.id);
  const res = await host.emit('round:pickCategories', { categoryIds });
  if (!res.ok) throw new Error(res.error);
  await tick();
  return categoryIds;
}

/** Start the game (if it hasn't been), pick a round, and arm the on-deck song. */
export async function armRound(host: Client): Promise<string> {
  if (host.pub?.phase === 'LOBBY') {
    const started = await host.emit('game:start', {});
    if (!started.ok) throw new Error(started.error);
    await tick();
  }
  if (host.pub?.phase === 'ROUND_SETUP') await pickRound(host);
  const songId = firstSongId(host);
  const res = await host.emit('setlist:start', { songId });
  if (!res.ok) throw new Error(res.error);
  await tick();
  return songId;
}
