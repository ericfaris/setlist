// The catalog built from the question bank, and the three-round structure the
// game is played through. This is the direct replacement for the old
// browse-the-setlist model.
import { beforeEach, describe, expect, it } from 'vitest';
import { ROUND_CATEGORY_COUNTS, SONGS_PER_CATEGORY_PER_ROUND } from '@setlist/shared';
import { toPrivateState, toPublicRoom } from '../project.js';
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
  selectableCategoryIds,
  startedGame,
} from './harness.js';

beforeEach(resetInvariantMemory);

describe('catalog', () => {
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
    // and it is the same for a different seed: the catalog uses no RNG at all
    const other = startedGame(999, 2, { bank });
    expect(other.engine.room.setlist!.songs.map((s) => s.question.title)).toEqual(expected);
  });

  // Risk 4, first half. Under the curated taxonomy one track legitimately
  // belongs to "Rock", "90s Rock" AND "90s Grunge"; a global first-section-wins
  // dedupe would gut every category after the first.
  it('dedupes by videoId WITHIN a section only — the same track may sit in several', () => {
    const bank = makeBank(3, 2);
    const shared = bank.categories[0]!.questions[0]!;
    bank.categories[1]!.questions.unshift({ ...shared });
    bank.categories[2]!.questions.unshift({ ...shared });
    // …and a genuine intra-section duplicate, which MUST still be collapsed
    bank.categories[0]!.questions.push({ ...shared });

    const { engine } = startedGame(303, 2, { bank });
    const songs = engine.room.setlist!.songs;
    // 2 + 3 + 3 = 8 (the intra-section dupe in category 0 is dropped)
    expect(songs).toHaveLength(8);
    const copies = songs.filter((s) => s.question.videoId === shared.videoId);
    expect(copies).toHaveLength(3);
    expect(copies.map((s) => s.sectionIndex)).toEqual([0, 1, 2]);
    // ids stay unique and positional-within-section despite the dedupe
    expect(new Set(songs.map((s) => s.id)).size).toBe(songs.length);
    expect(songs.filter((s) => s.sectionIndex === 0).map((s) => s.id)).toEqual(['s0q0', 's0q1']);
  });

  // Risk 4, second half. markUsedByVideoId is what stops the same track being
  // drawn twice now that the catalog holds it more than once.
  it('marking a drawn song used marks every catalog entry with that videoId', () => {
    const bank = makeBank(3, 2);
    const shared = bank.categories[0]!.questions[0]!;
    bank.categories[1]!.questions.unshift({ ...shared });
    bank.categories[2]!.questions.unshift({ ...shared });

    const { engine, seats } = startedGame(3031, 2, { bank });
    // 3 selectable categories, so round 1 requires 3 and drains everything
    pickRound(engine, seats[0]!.id);
    // 8 catalog entries but only 6 distinct videoIds. Drawing the shared track
    // out of category 0 marks its twins in categories 1 and 2 too, so all 8
    // entries end up used while only 6 songs are actually queued.
    expect(engine.room.setlist!.songs).toHaveLength(8);
    expect(engine.room.setlist!.songs.filter((s) => s.used)).toHaveLength(8);
    // …and the shared track is queued to play exactly once
    const queueVideoIds = engine.room.round!.queue.map(
      (id) => engine.room.setlist!.songs.find((s) => s.id === id)!.question.videoId,
    );
    expect(new Set(queueVideoIds).size).toBe(queueVideoIds.length);
    expect(queueVideoIds.filter((v) => v === shared.videoId)).toHaveLength(1);
    expect(engine.room.round!.queue).toHaveLength(6);
    checkInvariants(engine, bank);
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

  it('rematch clears the catalog and the round; a fresh start unmarks every song', () => {
    const { engine, seats } = startedGame(307, 2);
    armNext(engine, seats[0]!.id);
    engine.revealQuestion(seats[0]!.id);
    engine.forceEnd(seats[0]!.id);

    expect(engine.rematch(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.setlist).toBeNull();
    expect(engine.room.round).toBeNull();
    expect(engine.start(seats[0]!.id)).toEqual({ ok: true });
    expect(engine.room.setlist!.songs.every((s) => !s.used)).toBe(true);
    expect(engine.room.round!.number).toBe(1);
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

describe('round setup', () => {
  const bigBank = () => makeBank(12, 10);

  it('starts the game in ROUND_SETUP on round 1', () => {
    const { engine, bank } = startedGame(310, 2, { bank: bigBank() });
    expect(engine.room.phase).toBe('ROUND_SETUP');
    expect(engine.room.round).toEqual({ number: 1, categories: [], queue: [], cursor: 0 });
    checkInvariants(engine, bank);
  });

  it('demands exactly 5 / 4 / 3 categories across the three rounds', () => {
    const bank = bigBank();
    const { engine, seats } = startedGame(311, 2, { bank });
    const host = seats[0]!.id;

    for (const [round, want] of ROUND_CATEGORY_COUNTS.entries()) {
      const n = round + 1;
      expect(engine.room.round!.number).toBe(n);
      const ids = selectableCategoryIds(engine);
      expect(engine.pickCategories(host, ids.slice(0, want - 1))).toEqual({
        ok: false,
        error: `Pick exactly ${want} categories.`,
      });
      expect(engine.pickCategories(host, ids.slice(0, want + 1))).toEqual({
        ok: false,
        error: `Pick exactly ${want} categories.`,
      });
      // the host's own picker projection agrees
      const priv = toPrivateState(engine, host);
      expect(priv.categoryPicker!.required).toBe(want);
      expect(priv.categoryPicker!.roundNumber).toBe(n);
      expect(priv.categoryPicker!.perCategory).toBe(SONGS_PER_CATEGORY_PER_ROUND);

      expect(engine.pickCategories(host, ids.slice(0, want))).toEqual({ ok: true });
      const songs = engine.room.round!.queue.length;
      for (let i = 0; i < songs; i++) playAndAdvance(engine, host, seats[1]!.id);
    }
    expect(engine.room.phase).toBe('GAME_OVER');
  });

  it('samples 5 unused songs per picked category and round-robins them', () => {
    const bank = bigBank();
    const { engine, seats } = startedGame(312, 2, { bank });
    const ids = selectableCategoryIds(engine).slice(0, 5);
    expect(engine.pickCategories(seats[0]!.id, ids)).toEqual({ ok: true });

    const round = engine.room.round!;
    expect(round.categories.map((c) => c.categoryId)).toEqual(ids);
    expect(round.categories.every((c) => c.songIds.length === 5)).toBe(true);
    expect(round.queue).toHaveLength(25);
    expect(new Set(round.queue).size).toBe(25);

    // A B C D E A B C D E …
    const sectionOf = (id: string) =>
      engine.room.setlist!.songs.find((s) => s.id === id)!.sectionIndex;
    expect(round.queue.map(sectionOf)).toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3, 4].concat(
      [0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4],
    ));
    checkInvariants(engine, bank);
  });

  it('rejects an unknown, duplicated or exhausted category', () => {
    const bank = bigBank();
    const { engine, seats } = startedGame(313, 2, { bank });
    const host = seats[0]!.id;
    const ids = selectableCategoryIds(engine);

    expect(engine.pickCategories(host, [ids[0]!, ids[1]!, ids[2]!, ids[3]!, 'nope'])).toEqual({
      ok: false,
      error: 'No such category.',
    });
    expect(engine.pickCategories(host, [ids[0]!, ids[0]!, ids[1]!, ids[2]!, ids[3]!])).toEqual({
      ok: false,
      error: 'Duplicate category.',
    });

    // drain one category, then try to pick it again
    const small = makeBank(6, [2, 10, 10, 10, 10, 10]);
    const g2 = startedGame(314, 2, { bank: small });
    const smallIds = selectableCategoryIds(g2.engine);
    expect(g2.engine.pickCategories(g2.seats[0]!.id, smallIds.slice(0, 5))).toEqual({ ok: true });
    // category 0 only had 2 songs — it is now empty
    const after = g2.engine.unusedByCategory();
    expect(after.get(0)).toBe(0);
    for (let i = 0; i < g2.engine.room.round!.queue.length; i++) {
      playAndAdvance(g2.engine, g2.seats[0]!.id, g2.seats[1]!.id);
    }
    expect(g2.engine.room.phase).toBe('ROUND_SETUP');
    const round2Required = g2.engine.requiredCategoryCount(2);
    const withEmpty = [smallIds[0]!, ...selectableCategoryIds(g2.engine)].slice(
      0,
      round2Required,
    );
    expect(g2.engine.pickCategories(g2.seats[0]!.id, withEmpty)).toEqual({
      ok: false,
      error: 'That category has no songs left.',
    });
  });

  it('lets a short category contribute what it has', () => {
    const bank = makeBank(5, [3, 10, 10, 10, 10]);
    const { engine, seats } = startedGame(315, 2, { bank });
    const ids = selectableCategoryIds(engine);
    expect(engine.pickCategories(seats[0]!.id, ids)).toEqual({ ok: true });
    const round = engine.room.round!;
    expect(round.categories.map((c) => c.songIds.length)).toEqual([3, 5, 5, 5, 5]);
    expect(round.queue).toHaveLength(23);
    checkInvariants(engine, bank);
  });

  it('never re-samples a song — or its videoId — in a later round', () => {
    const bank = makeBank(6, 12);
    const { engine, seats } = startedGame(316, 2, { bank });
    const host = seats[0]!.id;
    const ids = selectableCategoryIds(engine).slice(0, 5);
    expect(engine.pickCategories(host, ids)).toEqual({ ok: true });
    const round1 = [...engine.room.round!.queue];
    for (let i = 0; i < round1.length; i++) playAndAdvance(engine, host, seats[1]!.id);

    expect(engine.room.phase).toBe('ROUND_SETUP');
    // pick the SAME categories again
    expect(engine.pickCategories(host, ids.slice(0, 4))).toEqual({ ok: true });
    const round2 = [...engine.room.round!.queue];
    expect(round2.filter((id) => round1.includes(id))).toEqual([]);

    const videoIdOf = (id: string) =>
      engine.room.setlist!.songs.find((s) => s.id === id)!.question.videoId;
    const v1 = new Set(round1.map(videoIdOf));
    expect(round2.map(videoIdOf).filter((v) => v1.has(v))).toEqual([]);
    checkInvariants(engine, bank);
  });

  it('clamps the required count and ends the game when nothing is selectable', () => {
    // 3 categories of 2 songs: round 1 needs 3 (clamped from 5) and drains them.
    const bank = makeBank(3, 2);
    const { engine, seats } = startedGame(317, 2, { bank });
    expect(engine.requiredCategoryCount(1)).toBe(3);
    pickRound(engine, seats[0]!.id);
    expect(engine.room.round!.queue).toHaveLength(6);
    for (let i = 0; i < 6; i++) playAndAdvance(engine, seats[0]!.id, seats[1]!.id);
    // nothing left to pick — straight to GAME_OVER, never a dead ROUND_SETUP
    expect(engine.room.phase).toBe('GAME_OVER');
  });

  it('the bundled sample bank plays through its clamped rounds', () => {
    // 6 x 6. Round 1 takes 5 categories x 5 songs; round 2 then finds 5
    // categories with 1 song each plus one untouched — the "fewer than 5" path.
    const { engine, seats, bank } = startedGame(318, 2);
    expect(engine.requiredCategoryCount(1)).toBe(5);
    pickRound(engine, seats[0]!.id);
    expect(engine.room.round!.queue).toHaveLength(25);
    for (let i = 0; i < 25; i++) playAndAdvance(engine, seats[0]!.id, seats[1]!.id);
    expect(engine.room.phase).toBe('ROUND_SETUP');
    expect(engine.room.round!.number).toBe(2);
    expect(engine.requiredCategoryCount(2)).toBe(4);
    pickRound(engine, seats[0]!.id);
    expect(engine.room.round!.queue.length).toBeGreaterThan(0);
    checkInvariants(engine, bank);
  });
});

describe('on deck', () => {
  it('publishes the category and only the category', () => {
    const bank = makeBank(6, 10);
    const { engine, seats } = startedGame(320, 2, { bank });
    pickRound(engine, seats[0]!.id);
    const pub = toPublicRoom(engine.room, 0);
    const song = engine.onDeckSong()!;
    expect(pub.onDeck).toEqual({
      categoryTitle: engine.room.setlist!.sections[song.sectionIndex]!.title,
      roundNumber: 1,
      indexInRound: 1,
      songsInRound: 25,
    });
    expect(pub.round).toEqual({ number: 1, songsTotal: 25, songsPlayed: 0 });
    const json = JSON.stringify(pub);
    expect(json).not.toContain(song.question.title);
    expect(json).not.toContain(song.question.artist);
    expect(json).not.toContain(song.question.videoId);

    // the host — and only the host — gets the song itself
    const hostPriv = toPrivateState(engine, seats[0]!.id);
    expect(hostPriv.hostOnDeck).toEqual({
      songId: song.id,
      title: song.question.title,
      artist: song.question.artist,
      videoId: song.question.videoId,
    });
    expect(toPrivateState(engine, seats[1]!.id).hostOnDeck).toBeNull();
    expect(toPrivateState(engine, null).hostOnDeck).toBeNull();
    checkInvariants(engine, bank);
  });

  it('refuses any song but the one on deck — there is no free choice', () => {
    const bank = makeBank(6, 10);
    const { engine, seats } = startedGame(321, 2, { bank });
    pickRound(engine, seats[0]!.id);
    const onDeck = onDeckSongId(engine);
    const other = engine.room.round!.queue.find((id) => id !== onDeck)!;
    expect(engine.startSong(seats[0]!.id, other)).toEqual({
      ok: false,
      error: 'That song is not on deck.',
    });
    expect(engine.startSong(seats[0]!.id, 'nope')).toEqual({ ok: false, error: 'No such song.' });
    expect(engine.startSong(seats[0]!.id, onDeck)).toEqual({ ok: true });
    expect(engine.room.phase).toBe('ARMED');
    checkInvariants(engine, bank);
  });

  it('advances the cursor round by round and never replays a song', () => {
    const bank = makeBank(6, 10);
    const { engine, seats } = startedGame(322, 2, { bank });
    pickRound(engine, seats[0]!.id);
    const queue = [...engine.room.round!.queue];
    const played: string[] = [];
    for (let i = 0; i < 5; i++) {
      played.push(onDeckSongId(engine));
      playAndAdvance(engine, seats[0]!.id, seats[1]!.id);
    }
    expect(played).toEqual(queue.slice(0, 5));
    expect(engine.room.round!.cursor).toBe(5);
    expect(toPublicRoom(engine.room, 0).onDeck!.indexInRound).toBe(6);
  });
});

describe('category picker projection', () => {
  it('groups taxonomy categories and drops empty groups', () => {
    const bank = makeBank(3, 6);
    bank.categories[1]!.id = 'cat_tax_rock_sub__grunge';
    bank.categories[2]!.id = 'cat_tax_era__90s';
    const { engine, seats } = startedGame(330, 2, { bank });
    const picker = toPrivateState(engine, seats[0]!.id).categoryPicker!;
    expect(picker.groups.map((g) => g.slug)).toEqual(['genre', 'rock_sub', 'era']);
    expect(picker.groups.map((g) => g.label)).toEqual([
      'Genres',
      'Rock sub-genres',
      'Hits by era',
    ]);
    expect(picker.groups[0]!.categories).toEqual([
      { id: 'cat_tax_genre__c0', title: 'Category 0', available: 6 },
    ]);
  });

  // Risk 10: a bank the new builder never touched must land wholesale in
  // 'other' and stay fully playable.
  it('puts a non-taxonomy bank wholesale in "All categories"', () => {
    const { engine, seats, bank } = startedGame(331, 2);
    const picker = toPrivateState(engine, seats[0]!.id).categoryPicker!;
    expect(picker.groups).toHaveLength(1);
    expect(picker.groups[0]!.slug).toBe('other');
    expect(picker.groups[0]!.label).toBe('All categories');
    expect(picker.groups[0]!.categories.map((c) => c.id)).toEqual(
      bank.categories.map((c) => c.id),
    );
    // …and it plays
    pickRound(engine, seats[0]!.id);
    expect(engine.room.phase).toBe('ON_DECK');
  });

  it('reports an exhausted category as available: 0 rather than hiding it', () => {
    const bank = makeBank(6, [2, 10, 10, 10, 10, 10]);
    const { engine, seats } = startedGame(332, 2, { bank });
    pickRound(engine, seats[0]!.id);
    for (let i = 0; i < engine.room.round!.queue.length; i++) {
      playAndAdvance(engine, seats[0]!.id, seats[1]!.id);
    }
    const picker = toPrivateState(engine, seats[0]!.id).categoryPicker!;
    const all = picker.groups.flatMap((g) => g.categories);
    expect(all).toHaveLength(6);
    expect(all.find((c) => c.id === 'cat_tax_genre__c0')!.available).toBe(0);
  });
});
