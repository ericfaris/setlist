// Phase transitions, LOBBY through GAME_OVER.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addPlayers,
  checkInvariants,
  firstUnusedSongId,
  makeBank,
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

  it('walks LOBBY -> SETLIST -> ARMED -> LOCKED -> REVEAL -> SETLIST', () => {
    const { engine, seats, bank } = startedGame(201, 2);
    expect(engine.room.phase).toBe('SETLIST');
    checkInvariants(engine, bank);
    expect(engine.startSong(seats[0]!.id, firstUnusedSongId(engine))).toEqual({ ok: true });
    expect(engine.room.phase).toBe('ARMED');
    checkInvariants(engine, bank);
    engine.buzz(seats[1]!.id);
    expect(engine.room.phase).toBe('LOCKED');
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
    expect(engine.room.phase).toBe('REVEAL');
    expect(engine.nextQuestion(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('SETLIST');
    expect(engine.room.active).toBeNull();
    checkInvariants(engine, bank);
  });

  it('only the host may arm a song, and only from SETLIST', () => {
    const { engine, seats } = startedGame(2011, 2);
    expect(engine.startSong(seats[1]!.id, firstUnusedSongId(engine))).toEqual({
      ok: false,
      error: 'Only the host can start a song.',
    });
    engine.startSong(seats[0]!.id, firstUnusedSongId(engine));
    expect(engine.startSong(seats[0]!.id, firstUnusedSongId(engine))).toEqual({
      ok: false,
      error: 'Not choosing a song right now.',
    });
  });

  it('ends the game exactly when the last song is used', () => {
    const bank = makeBank(2, 2);
    const { engine, seats } = startedGame(203, 2, { bank });
    const total = engine.room.setlist!.songs.length;
    expect(total).toBe(4);

    for (let i = 0; i < total; i++) {
      expect(engine.room.phase, `before song ${i}`).toBe('SETLIST');
      expect(engine.startSong(seats[0]!.id, firstUnusedSongId(engine))).toEqual({ ok: true });
      engine.buzz(seats[1]!.id);
      engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
      expect(engine.room.phase).toBe('REVEAL');
      engine.nextQuestion(seats[0]!.id);
      checkInvariants(engine, bank);
      if (i < total - 1) expect(engine.room.phase).toBe('SETLIST');
    }
    expect(engine.room.phase).toBe('GAME_OVER');
    expect(engine.room.winnerPlayerIds).toEqual([seats[1]!.id]);
  });

  it('reports every tied player as a winner', () => {
    const { engine, seats } = startedGame(204, 3);
    // give P1 and P2 the same score, leave the host at 0
    engine.startSong(seats[0]!.id, firstUnusedSongId(engine));
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: false });
    engine.nextQuestion(seats[0]!.id);
    engine.startSong(seats[0]!.id, firstUnusedSongId(engine));
    engine.buzz(seats[2]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: false, artistCorrect: true });
    engine.nextQuestion(seats[0]!.id);
    expect(engine.room.players.map((p) => p.score)).toEqual([0, 50, 50]);

    expect(engine.forceEnd(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('GAME_OVER');
    expect(new Set(engine.room.winnerPlayerIds)).toEqual(new Set([seats[1]!.id, seats[2]!.id]));
  });

  it('rematch resets scores and rebuilds a fresh setlist', () => {
    const { engine, seats } = startedGame(205, 2);
    engine.startSong(seats[0]!.id, firstUnusedSongId(engine));
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
    engine.forceEnd(seats[0]!.id);

    expect(engine.rematch(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('LOBBY');
    expect(engine.room.setlist).toBeNull();
    expect(engine.room.players.every((p) => p.score === 0)).toBe(true);
    expect(engine.start(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.setlist!.songs.every((s) => !s.used)).toBe(true);
  });

  it('pauses when the cast drops mid-round and resumes back into ARMED', () => {
    const { engine, seats } = startedGame(208, 2);
    engine.startSong(seats[0]!.id, firstUnusedSongId(engine));
    engine.setCastConnected(false);
    expect(engine.room.phase).toBe('PAUSED');
    expect(engine.room.pause).toEqual({
      active: true,
      reason: 'CAST_DROPPED',
      waitingForPlayerId: seats[0]!.id,
    });
    engine.setCastConnected(true);
    expect(engine.room.phase).toBe('ARMED');
    expect(engine.room.pause.active).toBe(false);
  });

  it('a pause while browsing restores SETLIST', () => {
    const { engine } = startedGame(2081, 2);
    engine.setCastConnected(false);
    expect(engine.room.phase).toBe('PAUSED');
    engine.setCastConnected(true);
    expect(engine.room.phase).toBe('SETLIST');
  });
});
