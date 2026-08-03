// Phase transitions, LOBBY through GAME_OVER.
import { beforeEach, describe, expect, it } from 'vitest';
import { BOARD_COLUMNS, BOARD_ROWS } from '@setlist/shared';
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
    // substitution is opt-in from the net layer: reporting alone changes nothing
    expect(engine.room.active!.retrying).toBe(false);
    expect(engine.room.active!.retryAttempts).toBe(0);
    expect(engine.room.active!.substituteVideoId).toBeNull();
    // the host's escape hatch still works
    expect(engine.skipQuestion(seats[0]!.id)).toEqual({ ok: true });
  });

  it('runs a substitution: begin -> resolve -> play, capped at three attempts, then auto-reveals', () => {
    const { engine, seats } = startedGame(2071, 2);
    engine.selectCell(seats[0]!.id, 0, 0);
    const active = engine.room.active!;
    const originalVideoId = active.question.videoId;
    const tokenBefore = active.playToken;

    expect(engine.reportPlaybackError('Embedding disabled (150)')).toEqual({ ok: true });
    const begun = engine.beginRetry();
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error('unreachable');
    expect(begun.needSearch).toBe(true);
    expect(begun.excludeVideoIds).toEqual([originalVideoId]);
    expect(begun.title).toBe(active.question.title);
    // retrying hides the error banner and cools the buzzers
    expect(active.retrying).toBe(true);
    expect(active.playbackError).toBeNull();
    expect(engine.canBuzz(seats[1]!.id)).toBe(false);
    expect(engine.buzz(seats[1]!.id)).toEqual({ ok: false, error: 'Finding another version…' });
    checkInvariants(engine);

    expect(
      engine.resolveRetrySearch(begun.retryId, ['sub1aaaaaaa', 'sub2bbbbbbb', 'sub3ccccccc']),
    ).toEqual({ ok: true });
    expect(engine.playSubstitute()).toEqual({ ok: true });
    expect(active.substituteVideoId).toBe('sub1aaaaaaa');
    expect(active.retryAttempts).toBe(1);
    expect(active.retrying).toBe(false);
    expect(active.playToken).toBe(tokenBefore + 1);
    expect(engine.canBuzz(seats[1]!.id)).toBe(true);
    checkInvariants(engine);

    // attempt 2 needs no search
    expect(engine.reportPlaybackError('Embedding disabled (150)')).toEqual({ ok: true });
    const second = engine.beginRetry();
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.needSearch).toBe(false);
    expect(second.excludeVideoIds).toEqual([originalVideoId, 'sub1aaaaaaa']);
    expect(engine.playSubstitute()).toEqual({ ok: true });
    expect(active.substituteVideoId).toBe('sub2bbbbbbb');
    expect(active.retryAttempts).toBe(2);

    // attempt 3 needs no search either
    expect(engine.reportPlaybackError('Embedding disabled (150)')).toEqual({ ok: true });
    const third = engine.beginRetry();
    expect(third.ok).toBe(true);
    if (!third.ok) throw new Error('unreachable');
    expect(third.needSearch).toBe(false);
    expect(third.excludeVideoIds).toEqual([originalVideoId, 'sub2bbbbbbb']);
    expect(engine.playSubstitute()).toEqual({ ok: true });
    expect(active.substituteVideoId).toBe('sub3ccccccc');
    expect(active.retryAttempts).toBe(3);

    // the cap: no fourth attempt, ever
    expect(engine.reportPlaybackError('Embedding disabled (150)')).toEqual({ ok: true });
    expect(engine.beginRetry()).toEqual({ ok: false, error: 'Out of substitution attempts.' });
    expect(engine.exhaustRetries()).toEqual({ ok: true });
    expect(active.retrying).toBe(false);
    expect(active.playbackError).toBe('Embedding disabled (150)');
    // every alternate also failed to play -> auto-reveal, no host action needed
    expect(engine.room.phase).toBe('REVEAL');
    expect(active.revealed).toBe(true);
    checkInvariants(engine);
  });

  it('ignores a stale retry and refuses to substitute once the host has skipped', () => {
    const { engine, seats } = startedGame(2072, 2);
    engine.selectCell(seats[0]!.id, 0, 0);
    engine.reportPlaybackError('Embedding disabled (150)');
    const begun = engine.beginRetry();
    if (!begun.ok) throw new Error('unreachable');

    // a search that resolves against a different retryId is a no-op
    expect(engine.resolveRetrySearch('r_bogus', ['nope0000000'])).toEqual({
      ok: false,
      error: 'Stale retry.',
    });
    expect(engine.room.active!.retryCandidates).toEqual([]);

    // skipQuestion reveals WITHOUT nulling active, so the phase guard is what
    // stops a late search from restarting playback on a revealed question.
    expect(engine.skipQuestion(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.active!.retrying).toBe(false);
    expect(engine.resolveRetrySearch(begun.retryId, ['late0000000'])).toEqual({ ok: true });
    expect(engine.playSubstitute()).toEqual({ ok: false, error: 'Not playing.' });
    expect(engine.room.phase).toBe('REVEAL');
    expect(engine.room.active!.substituteVideoId).toBeNull();
  });

  it('rejects a duplicate or superseded playback error report', () => {
    const { engine, seats } = startedGame(2073, 2);
    engine.selectCell(seats[0]!.id, 0, 0);
    const active = engine.room.active!;

    // an error for a playToken older than the current one is a late onError
    expect(engine.reportPlaybackError('boom', active.playToken - 1)).toEqual({
      ok: false,
      error: 'Stale playback error.',
    });
    expect(active.playbackError).toBeNull();

    expect(engine.reportPlaybackError('boom', active.playToken)).toEqual({ ok: true });
    engine.beginRetry();
    // YouTube fires onError twice for one load — the second is dropped
    expect(engine.reportPlaybackError('boom')).toEqual({ ok: false, error: 'Already retrying.' });
  });

  it('clears the retry indicator when the clip expires mid-search', () => {
    const { engine, seats, clock } = startedGame(2074, 2);
    engine.selectCell(seats[0]!.id, 0, 0);
    engine.reportPlaybackError('Embedding disabled (150)');
    engine.beginRetry();
    expect(engine.room.active!.retrying).toBe(true);
    clock.advance(60_000);
    expect(engine.clipExpired()).toEqual({ ok: true });
    // a REVEAL screen must never render "finding another version…"
    expect(engine.room.active!.retrying).toBe(false);
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
