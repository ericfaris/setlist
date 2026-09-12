// Scoring: a flat SONG_POINT_VALUE per song — title = half, artist = the other
// half, both wrong = minus half (when penalties are on).
import { beforeEach, describe, expect, it } from 'vitest';
import { SONG_POINT_VALUE } from '@setlist/shared';
import {
  checkInvariants,
  armNext,
  playAndAdvance,
  resetInvariantMemory,
  startedGame,
} from './harness.js';

beforeEach(resetInvariantMemory);

const HALF = SONG_POINT_VALUE / 2;

describe('scoring', () => {
  it.each([
    [{ titleCorrect: true, artistCorrect: true }, SONG_POINT_VALUE],
    [{ titleCorrect: true, artistCorrect: false }, HALF],
    [{ titleCorrect: false, artistCorrect: true }, HALF],
    [{ titleCorrect: false, artistCorrect: false }, -HALF],
  ])('scores %o as %i — one flat value, every song', (verdict, expected) => {
    const { engine, seats, bank } = startedGame(100, 3);
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[1]!.id);
    expect(engine.judge(seats[0]!.id, verdict)).toEqual({ ok: true });
    expect(engine.room.players.find((p) => p.id === seats[1]!.id)!.score).toBe(expected);
    checkInvariants(engine, bank);
  });

  it('records the verdict and the delta on the active question when correct', () => {
    const { engine, seats } = startedGame(101, 2);
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: false });
    expect(engine.room.active!.awarded).toBe(HALF);
    expect(engine.room.active!.verdict).toEqual({ titleCorrect: true, artistCorrect: false });
    expect(engine.room.active!.revealed).toBe(true);
  });

  it('applies no penalty when penalizeWrongAnswers is off', () => {
    const { engine, seats, bank } = startedGame(102, 3);
    // settings can only change in the lobby, so rewind via rematch
    engine.rematch(seats[0]!.id);
    expect(engine.updateSettings(seats[0]!.id, { penalizeWrongAnswers: false })).toEqual({
      ok: true,
    });
    engine.start(seats[0]!.id);
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: false, artistCorrect: false });
    expect(engine.room.players.find((p) => p.id === seats[1]!.id)!.score).toBe(0);
    checkInvariants(engine, bank);
  });

  it('permits negative scores', () => {
    const { engine, seats } = startedGame(103, 3);
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: false, artistCorrect: false });
    expect(engine.room.players.find((p) => p.id === seats[1]!.id)!.score).toBe(-HALF);
  });

  it('only the buzzer is scored, and never the host', () => {
    const { engine, seats } = startedGame(104, 3);
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[2]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
    expect(engine.room.players.map((p) => p.score)).toEqual([0, 0, SONG_POINT_VALUE]);
  });

  it('a revealed question scores nobody', () => {
    const { engine, seats, bank } = startedGame(105, 2);
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[1]!.id);
    expect(engine.revealQuestion(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('REVEAL');
    expect(engine.room.players.every((p) => p.score === 0)).toBe(true);
    checkInvariants(engine, bank);
  });

  it('accumulates across questions', () => {
    const { engine, seats } = startedGame(106, 2);
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
    engine.nextQuestion(seats[0]!.id);
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: false, artistCorrect: true });
    expect(engine.room.players.find((p) => p.id === seats[1]!.id)!.score).toBe(
      SONG_POINT_VALUE + HALF,
    );
  });

  // Powers the TV's "on fire" flame ring + toast (see ON_FIRE_STREAK).
  it('tracks a consecutive-correct streak per player, any miss resetting it to 0', () => {
    const { engine, seats } = startedGame(107, 2);
    const streak = () => engine.room.players.find((p) => p.id === seats[1]!.id)!.streak;

    playAndAdvance(engine, seats[0]!.id, seats[1]!.id, { titleCorrect: true, artistCorrect: true });
    expect(streak()).toBe(1);
    // Partial credit (title-only/artist-only) still counts as "correct" for
    // the streak, same as it does for scoring.
    playAndAdvance(engine, seats[0]!.id, seats[1]!.id, { titleCorrect: true, artistCorrect: false });
    expect(streak()).toBe(2);
    playAndAdvance(engine, seats[0]!.id, seats[1]!.id, { titleCorrect: true, artistCorrect: true });
    expect(streak()).toBe(3);
    playAndAdvance(engine, seats[0]!.id, seats[1]!.id, { titleCorrect: false, artistCorrect: false });
    expect(streak()).toBe(0);
  });

  it('resets every streak on rematch, same as score', () => {
    const { engine, seats } = startedGame(108, 2);
    playAndAdvance(engine, seats[0]!.id, seats[1]!.id, { titleCorrect: true, artistCorrect: true });
    expect(engine.room.players.find((p) => p.id === seats[1]!.id)!.streak).toBe(1);
    expect(engine.rematch(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.players.every((p) => p.streak === 0)).toBe(true);
  });
});
