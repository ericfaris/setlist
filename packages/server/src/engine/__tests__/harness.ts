// Test harness: a controllable clock + helpers to build engines and drive
// games, plus an invariant checker (including the spectator-safe leak check)
// meant to be run after every mutation.
import { expect } from 'vitest';
import { SONG_POINT_VALUE, type JudgeVerdict, type QuestionBank } from '@setlist/shared';
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

/** Build a bank with `categories` categories of `perCategory` questions each. */
export function makeBank(categories: number, perCategory: number | number[]): QuestionBank {
  const counts =
    typeof perCategory === 'number' ? Array(categories).fill(perCategory) : perCategory;
  return {
    version: 1,
    generatedAt: '2026-01-01T00:00:00Z',
    source: 'fixture',
    categories: Array.from({ length: categories }, (_, c) => ({
      id: `cat_${c}`,
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

/** The id of the first song nobody has played yet. */
export function firstUnusedSongId(engine: GameEngine): string {
  const song = engine.room.setlist?.songs.find((s) => !s.used);
  if (!song) throw new Error('no unused songs left');
  return song.id;
}

/** Arm the next song, have `buzzerId` buzz, judge them, and land in REVEAL. */
export function playRound(
  engine: GameEngine,
  hostId: string,
  buzzerId: string,
  verdict: JudgeVerdict,
): void {
  const armed = engine.startSong(hostId, firstUnusedSongId(engine));
  expect(armed).toEqual({ ok: true });
  expect(engine.buzz(buzzerId)).toEqual({ ok: true });
  expect(engine.judge(hostId, verdict)).toEqual({ ok: true });
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
      // the two host-only channels, both shut for everyone else
      expect(priv.setlist).toBeNull();
      expect(priv.hostAnswer).toBeNull();
    } else {
      // the host sees the setlist exactly while browsing, and the answer
      // exactly while a round exists
      expect(priv.setlist === null).toBe(!(room.phase === 'SETLIST' && !!room.setlist));
      expect(priv.hostAnswer === null).toBe(!room.active);
    }
  }

  // The receiver's own projection: the least privileged surface in the system.
  const receiverPriv = toPrivateState(engine, null);
  expect(receiverPriv.hostAnswer).toBeNull();
  expect(receiverPriv.setlist).toBeNull();
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
