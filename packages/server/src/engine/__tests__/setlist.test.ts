// Setlist construction from the question bank — the direct replacement for the
// old board layout.
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

describe('setlist', () => {
  it('flattens every bank category into a section and every question into a song', () => {
    const { engine, bank } = startedGame(300, 2);
    const setlist = engine.room.setlist!;
    expect(setlist.sections).toHaveLength(bank.categories.length);
    expect(setlist.sections.map((s) => s.title)).toEqual(bank.categories.map((c) => c.title));
    expect(setlist.songs).toHaveLength(
      bank.categories.reduce((n, c) => n + c.questions.length, 0),
    );
    expect(setlist.songs.every((s) => !s.used)).toBe(true);
    checkInvariants(engine, bank);
  });

  it('gives every song a unique, opaque, positional id that leaks no song data', () => {
    const { engine, bank } = startedGame(301, 2);
    const ids = engine.room.setlist!.songs.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const allVideoIds = bank.categories.flatMap((c) => c.questions.map((q) => q.videoId));
    for (const id of ids) {
      expect(id).toMatch(/^s\d+q\d+$/);
      for (const vid of allVideoIds) expect(id).not.toContain(vid);
    }
    expect(ids[0]).toBe('s0q0');
  });

  it('preserves bank order — no shuffle', () => {
    const bank = makeBank(3, 4);
    const { engine } = startedGame(302, 2, { bank });
    const order = engine.room.setlist!.songs.map((s) => s.question.title);
    const expected = bank.categories.flatMap((c) => c.questions.map((q) => q.title));
    expect(order).toEqual(expected);
    // and it is the same for a different seed: the setlist uses no RNG at all
    const other = startedGame(999, 2, { bank });
    expect(other.engine.room.setlist!.songs.map((s) => s.question.title)).toEqual(expected);
  });

  it('dedupes by videoId across sections, first section wins', () => {
    const bank = makeBank(2, 2);
    // put category 0's first song into category 1 as well
    bank.categories[1]!.questions.unshift({ ...bank.categories[0]!.questions[0]! });
    const { engine } = startedGame(303, 2, { bank });
    const songs = engine.room.setlist!.songs;
    const videoIds = songs.map((s) => s.question.videoId);
    expect(new Set(videoIds).size).toBe(videoIds.length);
    expect(songs).toHaveLength(4);
    expect(songs.filter((s) => s.question.videoId === bank.categories[0]!.questions[0]!.videoId))
      .toHaveLength(1);
    expect(songs.find((s) => s.question.videoId === bank.categories[0]!.questions[0]!.videoId)!
      .sectionIndex).toBe(0);
  });

  it('keeps small sections — there is no minimum-songs gate any more', () => {
    const bank = makeBank(4, [1, 6, 2, 3]);
    const { engine } = startedGame(304, 2, { bank });
    const setlist = engine.room.setlist!;
    expect(setlist.sections).toHaveLength(4);
    expect(setlist.songs).toHaveLength(12);
    expect(setlist.songs.filter((s) => s.sectionIndex === 0)).toHaveLength(1);
  });

  it('refuses to start when the bank has no songs at all', () => {
    const bank = makeBank(2, 0);
    const { engine } = makeEngine(305, { bank });
    const seats = addPlayers(engine, 2);
    expect(engine.start(seats[0]!.id)).toEqual({
      ok: false,
      error: 'The question bank has no songs.',
    });
    expect(engine.room.phase).toBe('LOBBY');
  });

  it('marks a song used on startSong and refuses to replay it', () => {
    const { engine, seats, bank } = startedGame(306, 2);
    const songId = firstUnusedSongId(engine);
    expect(engine.startSong(seats[0]!.id, songId)).toEqual({ ok: true });
    expect(engine.room.setlist!.songs.find((s) => s.id === songId)!.used).toBe(true);
    expect(engine.room.phase).toBe('ARMED');
    checkInvariants(engine, bank);

    engine.revealQuestion(seats[0]!.id);
    engine.nextQuestion(seats[0]!.id);
    expect(engine.startSong(seats[0]!.id, songId)).toEqual({
      ok: false,
      error: 'That song has already been played.',
    });
    expect(engine.startSong(seats[0]!.id, 'nope')).toEqual({ ok: false, error: 'No such song.' });
  });

  it('rematch clears the setlist and a fresh start unmarks every song', () => {
    const { engine, seats } = startedGame(307, 2);
    engine.startSong(seats[0]!.id, firstUnusedSongId(engine));
    engine.revealQuestion(seats[0]!.id);
    engine.forceEnd(seats[0]!.id);

    expect(engine.rematch(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.setlist).toBeNull();
    expect(engine.start(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.setlist!.songs.every((s) => !s.used)).toBe(true);
  });

  it('needs two players — the host does not buzz', () => {
    const { engine } = makeEngine(308);
    const seats = addPlayers(engine, 1);
    expect(engine.start(seats[0]!.id)).toEqual({
      ok: false,
      error: "Need at least 2 players — the host doesn't buzz.",
    });
  });
});
