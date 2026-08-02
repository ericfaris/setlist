// Acceptance criterion #6, over real sockets: several clients buzz in the same
// tick and exactly one of them wins, every time.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRoom, startTestServer, tick, type TestServer } from './harness.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});
afterEach(async () => {
  await server.close();
});

describe('buzz race over sockets', () => {
  it('resolves 4 simultaneous buzzes to exactly one winner, 50 rooms running', async () => {
    const ROUNDS = 50;
    for (let round = 0; round < ROUNDS; round++) {
      const { receiver, players, closeAll } = await makeRoom(server.port, 4);
      const host = players[0]!;
      await host.emit('game:start', {});
      await host.emit('board:select', { categoryIndex: round % 5, rowIndex: round % 5 });
      await tick();
      expect(host.pub?.phase).toBe('PLAYING');

      // All four fire without awaiting each other — the server decides.
      const acks = await Promise.all(players.map((c) => c.emit('buzz:press', {})));
      const winners = acks.filter((a) => a.ok);
      expect(winners, `round ${round}`).toHaveLength(1);
      const losers = acks.filter((a) => !a.ok);
      for (const l of losers) {
        expect(l.ok).toBe(false);
        if (!l.ok) expect(l.error).toBe('Already locked in.');
      }

      await tick();
      const winnerIndex = acks.findIndex((a) => a.ok);
      const winnerId = players[winnerIndex]!.playerId;
      // every surface agrees on who won
      for (const c of [...players, receiver]) {
        expect(c.pub?.phase).toBe('LOCKED');
        expect(c.pub?.active?.lockedPlayerId).toBe(winnerId);
      }
      // and only the winner's own private state says so
      for (const c of players) expect(c.priv?.canBuzz).toBe(false);

      closeAll();
    }
  }, 120000);

  it('a locked-out player cannot re-enter the race for the same question', async () => {
    const { players, closeAll } = await makeRoom(server.port, 3);
    const [host, a, b] = players as [(typeof players)[0], (typeof players)[0], (typeof players)[0]];
    await host.emit('game:start', {});
    await host.emit('board:select', { categoryIndex: 0, rowIndex: 0 });
    await tick();

    expect(await a.emit('buzz:press', {})).toEqual({ ok: true, data: {} });
    await host.emit('judge:answer', { titleCorrect: false, artistCorrect: false });
    await tick();
    expect(a.pub?.phase).toBe('PLAYING');
    expect(a.priv?.canBuzz).toBe(false);
    expect(b.priv?.canBuzz).toBe(true);

    const retry = await a.emit('buzz:press', {});
    expect(retry).toEqual({ ok: false, error: 'You already guessed this one.' });
    expect(await b.emit('buzz:press', {})).toEqual({ ok: true, data: {} });
    await tick();
    expect(host.pub?.active?.lockedPlayerId).toBe(b.playerId);
    closeAll();
  }, 20000);
});
