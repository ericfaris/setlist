// Scoring: title = half the cell value, artist = the other half, both wrong =
// minus half (when penalties are on). Exercised across the whole ladder.
import { beforeEach, describe, expect, it } from 'vitest';
import { POINT_VALUES } from '@setlist/shared';
import { checkInvariants, resetInvariantMemory, startedGame } from './harness.js';

beforeEach(resetInvariantMemory);

describe('scoring', () => {
  it('awards half for title, half for artist, full for both, at every value', () => {
    for (const [rowIndex, value] of POINT_VALUES.entries()) {
      const cases = [
        { verdict: { titleCorrect: true, artistCorrect: true }, expected: value },
        { verdict: { titleCorrect: true, artistCorrect: false }, expected: value / 2 },
        { verdict: { titleCorrect: false, artistCorrect: true }, expected: value / 2 },
        { verdict: { titleCorrect: false, artistCorrect: false }, expected: -value / 2 },
      ];
      for (const c of cases) {
        const { engine, seats, bank } = startedGame(100 + rowIndex, 2);
        engine.selectCell(seats[0]!.id, 0, rowIndex);
        engine.buzz(seats[1]!.id);
        expect(engine.judge(seats[0]!.id, c.verdict)).toEqual({ ok: true });
        const buzzer = engine.room.players.find((p) => p.id === seats[1]!.id)!;
        expect(buzzer.score, `row ${rowIndex} ${JSON.stringify(c.verdict)}`).toBe(c.expected);
        expect(engine.room.active!.cell.value).toBe(value);
        checkInvariants(engine, bank);
      }
    }
  });

  it('records the verdict and the delta on the active question when correct', () => {
    const { engine, seats } = startedGame(101, 2);
    engine.selectCell(seats[0]!.id, 0, 3); // 400
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: false });
    expect(engine.room.active!.awarded).toBe(200);
    expect(engine.room.active!.verdict).toEqual({ titleCorrect: true, artistCorrect: false });
    expect(engine.room.active!.revealed).toBe(true);
  });

  it('applies no penalty when penalizeWrongAnswers is off', () => {
    const { engine, seats, bank } = startedGame(102, 2);
    // settings can only change in the lobby, so rewind via rematch
    engine.rematch(seats[0]!.id);
    expect(engine.updateSettings(seats[0]!.id, { penalizeWrongAnswers: false })).toEqual({
      ok: true,
    });
    engine.start(seats[0]!.id);
    engine.selectCell(seats[0]!.id, 0, 4); // 500
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: false, artistCorrect: false });
    expect(engine.room.players.find((p) => p.id === seats[1]!.id)!.score).toBe(0);
    checkInvariants(engine, bank);
  });

  it('permits negative scores', () => {
    const { engine, seats } = startedGame(103, 2);
    engine.selectCell(seats[0]!.id, 0, 4); // 500 -> -250
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: false, artistCorrect: false });
    expect(engine.room.players.find((p) => p.id === seats[1]!.id)!.score).toBe(-250);
  });

  it('only the buzzer is scored', () => {
    const { engine, seats } = startedGame(104, 3);
    engine.selectCell(seats[0]!.id, 1, 2); // 300
    engine.buzz(seats[2]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
    const scores = engine.room.players.map((p) => p.score);
    expect(scores).toEqual([0, 0, 300]);
  });

  it('a skipped question scores nobody', () => {
    const { engine, seats, bank } = startedGame(105, 2);
    engine.selectCell(seats[0]!.id, 0, 0);
    engine.buzz(seats[1]!.id);
    expect(engine.skipQuestion(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('REVEAL');
    expect(engine.room.players.every((p) => p.score === 0)).toBe(true);
    checkInvariants(engine, bank);
  });

  it('accumulates across questions', () => {
    const { engine, seats } = startedGame(106, 2);
    engine.selectCell(seats[0]!.id, 0, 0); // 100
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
    engine.nextQuestion(seats[0]!.id);
    engine.selectCell(seats[0]!.id, 1, 1); // 200
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: false, artistCorrect: true });
    expect(engine.room.players.find((p) => p.id === seats[1]!.id)!.score).toBe(200);
  });
});
