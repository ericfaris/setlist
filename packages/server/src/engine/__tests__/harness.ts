// Test harness: a controllable clock + helpers to build engines and drive
// games, plus an invariant checker (including the spectator-safe leak check)
// meant to be run after every mutation.
import { expect } from 'vitest';
import {
  SONG_POINT_VALUE,
  type JudgeVerdict,
  type QuestionBank,
} from '@setlist/shared';
import { GameEngine } from '../engine.js';
import { makeRng } from '../rng.js';
import { sampleQuestionBank } from '../../questions/bank.js';
import { toPrivateState, toPublicRoom } from '../project.js';

export class Clock {
  t = 1_000_000;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export interface MakeEngineOptions {
  bank?: QuestionBank;
}

export function makeEngine(
  seed: number,
  opts: MakeEngineOptions = {},
): { engine: GameEngine; clock: Clock; bank: QuestionBank } {
  const clock = new Clock();
  const bank = opts.bank ?? sampleQuestionBank();
  const engine = new GameEngine('1234', { rng: makeRng(seed), bank, now: clock.now });
  engine.setCastConnected(true);
  return { engine, clock, bank };
}

export interface Seat {
  id: string;
  token: string;
  name: string;
}

/** Add `n` players to the lobby. The first becomes host. Returns their seats. */
export function addPlayers(engine: GameEngine, n: number, canCast = true): Seat[] {
  const seats: Seat[] = [];
  for (let i = 0; i < n; i++) {
    const name = `P${i}`;
    const res = engine.join({ displayName: name, canCast: i === 0 ? canCast : false });
    if (!res.ok) throw new Error(`join failed: ${res.error}`);
    seats.push({ id: res.player.id, token: res.player.reconnectToken, name });
  }
  return seats;
}

/**
 * Build a bank with `categories` categories of `perCategory` questions each.
 * Ids are taxonomy-style (`cat_tax_genre__c<N>`) so the picker projection is
 * exercised on a real group rather than only the 'other' fallback. The sample
 * bank covers the fallback.
 */
export function makeBank(categories: number, perCategory: number | number[]): QuestionBank {
  const counts =
    typeof perCategory === 'number' ? Array(categories).fill(perCategory) : perCategory;
  return {
    version: 1,
    generatedAt: '2026-01-01T00:00:00Z',
    source: 'fixture',
    categories: Array.from({ length: categories }, (_, c) => ({
      id: `cat_tax_genre__c${c}`,
      title: `Category ${c}`,
      playlistId: `PL${c}`,
      questions: Array.from({ length: counts[c] ?? 0 }, (_, q) => ({
        id: `q_c${c}q${q}`,
        title: `Song ${c}-${q}`,
        artist: `Artist ${c}-${q}`,
        videoId: `vid${c}${q}`.padEnd(11, 'x'),
        album: null,
        durationSeconds: 240,
        value: SONG_POINT_VALUE,
        startSeconds: null,
      })),
    })),
  };
}

/** The id of the song the server has queued up next. */
export function onDeckSongId(engine: GameEngine): string {
  const song = engine.onDeckSong();
  if (!song) throw new Error('no song on deck');
  return song.id;
}

/** The category ids the host may still pick, in catalog order. */
export function selectableCategoryIds(engine: GameEngine): string[] {
  const unused = engine.unusedByCategory();
  return (engine.room.setlist?.sections ?? [])
    .filter((sec) => (unused.get(sec.index) ?? 0) > 0)
    .map((sec) => sec.id);
}

/**
 * Pick this round's categories: the first `required` selectable ones, unless
 * `ids` is given explicitly. ROUND_SETUP -> ON_DECK.
 */
export function pickRound(engine: GameEngine, hostId: string, ids?: string[]): string[] {
  const round = engine.room.round;
  if (!round) throw new Error('no round in progress');
  const required = engine.requiredCategoryCount(round.number);
  const chosen = ids ?? selectableCategoryIds(engine).slice(0, required);
  expect(engine.pickCategories(hostId, chosen)).toEqual({ ok: true });
  return chosen;
}

/** Arm the on-deck song, picking this round's categories first if needed. */
export function armNext(engine: GameEngine, hostId: string): { ok: boolean; error?: string } {
  if (engine.room.phase === 'ROUND_SETUP') pickRound(engine, hostId);
  return engine.startSong(hostId, onDeckSongId(engine));
}

/** Arm the next song, have `buzzerId` buzz, judge them, and land in REVEAL. */
export function playSong(
  engine: GameEngine,
  hostId: string,
  buzzerId: string,
  verdict: JudgeVerdict,
): void {
  expect(armNext(engine, hostId)).toEqual({ ok: true });
  expect(engine.buzz(buzzerId)).toEqual({ ok: true });
  expect(engine.judge(hostId, verdict)).toEqual({ ok: true });
}

/** playSong + advance past the reveal. */
export function playAndAdvance(
  engine: GameEngine,
  hostId: string,
  buzzerId: string,
  verdict: JudgeVerdict = { titleCorrect: true, artistCorrect: true },
): void {
  playSong(engine, hostId, buzzerId, verdict);
  expect(engine.nextQuestion(hostId)).toEqual({ ok: true });
}

let prevUsed = new WeakMap<GameEngine, number>();

// ---------------------------------------------------------------- invariants
export function checkInvariants(engine: GameEngine, bank?: QuestionBank): void {
  const room = engine.room;

  // exactly one host while the room is non-empty
  if (room.players.length > 0) {
    expect(room.players.filter((p) => p.isHost).length).toBe(1);
  }

  // unique display names (case-insensitive)
  const names = room.players.map((p) => p.displayName.toLowerCase());
  expect(new Set(names).size).toBe(names.length);

  const active = room.active;
  if (active) {
    // A lock exists only in LOCKED, or in REVEAL where it records who answered.
    if (room.phase === 'LOCKED') expect(active.lockedPlayerId).not.toBeNull();
    else if (room.phase !== 'REVEAL') expect(active.lockedPlayerId).toBeNull();
    // the locker is never simultaneously locked out
    if (active.lockedPlayerId) {
      expect(active.lockedOutPlayerIds).not.toContain(active.lockedPlayerId);
    }
    expect(new Set(active.lockedOutPlayerIds).size).toBe(active.lockedOutPlayerIds.length);
    // the picker never buzzes on their own round, host or demoted ex-host
    expect(active.lockedPlayerId).not.toBe(active.pickedByPlayerId);
  }

  const pub = toPublicRoom(room, 0);

  // ---- setlist bookkeeping ----
  if (room.setlist) {
    const used = room.setlist.songs.filter((s) => s.used).length;
    const prev = prevUsed.get(engine);
    if (prev !== undefined && room.phase !== 'LOBBY') expect(used).toBeGreaterThanOrEqual(prev);
    prevUsed.set(engine, used);
    // ids are opaque + positional and unique
    const ids = room.setlist.songs.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^s\d+q\d+$/);
    // the public projection's counts agree
    expect(pub.songsTotal).toBe(room.setlist.songs.length);
    expect(pub.songsRemaining + used).toBe(pub.songsTotal);
  }

  // ---- round bookkeeping ----
  const round = room.round;
  if (round && room.setlist) {
    const catalogIds = new Set(room.setlist.songs.map((s) => s.id));
    const drawn = round.categories.reduce((n, c) => n + c.songIds.length, 0);
    expect(round.queue).toHaveLength(drawn);
    expect(new Set(round.queue).size).toBe(round.queue.length);
    for (const id of round.queue) {
      expect(catalogIds.has(id)).toBe(true);
      // `used` flips at SAMPLE time, so everything in the queue is already used
      expect(room.setlist.songs.find((s) => s.id === id)!.used).toBe(true);
    }
    expect(round.cursor).toBeGreaterThanOrEqual(0);
    expect(round.cursor).toBeLessThanOrEqual(round.queue.length);
    // no two songs QUEUED to play share a videoId — the other half of the
    // per-section dedupe bargain (buildSetlist dedupes only within a section,
    // markUsedByVideoId stops the same track being drawn twice)
    const queueVideoIds = round.queue.map(
      (id) => room.setlist!.songs.find((s) => s.id === id)!.question.videoId,
    );
    expect(new Set(queueVideoIds).size).toBe(queueVideoIds.length);
  }

  // the upcoming category is public; nothing else about the song is
  if (pub.onDeck) {
    expect(room.phase).toBe('ON_DECK');
    expect(Object.keys(pub.onDeck).sort()).toEqual([
      'categoryTitle',
      'indexInRound',
      'roundNumber',
      'songsInRound',
    ]);
  } else {
    expect(room.phase).not.toBe('ON_DECK');
  }

  // ---- spectator-safe leak checks ----
  if (pub.active && !pub.active.revealed) expect(pub.active.answer).toBeNull();
  const serialized = JSON.stringify(pub);
  if (bank) {
    for (const cat of bank.categories) {
      for (const q of cat.questions) {
        // no bank videoId, anywhere, ever
        expect(serialized).not.toContain(q.videoId);
        // and no song title/artist at all — the setlist lives on GameRoom now,
        // so this is what proves toPublicRoom never projects it. The one
        // exception is the active question's own answer, once revealed.
        const isRevealedAnswer =
          !!room.active && room.active.revealed && room.active.question.id === q.id;
        if (!isRevealedAnswer) {
          expect(serialized).not.toContain(q.title);
          expect(serialized).not.toContain(q.artist);
        }
      }
    }
  }
  // pre-reveal, the active title/artist must not appear in the public projection
  if (room.active && !room.active.revealed) {
    expect(serialized).not.toContain(room.active.question.title);
    expect(serialized).not.toContain(room.active.question.artist);
  }

  for (const p of room.players) {
    const priv = toPrivateState(engine, p.id);
    if (!p.isHost) {
      // the host-only channels, all shut for everyone else
      expect(priv.categoryPicker).toBeNull();
      expect(priv.hostOnDeck).toBeNull();
      expect(priv.hostAnswer).toBeNull();
    } else {
      // the host sees the picker exactly while picking, the on-deck song
      // exactly while one is on deck, and the answer exactly while a round exists
      expect(priv.categoryPicker === null).toBe(
        !(room.phase === 'ROUND_SETUP' && !!room.setlist),
      );
      expect(priv.hostOnDeck === null).toBe(!(room.phase === 'ON_DECK' && !!room.setlist));
      expect(priv.hostAnswer === null).toBe(!room.active);
    }
  }

  // The receiver's own projection: the least privileged surface in the system.
  const receiverPriv = toPrivateState(engine, null);
  expect(receiverPriv.hostAnswer).toBeNull();
  expect(receiverPriv.categoryPicker).toBeNull();
  expect(receiverPriv.hostOnDeck).toBeNull();
  const receiverJson = JSON.stringify(receiverPriv);
  for (const cat of bank?.categories ?? []) {
    for (const q of cat.questions) expect(receiverJson).not.toContain(q.videoId);
  }
}

/** Reset the monotonic-used-songs memory (call between independent games). */
export function resetInvariantMemory(): void {
  prevUsed = new WeakMap<GameEngine, number>();
}

/** Start a game with `n` players and return the seats. */
export function startedGame(
  seed: number,
  n: number,
  opts: MakeEngineOptions = {},
): { engine: GameEngine; clock: Clock; seats: Seat[]; bank: QuestionBank } {
  const { engine, clock, bank } = makeEngine(seed, opts);
  const seats = addPlayers(engine, n);
  const res = engine.start(seats[0]!.id);
  expect(res).toEqual({ ok: true });
  return { engine, clock, seats, bank };
}
