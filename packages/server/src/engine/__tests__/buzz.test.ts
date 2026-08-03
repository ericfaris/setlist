// The buzz race and its aftermath — the heart of the game (the socket-level
// proof lives in net/__tests__/race.test.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkInvariants,
  armNext,
  resetInvariantMemory,
  startedGame,
} from './harness.js';

beforeEach(resetInvariantMemory);

const HOST_CANT_BUZZ = "The host doesn't buzz on this one.";

describe('buzz race', () => {
  it('only the first buzz the engine processes wins the lock', () => {
    const { engine, seats, bank } = startedGame(11, 4);
    expect(armNext(engine, seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('ARMED');

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
    armNext(engine, seats[0]!.id);
    clock.advance(4321);
    engine.buzz(seats[1]!.id);
    expect(engine.room.active!.lockedAt).toBe(clock.now());
  });

  it('rejects a buzz outside ARMED', () => {
    const { engine, seats } = startedGame(13, 2);
    // ROUND_SETUP: the host has not armed anything, so nothing is live
    expect(engine.buzz(seats[1]!.id)).toEqual({ ok: false, error: 'Buzzers are not armed.' });
    expect(engine.canBuzz(seats[1]!.id)).toBe(false);
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
    expect(engine.room.phase).toBe('REVEAL');
    expect(engine.buzz(seats[1]!.id).ok).toBe(false);
  });

  it('the host cannot buzz on the round they armed', () => {
    const { engine, seats, bank } = startedGame(131, 3);
    armNext(engine, seats[0]!.id);
    expect(engine.canBuzz(seats[0]!.id)).toBe(false);
    expect(engine.buzz(seats[0]!.id)).toEqual({ ok: false, error: HOST_CANT_BUZZ });
    expect(engine.room.phase).toBe('ARMED');
    expect(engine.canBuzz(seats[1]!.id)).toBe(true);
    checkInvariants(engine, bank);
  });

  it('a demoted ex-host stays excluded from the round they armed', () => {
    const { engine, seats, bank } = startedGame(132, 3);
    armNext(engine, seats[0]!.id);
    expect(engine.transferHost(seats[0]!.id, seats[1]!.id)).toEqual({ ok: true });
    // the ex-host is a plain player again — but they picked this song
    expect(engine.room.players.find((p) => p.id === seats[0]!.id)!.isHost).toBe(false);
    expect(engine.canBuzz(seats[0]!.id)).toBe(false);
    expect(engine.buzz(seats[0]!.id)).toEqual({ ok: false, error: HOST_CANT_BUZZ });
    // and the inherited host loses their own buzz, by the same rule
    expect(engine.canBuzz(seats[1]!.id)).toBe(false);
    expect(engine.buzz(seats[1]!.id)).toEqual({ ok: false, error: HOST_CANT_BUZZ });
    expect(engine.buzz(seats[2]!.id)).toEqual({ ok: true });
    checkInvariants(engine, bank);
  });

  it('re-arms the other players after a wrong judgement but not the loser', () => {
    const { engine, seats, bank } = startedGame(14, 4);
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[1]!.id);
    expect(engine.judge(seats[0]!.id, { titleCorrect: false, artistCorrect: false })).toEqual({
      ok: true,
    });
    expect(engine.room.phase).toBe('ARMED');
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

  it('a 2-player game auto-reveals when the single eligible guest answers wrong', () => {
    const { engine, seats, bank } = startedGame(16, 2);
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: false, artistCorrect: false });
    // the host is not in the pool, so there is nobody left — reveal, don't hang
    expect(engine.room.phase).toBe('REVEAL');
    expect(engine.room.active!.revealed).toBe(true);
    checkInvariants(engine, bank);
  });

  it('the host can reveal from ARMED with nobody buzzed', () => {
    const { engine, seats, bank } = startedGame(17, 2);
    armNext(engine, seats[0]!.id);
    expect(engine.revealQuestion(seats[1]!.id)).toEqual({
      ok: false,
      error: 'Only the host can reveal the answer.',
    });
    expect(engine.revealQuestion(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('REVEAL');
    expect(engine.room.active!.revealed).toBe(true);
    expect(engine.room.active!.lockedPlayerId).toBeNull();
    // and a second reveal is a no-op error, not a state change
    expect(engine.revealQuestion(seats[0]!.id)).toEqual({ ok: false, error: 'No song in play.' });
    checkInvariants(engine, bank);
  });

  it('refuses a buzz from a mid-game joiner until the next question', () => {
    const { engine, seats, bank } = startedGame(18, 2);
    armNext(engine, seats[0]!.id);
    const late = engine.join({ displayName: 'Latecomer' });
    expect(late.ok).toBe(true);
    if (!late.ok) return;
    expect(late.player.pendingJoin).toBe(true);
    expect(engine.buzz(late.player.id)).toEqual({
      ok: false,
      error: 'You join in on the next question.',
    });
    engine.revealQuestion(seats[0]!.id);
    engine.nextQuestion(seats[0]!.id);
    expect(engine.room.players.every((p) => !p.pendingJoin)).toBe(true);
    checkInvariants(engine, bank);
  });

  it('drops a disconnected player from the buzz pool without pausing', () => {
    const { engine, seats } = startedGame(19, 4);
    armNext(engine, seats[0]!.id);
    expect(engine.disconnect(seats[2]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('ARMED'); // non-host drop does not pause
    expect(engine.canBuzz(seats[2]!.id)).toBe(false);
    expect(engine.buzz(seats[1]!.id)).toEqual({ ok: true });
  });

  it('a 2-player host drop mid-round auto-reveals instead of deadlocking', () => {
    // The crown moves to the only other player, who is now the only *possible*
    // buzzer AND, as host, ineligible. eligibleBuzzers() empties and the
    // question must resolve itself rather than sit in ARMED forever.
    const { engine, seats, bank } = startedGame(20, 2);
    armNext(engine, seats[0]!.id);
    expect(engine.room.phase).toBe('ARMED');
    expect(engine.disconnect(seats[0]!.id)).toEqual({ ok: true });

    expect(engine.room.players.find((p) => p.isHost)!.id).toBe(seats[1]!.id);
    expect(engine.canBuzz(seats[1]!.id)).toBe(false);
    expect(engine.room.phase).toBe('REVEAL');
    expect(engine.room.active!.revealed).toBe(true);
    // and the new host can move the game on
    expect(engine.nextQuestion(seats[1]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('ON_DECK');
    checkInvariants(engine, bank);
  });
});
