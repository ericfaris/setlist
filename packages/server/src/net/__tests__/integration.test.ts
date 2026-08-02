// Net-layer integration: play a full question end to end over real
// WebSockets, validating the wire protocol, the projections each surface
// receives, and the ack flow.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, makeRoom, startTestServer, tick, type TestServer } from './harness.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});
afterEach(async () => {
  await server.close();
});

describe('a full question over WebSockets', () => {
  it('runs lobby -> board -> clip -> buzz -> judge -> reveal on all three surfaces', async () => {
    const { receiver, players, closeAll } = await makeRoom(server.port, 2);
    const [host, guest] = players as [Client, Client];

    expect(host.pub?.players).toHaveLength(2);
    expect(host.pub?.castConnected).toBe(true);
    expect(host.priv?.isHost).toBe(true);
    expect(guest.priv?.isHost).toBe(false);

    // start
    expect(await host.emit('game:start', {})).toEqual({ ok: true, data: {} });
    await tick();
    for (const c of [host, guest, receiver]) expect(c.pub?.phase).toBe('BOARD');
    expect(receiver.pub?.board?.categories.length).toBeGreaterThan(0);

    // a non-host cannot pick
    const stolen = await guest.emit('board:select', { categoryIndex: 0, rowIndex: 0 });
    expect(stolen).toEqual({ ok: false, error: 'Only the host can pick a square.' });

    // pick a cell
    expect(await host.emit('board:select', { categoryIndex: 0, rowIndex: 2 })).toEqual({
      ok: true,
      data: {},
    });
    await tick();
    expect(host.pub?.phase).toBe('PLAYING');
    expect(host.pub?.active?.value).toBe(300);

    // only the receiver gets playback data
    expect(receiver.priv?.receiverPlayback).not.toBeNull();
    expect(receiver.priv?.receiverPlayback?.videoId).toMatch(/^[\w-]{11}$/);
    expect(receiver.priv?.receiverPlayback?.paused).toBe(false);
    expect(host.priv?.receiverPlayback).toBeNull();
    expect(guest.priv?.receiverPlayback).toBeNull();

    // only the host gets the answer, and only they see it before the reveal
    expect(host.priv?.hostAnswer?.title).toBeTruthy();
    expect(guest.priv?.hostAnswer).toBeNull();
    expect(host.pub?.active?.answer).toBeNull();
    expect(JSON.stringify(guest.pub)).not.toContain(host.priv!.hostAnswer!.title);

    // buzz
    expect(guest.priv?.canBuzz).toBe(true);
    expect(await guest.emit('buzz:press', {})).toEqual({ ok: true, data: {} });
    await tick();
    for (const c of [host, guest, receiver]) {
      expect(c.pub?.phase).toBe('LOCKED');
      expect(c.pub?.active?.lockedPlayerId).toBe(guest.playerId);
    }
    // the music stops on the TV
    expect(receiver.priv?.receiverPlayback?.paused).toBe(true);
    expect(guest.priv?.canBuzz).toBe(false);

    // judge
    expect(await host.emit('judge:answer', { titleCorrect: true, artistCorrect: false })).toEqual({
      ok: true,
      data: {},
    });
    await tick();
    for (const c of [host, guest, receiver]) {
      expect(c.pub?.phase).toBe('REVEAL');
      expect(c.pub?.active?.revealed).toBe(true);
      expect(c.pub?.active?.answer?.title).toBe(host.priv!.hostAnswer!.title);
      expect(c.pub?.players.find((p) => p.id === guest.playerId)?.score).toBe(150);
    }
    expect(guest.priv?.score).toBe(150);

    // advance
    expect(await host.emit('question:next', {})).toEqual({ ok: true, data: {} });
    await tick();
    expect(host.pub?.phase).toBe('BOARD');
    expect(host.pub?.board?.cells.find((c) => c.categoryIndex === 0 && c.rowIndex === 2)?.used).toBe(
      true,
    );

    closeAll();
  }, 20000);

  it('never puts a videoId in the public projection', async () => {
    const { receiver, players, closeAll } = await makeRoom(server.port, 2);
    const [host, guest] = players as [Client, Client];
    await host.emit('game:start', {});
    await host.emit('board:select', { categoryIndex: 1, rowIndex: 0 });
    await tick();
    const videoId = receiver.priv!.receiverPlayback!.videoId;
    expect(JSON.stringify(host.pub)).not.toContain(videoId);
    expect(JSON.stringify(guest.pub)).not.toContain(videoId);
    expect(JSON.stringify(receiver.pub)).not.toContain(videoId);
    expect(JSON.stringify(guest.priv)).not.toContain(videoId);
    closeAll();
  }, 20000);

  it('blocks starting without a TV attached', async () => {
    const host = new Client(server.port);
    await host.connected();
    const created = await host.emit<{ code: string }>('host:create', { canCast: true });
    if (!created.ok) throw new Error(created.error);
    await host.emit('room:join', { code: created.data.code, displayName: 'Solo', canCast: true });
    await tick();
    expect(await host.emit('game:start', {})).toEqual({
      ok: false,
      error: 'Connect to the TV before starting.',
    });
    host.close();
  }, 20000);

  it('expires the clip on the server when nobody buzzes', async () => {
    await server.close();
    server = await startTestServer({ clipDurationSeconds: 0 });
    const { players, closeAll } = await makeRoom(server.port, 2);
    const [host] = players as [Client];
    await host.emit('game:start', {});
    await host.emit('board:select', { categoryIndex: 0, rowIndex: 0 });
    expect(host.pub?.phase).toBe('PLAYING');
    await new Promise((r) => setTimeout(r, 500));
    expect(host.pub?.phase).toBe('REVEAL');
    expect(host.pub?.active?.answer).not.toBeNull();
    closeAll();
  }, 20000);

  it('surfaces a receiver playback error to the players', async () => {
    const { receiver, players, closeAll } = await makeRoom(server.port, 2);
    const [host] = players as [Client];
    await host.emit('game:start', {});
    await host.emit('board:select', { categoryIndex: 0, rowIndex: 0 });
    receiver.socket.emit('receiver:playbackError', { message: 'Embedding disabled (150)' });
    await tick();
    expect(host.pub?.active?.playbackError).toBe('Embedding disabled (150)');
    expect(await host.emit('question:skip', {})).toEqual({ ok: true, data: {} });
    await tick();
    expect(host.pub?.phase).toBe('REVEAL');
    closeAll();
  }, 20000);

  it('transfers the host role on request and moves the controls with it', async () => {
    const { players, closeAll } = await makeRoom(server.port, 3);
    const [host, guest] = players as [Client, Client];
    expect(await host.emit('host:transfer', { playerId: guest.playerId })).toEqual({
      ok: true,
      data: {},
    });
    await tick();
    expect(guest.priv?.isHost).toBe(true);
    expect(host.priv?.isHost).toBe(false);
    expect(await host.emit('game:start', {})).toEqual({
      ok: false,
      error: 'Only the host can start the game.',
    });
    expect(await guest.emit('game:start', {})).toEqual({ ok: true, data: {} });
    closeAll();
  }, 20000);

  it('reconnects a dropped player by token and keeps their score', async () => {
    const { players, closeAll } = await makeRoom(server.port, 2);
    const [host, guest] = players as [Client, Client];
    await host.emit('game:start', {});
    await host.emit('board:select', { categoryIndex: 0, rowIndex: 4 });
    await guest.emit('buzz:press', {});
    await host.emit('judge:answer', { titleCorrect: true, artistCorrect: true });
    await tick();
    expect(guest.priv?.score).toBe(500);

    const token = guest.token;
    guest.close();
    await new Promise((r) => setTimeout(r, 150)); // past the grace window

    const rejoin = new Client(server.port);
    await rejoin.connected();
    const rr = await rejoin.emit<{ playerId: string; reconnectToken: string }>('room:join', {
      code: host.pub!.code,
      displayName: 'P1',
      reconnectToken: token,
    });
    expect(rr.ok).toBe(true);
    await tick();
    expect(rejoin.priv?.score).toBe(500);
    expect(rejoin.pub?.players.find((p) => p.id === guest.playerId)?.connected).toBe(true);
    rejoin.close();
    closeAll();
  }, 20000);
});
