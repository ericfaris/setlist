// Phase transitions, LOBBY through GAME_OVER.
import { beforeEach, describe, expect, it } from 'vitest';
import { BOARD_COLUMNS, BOARD_ROWS } from '@music-trivia/shared';
import {
  addPlayers,
  checkInvariants,
  makeEngine,
  resetInvariantMemory,
  startedGame,
} from './harness.js';

beforeEach(resetInvariantMemory);

describe('game flow', () => {
  it('refuses to start without a TV connected', () => {
    const { engine } = makeEngine(200);
    engine.setCastConnected(false);
    const seats = addPlayers(engine, 2);
    expect(engine.start(seats[0]!.id)).toEqual({
      ok: false,
      error: 'Connect to the TV before starting.',
    });
    expect(engine.room.phase).toBe('LOBBY');
  });

  it('walks LOBBY -> BOARD -> PLAYING -> LOCKED -> REVEAL -> BOARD', () => {
    const { engine, seats, bank } = startedGame(201, 2);
    expect(engine.room.phase).toBe('BOARD');
    engine.selectCell(seats[0]!.id, 0, 0);
    expect(engine.room.phase).toBe('PLAYING');
    engine.buzz(seats[1]!.id);
    expect(engine.room.phase).toBe('LOCKED');
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
    expect(engine.room.phase).toBe('REVEAL');
    expect(engine.nextQuestion(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('BOARD');
    expect(engine.room.active).toBeNull();
    checkInvariants(engine, bank);
  });

  it('refuses to replay a used cell', () => {
    const { engine, seats } = startedGame(202, 2);
    engine.selectCell(seats[0]!.id, 2, 2);
    engine.clipExpired();
    engine.nextQuestion(seats[0]!.id);
    expect(engine.selectCell(seats[0]!.id, 2, 2)).toEqual({
      ok: false,
      error: 'That square has already been played.',
    });
  });

  it('ends the game exactly when the last cell resolves', () => {
    const { engine, seats, bank } = startedGame(203, 2);
    const total = BOARD_ROWS * BOARD_COLUMNS;
    expect(engine.room.board!.cells).toHaveLength(total);

    let resolved = 0;
    for (let c = 0; c < BOARD_COLUMNS; c++) {
      for (let r = 0; r < BOARD_ROWS; r++) {
        expect(engine.room.phase, `before cell ${c},${r}`).toBe('BOARD');
        expect(engine.selectCell(seats[0]!.id, c, r)).toEqual({ ok: true });
        engine.buzz(seats[1]!.id);
        engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
        expect(engine.room.phase).toBe('REVEAL');
        resolved++;
        engine.nextQuestion(seats[0]!.id);
        checkInvariants(engine, bank);
        if (resolved < total) expect(engine.room.phase).toBe('BOARD');
      }
    }
    expect(engine.room.phase).toBe('GAME_OVER');
    expect(engine.room.winnerPlayerIds).toEqual([seats[1]!.id]);
  });

  it('reports every tied player as a winner', () => {
    const { engine, seats } = startedGame(204, 3);
    // give P1 and P2 the same score, leave the host at 0
    engine.selectCell(seats[0]!.id, 0, 0);
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
    engine.nextQuestion(seats[0]!.id);
    engine.selectCell(seats[0]!.id, 0, 1);
    engine.buzz(seats[2]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: false });
    engine.nextQuestion(seats[0]!.id);
    expect(engine.room.players.map((p) => p.score)).toEqual([0, 100, 100]);

    expect(engine.forceEnd(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('GAME_OVER');
    expect(new Set(engine.room.winnerPlayerIds)).toEqual(new Set([seats[1]!.id, seats[2]!.id]));
  });

  it('rematch resets scores and lays out a fresh board', () => {
    const { engine, seats } = startedGame(205, 2);
    engine.selectCell(seats[0]!.id, 0, 0);
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
    engine.forceEnd(seats[0]!.id);

    expect(engine.rematch(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('LOBBY');
    expect(engine.room.board).toBeNull();
    expect(engine.room.players.every((p) => p.score === 0)).toBe(true);
    expect(engine.start(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.board!.cells.every((c) => !c.used)).toBe(true);
  });

  it('replay bumps the play token only while the clip is playing', () => {
    const { engine, seats } = startedGame(206, 2);
    engine.selectCell(seats[0]!.id, 0, 0);
    const before = engine.room.active!.playToken;
    expect(engine.replayClip(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.active!.playToken).toBe(before + 1);
    engine.buzz(seats[1]!.id);
    expect(engine.replayClip(seats[0]!.id)).toEqual({
      ok: false,
      error: 'The clip is not playing.',
    });
  });

  it('surfaces a receiver playback error on the active question', () => {
    const { engine, seats } = startedGame(207, 2);
    engine.selectCell(seats[0]!.id, 0, 0);
    expect(engine.reportPlaybackError('Video unavailable (150)')).toEqual({ ok: true });
    expect(engine.room.active!.playbackError).toBe('Video unavailable (150)');
    // the host's escape hatch still works
    expect(engine.skipQuestion(seats[0]!.id)).toEqual({ ok: true });
  });

  it('pauses when the cast drops mid-game and resumes when it returns', () => {
    const { engine, seats } = startedGame(208, 2);
    engine.selectCell(seats[0]!.id, 0, 0);
    engine.setCastConnected(false);
    expect(engine.room.phase).toBe('PAUSED');
    expect(engine.room.pause).toEqual({
      active: true,
      reason: 'CAST_DROPPED',
      waitingForPlayerId: seats[0]!.id,
    });
    engine.setCastConnected(true);
    expect(engine.room.phase).toBe('PLAYING');
    expect(engine.room.pause.active).toBe(false);
  });

  it('clip start is clamped so a short track does not start past its end', () => {
    const { engine, seats } = startedGame(209, 2, { clipStartSeconds: 30, clipDurationSeconds: 20 });
    engine.selectCell(seats[0]!.id, 0, 0);
    const active = engine.room.active!;
    const duration = active.question.durationSeconds;
    if (duration !== null) {
      expect(active.startSeconds).toBeLessThanOrEqual(Math.max(0, duration - 20 - 5));
    }
    expect(active.startSeconds).toBeGreaterThanOrEqual(0);
    expect(active.durationSeconds).toBe(20);
  });
});
