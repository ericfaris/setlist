// Phase transitions, LOBBY through GAME_OVER.
import { beforeEach, describe, expect, it } from 'vitest';
import { TOTAL_ROUNDS } from '@setlist/shared';
import {
  addPlayers,
  armNext,
  checkInvariants,
  makeBank,
  makeEngine,
  onDeckSongId,
  pickRound,
  playAndAdvance,
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

  it('walks LOBBY -> ROUND_SETUP -> ON_DECK -> ARMED -> LOCKED -> REVEAL -> ON_DECK', () => {
    const { engine, seats, bank } = startedGame(201, 2);
    expect(engine.room.phase).toBe('ROUND_SETUP');
    checkInvariants(engine, bank);
    pickRound(engine, seats[0]!.id);
    expect(engine.room.phase).toBe('ON_DECK');
    checkInvariants(engine, bank);
    expect(engine.startSong(seats[0]!.id, onDeckSongId(engine))).toEqual({ ok: true });
    expect(engine.room.phase).toBe('ARMED');
    checkInvariants(engine, bank);
    engine.buzz(seats[1]!.id);
    expect(engine.room.phase).toBe('LOCKED');
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
    expect(engine.room.phase).toBe('REVEAL');
    expect(engine.nextQuestion(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('ON_DECK');
    expect(engine.room.active).toBeNull();
    checkInvariants(engine, bank);
  });

  it('only the host may arm a song, and only from ON_DECK', () => {
    const { engine, seats } = startedGame(2011, 2);
    // nothing is on deck until the categories are picked
    expect(engine.startSong(seats[0]!.id, 's0q0')).toEqual({
      ok: false,
      error: 'No song is on deck.',
    });
    pickRound(engine, seats[0]!.id);
    const songId = onDeckSongId(engine);
    expect(engine.startSong(seats[1]!.id, songId)).toEqual({
      ok: false,
      error: 'Only the host can start a song.',
    });
    engine.startSong(seats[0]!.id, songId);
    expect(engine.startSong(seats[0]!.id, songId)).toEqual({
      ok: false,
      error: 'No song is on deck.',
    });
  });

  it('ends the game automatically after round 3', () => {
    // 12 categories x 10 songs: every round picks its full 5/4/3 categories.
    const bank = makeBank(12, 10);
    const { engine, seats } = startedGame(203, 2, { bank });
    const roundsSeen: number[] = [];

    for (let round = 1; round <= TOTAL_ROUNDS; round++) {
      expect(engine.room.phase, `round ${round} setup`).toBe('ROUND_SETUP');
      expect(engine.room.round!.number).toBe(round);
      pickRound(engine, seats[0]!.id);
      roundsSeen.push(engine.room.round!.queue.length);
      const songs = engine.room.round!.queue.length;
      for (let i = 0; i < songs; i++) {
        expect(engine.room.phase, `round ${round} song ${i}`).toBe('ON_DECK');
        playAndAdvance(engine, seats[0]!.id, seats[1]!.id);
        checkInvariants(engine, bank);
      }
    }

    expect(roundsSeen).toEqual([25, 20, 15]);
    // no round 4 ever appears
    expect(engine.room.phase).toBe('GAME_OVER');
    expect(engine.room.winnerPlayerIds).toEqual([seats[1]!.id]);
    expect(engine.pickCategories(seats[0]!.id, [])).toEqual({
      ok: false,
      error: 'Not picking categories right now.',
    });
  });

  it('reports every tied player as a winner', () => {
    const { engine, seats } = startedGame(204, 3);
    // give P1 and P2 the same score, leave the host at 0
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: false });
    engine.nextQuestion(seats[0]!.id);
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[2]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: false, artistCorrect: true });
    engine.nextQuestion(seats[0]!.id);
    expect(engine.room.players.map((p) => p.score)).toEqual([0, 50, 50]);

    expect(engine.forceEnd(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('GAME_OVER');
    expect(new Set(engine.room.winnerPlayerIds)).toEqual(new Set([seats[1]!.id, seats[2]!.id]));
  });

  it('rematch resets scores and rebuilds a fresh catalog', () => {
    const { engine, seats } = startedGame(205, 2);
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
    engine.forceEnd(seats[0]!.id);

    expect(engine.rematch(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('LOBBY');
    expect(engine.room.setlist).toBeNull();
    expect(engine.room.round).toBeNull();
    expect(engine.room.players.every((p) => p.score === 0)).toBe(true);
    expect(engine.start(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.setlist!.songs.every((s) => !s.used)).toBe(true);
  });

  it('pauses when the cast drops mid-round and resumes back into ARMED', () => {
    const { engine, seats } = startedGame(208, 2);
    armNext(engine, seats[0]!.id);
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

  it('a pause while picking categories restores ROUND_SETUP', () => {
    const { engine } = startedGame(2081, 2);
    expect(engine.room.phase).toBe('ROUND_SETUP');
    engine.setCastConnected(false);
    expect(engine.room.phase).toBe('PAUSED');
    expect(engine.room.phaseBeforePause).toBe('ROUND_SETUP');
    engine.setCastConnected(true);
    expect(engine.room.phase).toBe('ROUND_SETUP');
  });

  it('a pause while a song is on deck restores ON_DECK', () => {
    const { engine, seats } = startedGame(2082, 2);
    pickRound(engine, seats[0]!.id);
    expect(engine.room.phase).toBe('ON_DECK');
    engine.setCastConnected(false);
    expect(engine.room.phase).toBe('PAUSED');
    expect(engine.room.phaseBeforePause).toBe('ON_DECK');
    engine.setCastConnected(true);
    expect(engine.room.phase).toBe('ON_DECK');
  });
});
