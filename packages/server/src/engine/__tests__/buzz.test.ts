// The buzz race and its aftermath — the heart of the game (criterion #6 at the
// engine level; the socket-level proof lives in net/__tests__/race.test.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import { checkInvariants, resetInvariantMemory, startedGame } from './harness.js';

beforeEach(resetInvariantMemory);

describe('buzz race', () => {
  it('only the first buzz the engine processes wins the lock', () => {
    const { engine, seats, bank } = startedGame(11, 3);
    expect(engine.selectCell(seats[0]!.id, 0, 0)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('PLAYING');

    const first = engine.buzz(seats[1]!.id);
    expect(first).toEqual({ ok: true });
    expect(engine.room.active!.lockedPlayerId).toBe(seats[1]!.id);
    expect(engine.room.phase).toBe('LOCKED');

    const second = engine.buzz(seats[2]!.id);
    expect(second).toEqual({ ok: false, error: 'Already locked in.' });
    // …and the loser did not displace the winner
    expect(engine.room.active!.lockedPlayerId).toBe(seats[1]!.id);
    checkInvariants(engine, bank);
  });

  it('stamps lockedAt from the server clock', () => {
    const { engine, clock, seats } = startedGame(12, 2);
    engine.selectCell(seats[0]!.id, 0, 0);
    clock.advance(4321);
    engine.buzz(seats[1]!.id);
    expect(engine.room.active!.lockedAt).toBe(clock.now());
  });

  it('rejects a buzz outside PLAYING', () => {
    const { engine, seats } = startedGame(13, 2);
    expect(engine.buzz(seats[1]!.id)).toEqual({ ok: false, error: 'Buzzers are not armed.' });
    engine.selectCell(seats[0]!.id, 0, 0);
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
    expect(engine.room.phase).toBe('REVEAL');
    expect(engine.buzz(seats[1]!.id).ok).toBe(false);
  });

  it('re-arms the other players after a wrong judgement but not the loser', () => {
    const { engine, seats, bank } = startedGame(14, 3);
    engine.selectCell(seats[0]!.id, 0, 0);
    engine.buzz(seats[1]!.id);
    expect(engine.judge(seats[0]!.id, { titleCorrect: false, artistCorrect: false })).toEqual({
      ok: true,
    });
    expect(engine.room.phase).toBe('PLAYING');
    expect(engine.room.active!.lockedOutPlayerIds).toEqual([seats[1]!.id]);
    expect(engine.canBuzz(seats[1]!.id)).toBe(false);
    expect(engine.canBuzz(seats[2]!.id)).toBe(true);
    expect(engine.buzz(seats[1]!.id)).toEqual({
      ok: false,
      error: 'You already guessed this one.',
    });
    expect(engine.buzz(seats[2]!.id)).toEqual({ ok: true });
    checkInvariants(engine, bank);
  });

  it('bumps playToken so the clip resumes after a wrong answer', () => {
    const { engine, seats } = startedGame(15, 2);
    engine.selectCell(seats[0]!.id, 0, 0);
    const tokenAtStart = engine.room.active!.playToken;
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: false, artistCorrect: false });
    expect(engine.room.active!.playToken).toBe(tokenAtStart + 1);
  });

  it('goes to REVEAL when every player has guessed wrong', () => {
    const { engine, seats, bank } = startedGame(16, 2);
    engine.selectCell(seats[0]!.id, 0, 0);
    engine.buzz(seats[0]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: false, artistCorrect: false });
    expect(engine.room.phase).toBe('PLAYING');
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: false, artistCorrect: false });
    expect(engine.room.phase).toBe('REVEAL');
    expect(engine.room.active!.revealed).toBe(true);
    checkInvariants(engine, bank);
  });

  it('goes to REVEAL when the clip runs out with nobody buzzing', () => {
    const { engine, seats } = startedGame(17, 2);
    engine.selectCell(seats[0]!.id, 0, 0);
    expect(engine.clipExpired()).toEqual({ ok: true });
    expect(engine.room.phase).toBe('REVEAL');
    expect(engine.room.active!.revealed).toBe(true);
    // and a second expiry is a no-op error, not a state change
    expect(engine.clipExpired().ok).toBe(false);
  });

  it('refuses a buzz from a mid-game joiner until the next question', () => {
    const { engine, seats, bank } = startedGame(18, 2);
    engine.selectCell(seats[0]!.id, 0, 0);
    const late = engine.join({ displayName: 'Latecomer' });
    expect(late.ok).toBe(true);
    if (!late.ok) return;
    expect(late.player.pendingJoin).toBe(true);
    expect(engine.buzz(late.player.id)).toEqual({
      ok: false,
      error: 'You join in on the next question.',
    });
    engine.clipExpired();
    engine.nextQuestion(seats[0]!.id);
    expect(engine.room.players.every((p) => !p.pendingJoin)).toBe(true);
    checkInvariants(engine, bank);
  });

  it('drops a disconnected player from the buzz pool without pausing', () => {
    const { engine, seats } = startedGame(19, 3);
    engine.selectCell(seats[0]!.id, 0, 0);
    expect(engine.disconnect(seats[2]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('PLAYING'); // non-host drop does not pause
    expect(engine.canBuzz(seats[2]!.id)).toBe(false);
    expect(engine.buzz(seats[1]!.id)).toEqual({ ok: true });
  });
});
