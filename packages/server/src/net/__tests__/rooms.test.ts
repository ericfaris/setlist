// Room registry: multiple rooms coexist without leaking into each other, and
// the closeIfEmpty grace period protects a brand-new room mid-handshake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleQuestionBank } from '../../questions/bank.js';
import { RoomManager } from '../rooms.js';
import { armRound, makeRoom, startTestServer, tick, type TestServer } from './harness.js';

describe('two rooms at once', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it('keeps a buzz in room A out of room B', async () => {
    const a = await makeRoom(server.port, 2);
    const b = await makeRoom(server.port, 2);
    expect(a.code).not.toBe(b.code);

    for (const room of [a, b]) await armRound(room.players[0]!);
    await tick();
    await a.players[1]!.emit('buzz:press', {});
    await tick();

    expect(a.players[0]!.pub?.phase).toBe('LOCKED');
    expect(a.players[0]!.pub?.active?.lockedPlayerId).toBe(a.players[1]!.playerId);
    expect(b.players[0]!.pub?.phase).toBe('ARMED');
    expect(b.players[0]!.pub?.active?.lockedPlayerId).toBeNull();
    expect(b.players[1]!.priv?.canBuzz).toBe(true);

    // scores stay separate too
    await a.players[0]!.emit('judge:answer', { titleCorrect: true, artistCorrect: true });
    await tick();
    expect(b.players[0]!.pub?.players.every((p) => p.score === 0)).toBe(true);

    a.closeAll();
    b.closeAll();
  }, 20000);
});

describe('RoomManager.closeIfEmpty', () => {
  const makeManager = () => new RoomManager(sampleQuestionBank());

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('protects a brand-new empty room (grace period)', () => {
    const rooms = makeManager();
    const { engine } = rooms.create();
    expect(rooms.closeIfEmpty(engine.room.code)).toBe(false);
    expect(rooms.has(engine.room.code)).toBe(true);
  });

  it('closes an empty room once the grace period elapses', () => {
    const rooms = makeManager();
    const { engine } = rooms.create();
    vi.advanceTimersByTime(61_000);
    expect(rooms.closeIfEmpty(engine.room.code)).toBe(true);
    expect(rooms.has(engine.room.code)).toBe(false);
  });

  it('never closes a room with a connected player', () => {
    const rooms = makeManager();
    const runtime = rooms.create();
    expect(runtime.engine.join({ displayName: 'Eric' }).ok).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(rooms.closeIfEmpty(runtime.engine.room.code)).toBe(false);
  });

  it('never closes a room with an attached receiver', () => {
    const rooms = makeManager();
    const runtime = rooms.create();
    runtime.receivers.add('socket-1');
    vi.advanceTimersByTime(61_000);
    expect(rooms.closeIfEmpty(runtime.engine.room.code)).toBe(false);
  });

  it('generates distinct 4-digit codes', () => {
    const rooms = makeManager();
    const codes = Array.from({ length: 50 }, () => rooms.create().engine.room.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^\d{4}$/);
  });
});
