// Board layout from the question bank.
import { beforeEach, describe, expect, it } from 'vitest';
import { BOARD_COLUMNS, BOARD_ROWS, POINT_VALUES } from '@music-trivia/shared';
import type { GameEngine } from '../engine.js';
import {
  addPlayers,
  checkInvariants,
  makeBank,
  makeEngine,
  resetInvariantMemory,
  startedGame,
} from './harness.js';

beforeEach(resetInvariantMemory);

/**
 * Cell ids are positional and opaque by design, so the only way to observe
 * which songs the RNG actually laid out is to play the board and read the
 * answers back off the (server-side) active question.
 */
function boardSignature(engine: GameEngine, hostId: string): string {
  const ids: string[] = [];
  for (const cell of [...engine.room.board!.cells]) {
    engine.selectCell(hostId, cell.categoryIndex, cell.rowIndex);
    ids.push(engine.room.active!.question.videoId);
    engine.clipExpired();
    engine.nextQuestion(hostId);
  }
  return ids.join('|');
}

describe('board layout', () => {
  it('builds 5x5 from the 6x6 sample bank', () => {
    const { engine, bank } = startedGame(300, 1);
    const board = engine.room.board!;
    expect(board.categories).toHaveLength(BOARD_COLUMNS);
    expect(board.cells).toHaveLength(BOARD_ROWS * BOARD_COLUMNS);
    for (const cell of board.cells) {
      expect(cell.value).toBe(POINT_VALUES[cell.rowIndex]);
      expect(cell.used).toBe(false);
    }
    // no duplicate cells and no duplicate questions within a column
    const keys = board.cells.map((c) => `${c.categoryIndex}:${c.rowIndex}`);
    expect(new Set(keys).size).toBe(keys.length);
    checkInvariants(engine, bank);
  });

  it('builds a narrower board when the bank has fewer categories', () => {
    const bank = makeBank(3, 6);
    const { engine } = startedGame(301, 1, { bank });
    expect(engine.room.board!.categories).toHaveLength(3);
    expect(engine.room.board!.cells).toHaveLength(3 * BOARD_ROWS);
  });

  it('excludes a category that has fewer than BOARD_ROWS questions', () => {
    const bank = makeBank(4, [6, 4, 6, 6]);
    const { engine } = startedGame(302, 1, { bank });
    const titles = engine.room.board!.categories.map((c) => c.title);
    expect(titles).toHaveLength(3);
    expect(titles).not.toContain('Category 1');
  });

  it('refuses to start when no category has enough songs', () => {
    const bank = makeBank(3, 2);
    const { engine } = makeEngine(303, { bank });
    const seats = addPlayers(engine, 1);
    expect(engine.start(seats[0]!.id)).toEqual({
      ok: false,
      error: 'The question bank has no category with enough songs.',
    });
    expect(engine.room.phase).toBe('LOBBY');
  });

  it('is reproducible for a given seed and differs across seeds', () => {
    const a = startedGame(304, 1);
    const b = startedGame(304, 1);
    const c = startedGame(999, 1);
    const sigA = boardSignature(a.engine, a.seats[0]!.id);
    const sigB = boardSignature(b.engine, b.seats[0]!.id);
    const sigC = boardSignature(c.engine, c.seats[0]!.id);
    expect(sigA).toBe(sigB);
    expect(sigA).not.toBe(sigC);
  });

  it('gives every cell a unique, opaque question id that leaks no song data', () => {
    const { engine, bank } = startedGame(305, 1);
    const ids = engine.room.board!.cells.map((c) => c.questionId);
    expect(new Set(ids).size).toBe(ids.length);
    const allVideoIds = bank.categories.flatMap((c) => c.questions.map((q) => q.videoId));
    for (const id of ids) {
      expect(id).toMatch(/^c\d+r\d+$/);
      for (const vid of allVideoIds) expect(id).not.toContain(vid);
    }
  });

  it('ignores extra categories beyond BOARD_COLUMNS', () => {
    const bank = makeBank(9, 6);
    const { engine } = startedGame(306, 1, { bank });
    expect(engine.room.board!.categories).toHaveLength(BOARD_COLUMNS);
  });
});
