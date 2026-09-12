// ============================================================================
// Setlist game engine — pure, server-authoritative state machine.
// One GameEngine instance owns exactly one GameRoom. Net side effects live
// outside; this file is deterministic given { rng, bank, now }.
//
// Play runs as three fixed rounds. At the start of each round the host picks
// 5/4/3 categories; the server samples up to 5 not-yet-used songs from each and
// sequences them round-robin. Nobody browses the catalog.
//
//   LOBBY --game:start--> ROUND_SETUP --round:pickCategories--> ON_DECK
//                             ^                                    | setlist:start
//                             |                                    v
//                             |                                  ARMED --(buzz)--> LOCKED
//                             |                                    |                 |
//                             |         question:reveal            v  judge:answer   v
//                             |          +------------------->  REVEAL <-------------+
//     round done & round < 3  |          |                         | question:next
//     ------------------------+          |                         v
//                                        |     more songs in round --> ON_DECK
//                                        |     round done & round==3 --> GAME_OVER
//                                        (also: host:forceEnd from any phase)
//
// Nothing plays in our app: the host plays the song themselves from a native
// YouTube Music link and then arms the buzzers. There is no timer of any kind.
// ============================================================================
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROUND_CATEGORY_COUNTS,
  SONG_POINT_VALUE,
  SONGS_PER_CATEGORY_PER_ROUND,
  TOTAL_ROUNDS,
  type ActiveQuestion,
  type GameRoom,
  type JudgeVerdict,
  type Player,
  type QuestionBank,
  type RoomPhase,
  type RoomSettings,
  type RoundCategory,
  type SetlistSection,
  type SetlistSong,
  type SetlistState,
} from '@setlist/shared';
import { makeRng, type Rng } from './rng.js';

export type EngineResult = { ok: true } | { ok: false; error: string };

const ok: EngineResult = { ok: true };
const err = (error: string): EngineResult => ({ ok: false, error });

/** Phases where a game is actually under way (used by pause/mid-game join). */
const IN_PROGRESS_PHASES: RoomPhase[] = [
  'ROUND_SETUP',
  'ON_DECK',
  'ARMED',
  'LOCKED',
  'REVEAL',
];

export interface EngineDeps {
  rng?: Rng;
  bank: QuestionBank;
  now?: () => number;
}

export interface JoinInput {
  displayName: string;
  reconnectToken?: string;
  canCast?: boolean;
}
export type JoinResult =
  | { ok: true; player: Player; reconnected: boolean }
  | { ok: false; error: string };

let tokenSeq = 0;
function makeToken(): string {
  tokenSeq += 1;
  return `tok_${tokenSeq}_${Math.random().toString(36).slice(2, 10)}`;
}
let playerSeq = 0;
function makePlayerId(): string {
  playerSeq += 1;
  return `p_${playerSeq}_${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_SETTINGS: RoomSettings = {
  penalizeWrongAnswers: true,
};

export class GameEngine {
  readonly room: GameRoom;
  private readonly rng: Rng;
  private readonly bank: QuestionBank;
  private readonly now: () => number;
  private joinCounter = 0;

  constructor(code: string, deps: EngineDeps) {
    // Drives the per-round category sampling (the catalog itself is still built
    // in bank order with no RNG at all).
    this.rng = deps.rng ?? makeRng();
    this.bank = deps.bank;
    this.now = deps.now ?? (() => Date.now());
    this.room = {
      code,
      phase: 'LOBBY',
      settings: { ...DEFAULT_SETTINGS },
      players: [],
      setlist: null,
      round: null,
      active: null,
      winnerPlayerIds: [],
      castConnected: false,
      createdAt: this.now(),
      phaseBeforePause: null,
      pause: { active: false, reason: null, waitingForPlayerId: null },
    };
  }

  static create(code: string, deps: EngineDeps): GameEngine {
    return new GameEngine(code, deps);
  }

  // ---------------------------------------------------------------- helpers
  private player(id: string): Player | undefined {
    return this.room.players.find((p) => p.id === id);
  }
  private host(): Player | undefined {
    return this.room.players.find((p) => p.isHost);
  }
  private isHost(id: string): boolean {
    return this.host()?.id === id;
  }
  /** Players who actually participate right now (not queued mid-join). */
  private activePlayers(): Player[] {
    return this.room.players.filter((p) => !p.pendingJoin);
  }

  /**
   * Everyone who could still buzz on this question. The host is excluded (they
   * picked the song), and so is `pickedByPlayerId` — the crown can move
   * mid-round via transferHostOnDisconnect, and a demoted ex-host has already
   * seen this song's answer.
   */
  private eligibleBuzzers(active: ActiveQuestion): Player[] {
    const hostId = this.host()?.id;
    return this.activePlayers().filter(
      (p) =>
        p.connected &&
        p.id !== hostId &&
        p.id !== active.pickedByPlayerId &&
        !active.lockedOutPlayerIds.includes(p.id),
    );
  }

  // ------------------------------------------------------------------ join
  join(input: JoinInput): JoinResult {
    const { displayName, reconnectToken, canCast } = input;

    // Reconnect path: a known token reclaims the same seat.
    if (reconnectToken) {
      const existing = this.room.players.find((p) => p.reconnectToken === reconnectToken);
      if (existing) {
        existing.connected = true;
        if (canCast !== undefined) existing.canHostCast = canCast;
        this.maybeResume();
        return { ok: true, player: existing, reconnected: true };
      }
    }

    const name = displayName.trim();
    if (!name) return { ok: false, error: 'Display name required.' };
    const dupe = this.room.players.some((p) => p.displayName.toLowerCase() === name.toLowerCase());
    if (dupe) return { ok: false, error: 'That name is taken in this room.' };
    if (this.room.players.length >= MAX_PLAYERS) {
      return { ok: false, error: `Room is full (${MAX_PLAYERS} players max).` };
    }

    const inProgress = IN_PROGRESS_PHASES.includes(this.room.phase) || this.room.phase === 'PAUSED';
    // Pinpoint's rule, adopted verbatim: the first player to join is the host.
    const noHostYet = !this.host();

    const player: Player = {
      id: makePlayerId(),
      reconnectToken: makeToken(),
      displayName: name,
      connected: true,
      isHost: noHostYet,
      canHostCast: canCast ?? false,
      score: 0,
      streak: 0,
      joinOrder: this.joinCounter++,
      // A mid-game joiner sits out the question in flight, then plays from the
      // next one (promoted in nextQuestion()).
      pendingJoin: inProgress,
    };
    this.room.players.push(player);
    return { ok: true, player, reconnected: false };
  }

  // ------------------------------------------------------------- lobby ops
  updateSettings(hostId: string, patch: Partial<RoomSettings>): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can change settings.');
    if (this.room.phase !== 'LOBBY') return err('Settings lock once the game starts.');
    Object.assign(this.room.settings, patch);
    return ok;
  }

  setCastConnected(connected: boolean): EngineResult {
    const was = this.room.castConnected;
    this.room.castConnected = connected;
    if (!connected && was && IN_PROGRESS_PHASES.includes(this.room.phase)) {
      this.pause('CAST_DROPPED', this.host()?.id ?? null);
    } else if (connected) {
      this.maybeResume();
    }
    return ok;
  }

  /**
   * Hand the crown to another connected player. New vs pinpoint (which only
   * transfers automatically on disconnect): here the host does continuous
   * judging work through the whole game and may well want to pass it on.
   */
  transferHost(hostId: string, targetPlayerId: string): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can transfer the host role.');
    if (hostId === targetPlayerId) return err('You are already the host.');
    const target = this.player(targetPlayerId);
    if (!target) return err('No such player.');
    if (!target.connected) return err('That player is disconnected.');
    const current = this.host();
    if (current) current.isHost = false;
    target.isHost = true;
    return ok;
  }

  // ------------------------------------------------------------------ start
  start(hostId: string): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can start the game.');
    if (this.room.phase !== 'LOBBY') return err('Game already started.');
    // Same gate as pinpoint: the TV must be up before play begins — it carries
    // the room code, the join QR and the scoreboard.
    if (!this.room.castConnected) return err('Connect to the TV before starting.');

    const present = this.room.players.filter((p) => p.connected);
    if (present.length < MIN_PLAYERS) {
      return err(`Need at least ${MIN_PLAYERS} players — the host doesn't buzz.`);
    }
    if (present.length > MAX_PLAYERS) return err(`At most ${MAX_PLAYERS} players.`);

    for (const p of this.room.players) {
      p.score = 0;
      p.streak = 0;
      p.pendingJoin = false;
    }
    this.room.winnerPlayerIds = [];
    this.room.active = null;

    const setlist = this.buildSetlist();
    if (!setlist) return err('The question bank has no songs.');
    this.room.setlist = setlist;
    this.room.round = null;
    this.beginRound(1);
    return ok;
  }

  /**
   * Flatten the bank into the whole-game CATALOG: every category is a section,
   * every question a song, in bank order. Nobody browses this — the host picks
   * categories and the server samples from each.
   *
   * Songs are deduped by videoId WITHIN A SECTION ONLY. Under the curated
   * taxonomy one track legitimately belongs to "Rock", "90s Rock" and "90s
   * Grunge" at once; the old global "first section wins" dedupe would gut every
   * category after the first. "A song never plays twice in one game" is
   * enforced instead by markUsedByVideoId() at draw time.
   */
  private buildSetlist(): SetlistState | null {
    const sections: SetlistSection[] = [];
    const songs: SetlistSong[] = [];

    this.bank.categories.forEach((cat, sectionIndex) => {
      sections.push({ index: sectionIndex, id: cat.id, title: cat.title });
      // Reset per section: the dedupe is deliberately local to this category.
      const seenVideoIds = new Set<string>();
      let j = 0;
      cat.questions.forEach((q) => {
        if (seenVideoIds.has(q.videoId)) return;
        seenVideoIds.add(q.videoId);
        // Song ids are positional and OPAQUE. Deriving them from the bank's
        // question id (`q_<videoId>`) would put a videoId on the wire — the id
        // is projected publicly as PublicActiveQuestion.songId. The index is the
        // index WITHIN the section after dedupe, so ids stay unique.
        songs.push({ id: `s${sectionIndex}q${j}`, sectionIndex, question: q, used: false });
        j += 1;
      });
    });

    if (songs.length === 0) return null;
    return { sections, songs };
  }

  // ------------------------------------------------------------ round setup
  /** sectionIndex -> how many of its songs are still undrawn this game.
   *  PUBLIC: the host picker projection needs the same counts. */
  unusedByCategory(): Map<number, number> {
    const counts = new Map<number, number>();
    for (const section of this.room.setlist?.sections ?? []) counts.set(section.index, 0);
    for (const song of this.room.setlist?.songs ?? []) {
      if (song.used) continue;
      counts.set(song.sectionIndex, (counts.get(song.sectionIndex) ?? 0) + 1);
    }
    return counts;
  }

  /** Sections with at least one undrawn song — the ones a round may pick. */
  private selectableSections(): number[] {
    return [...this.unusedByCategory().entries()]
      .filter(([, n]) => n > 0)
      .map(([index]) => index);
  }

  /**
   * How many categories round `n` needs. Normally 5/4/3, but clamped to what is
   * actually selectable so a small bank (the bundled 6x6 sample) plays a short
   * round instead of deadlocking.
   */
  requiredCategoryCount(roundNumber: number): number {
    const nominal = ROUND_CATEGORY_COUNTS[roundNumber - 1] ?? 0;
    return Math.min(nominal, this.selectableSections().length);
  }

  /**
   * Mark EVERY catalog entry sharing this videoId as used. The catalog dedupes
   * only within a section, so the same track can sit in several categories —
   * this is the half of the bargain that keeps it from being drawn twice.
   */
  private markUsedByVideoId(videoId: string): void {
    for (const song of this.room.setlist?.songs ?? []) {
      if (song.question.videoId === videoId) song.used = true;
    }
  }

  /** Open round `number`, or end the game if there is nothing left to pick. */
  private beginRound(number: number): void {
    if (this.selectableSections().length === 0) {
      this.endGame();
      return;
    }
    this.room.round = { number, categories: [], queue: [], cursor: 0 };
    this.room.phase = 'ROUND_SETUP';
  }

  /**
   * The host's one decision per round: which categories to play. The server
   * samples the songs — there is deliberately no way to choose an individual
   * song, which is what makes the sequencing automatic.
   */
  pickCategories(hostId: string, categoryIds: string[]): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can pick categories.');
    if (this.room.phase !== 'ROUND_SETUP') return err('Not picking categories right now.');
    const setlist = this.room.setlist;
    const round = this.room.round;
    if (!setlist || !round) return err('Not picking categories right now.');

    const required = this.requiredCategoryCount(round.number);
    if (categoryIds.length !== required) return err(`Pick exactly ${required} categories.`);

    const unused = this.unusedByCategory();
    const seen = new Set<string>();
    const chosen: SetlistSection[] = [];
    for (const id of categoryIds) {
      if (seen.has(id)) return err('Duplicate category.');
      seen.add(id);
      const section = setlist.sections.find((s) => s.id === id);
      if (!section) return err('No such category.');
      if ((unused.get(section.index) ?? 0) === 0) return err('That category has no songs left.');
      chosen.push(section);
    }

    const categories: RoundCategory[] = [];
    for (const section of chosen) {
      const pool = setlist.songs.filter((s) => !s.used && s.sectionIndex === section.index);
      const take = Math.min(SONGS_PER_CATEGORY_PER_ROUND, pool.length);
      const drawn = this.rng.shuffle([...pool]).slice(0, take);
      // `used` flips at SAMPLE time, not play time — that is what makes "never
      // re-sampled in a later round" structural rather than bookkeeping.
      for (const song of drawn) this.markUsedByVideoId(song.question.videoId);
      categories.push({
        categoryId: section.id,
        title: section.title,
        songIds: drawn.map((s) => s.id),
      });
    }

    // Round-robin across the picked categories: A B C D E A B C D E …
    const queue: string[] = [];
    const longest = Math.max(0, ...categories.map((c) => c.songIds.length));
    for (let i = 0; i < longest; i++) {
      for (const cat of categories) {
        const id = cat.songIds[i];
        if (id !== undefined) queue.push(id);
      }
    }

    round.categories = categories;
    round.queue = queue;
    round.cursor = 0;
    this.room.phase = 'ON_DECK';
    return ok;
  }

  private onDeckSongId(): string | null {
    const round = this.room.round;
    if (!round) return null;
    return round.queue[round.cursor] ?? null;
  }

  /** The song the server has queued up next — host-only info, for the projector. */
  onDeckSong(): SetlistSong | null {
    const id = this.onDeckSongId();
    if (!id) return null;
    return this.room.setlist?.songs.find((s) => s.id === id) ?? null;
  }

  // ---------------------------------------------------------- setlist flow
  /** Arm the buzzers on the on-deck song. The host has already played it out loud. */
  startSong(hostId: string, songId: string): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can start a song.');
    if (this.room.phase !== 'ON_DECK') return err('No song is on deck.');
    const setlist = this.room.setlist;
    if (!setlist) return err('No setlist.');
    const onDeck = this.onDeckSongId();
    if (!onDeck) return err('No song is on deck.');
    const song = setlist.songs.find((s) => s.id === songId);
    if (!song) return err('No such song.');
    // Guards a double-tap and a stale client: there is exactly one playable song.
    if (song.id !== onDeck) return err('That song is not on deck.');

    // Already marked used when it was drawn — do NOT re-mark it here.
    this.room.active = {
      songId: song.id,
      sectionIndex: song.sectionIndex,
      question: song.question,
      pickedByPlayerId: hostId,
      startedAt: this.now(),
      lockedPlayerId: null,
      lockedAt: null,
      lockedOutPlayerIds: [],
      verdict: null,
      awarded: 0,
      revealed: false,
    };
    this.room.phase = 'ARMED';
    return ok;
  }

  // ------------------------------------------------------------- the race
  /**
   * The buzz race. This is the ONLY place lockedPlayerId is ever set, and the
   * guard below is its first statement. Node processes socket messages one at a
   * time, so "first message the server handles wins" is naturally atomic — but
   * the guard is what makes that a rule rather than an accident.
   *
   * No client timestamp appears anywhere in this path, by design.
   */
  buzz(playerId: string): EngineResult {
    const active = this.room.active;
    // The lock guard comes first so a loser in the race gets the accurate
    // "Already locked in." rather than a generic phase error.
    if (active?.lockedPlayerId != null) return err('Already locked in.');
    if (this.room.phase !== 'ARMED' || !active) return err('Buzzers are not armed.');
    // The host picked and played this song, so they already know the answer.
    // `pickedByPlayerId` keeps a demoted ex-host excluded for the whole round.
    if (this.isHost(playerId) || playerId === active.pickedByPlayerId) {
      return err("The host doesn't buzz on this one.");
    }
    const p = this.player(playerId);
    if (!p) return err('No such player.');
    if (!p.connected) return err('You are disconnected.');
    if (p.pendingJoin) return err('You join in on the next question.');
    if (active.lockedOutPlayerIds.includes(playerId)) return err('You already guessed this one.');

    active.lockedPlayerId = playerId;
    active.lockedAt = this.now(); // server clock, always
    this.room.phase = 'LOCKED';
    return ok;
  }

  // -------------------------------------------------------------- judging
  judge(hostId: string, verdict: JudgeVerdict): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can judge an answer.');
    if (this.room.phase !== 'LOCKED') return err('Nobody is locked in.');
    const active = this.room.active;
    if (!active || !active.lockedPlayerId) return err('Nobody is locked in.');
    const buzzer = this.player(active.lockedPlayerId);
    if (!buzzer) return err('The buzzed-in player is gone.');

    const value = SONG_POINT_VALUE;
    const half = value / 2;
    const anyCorrect = verdict.titleCorrect || verdict.artistCorrect;

    let awarded = 0;
    if (anyCorrect) {
      awarded = (verdict.titleCorrect ? half : 0) + (verdict.artistCorrect ? half : 0);
    } else if (this.room.settings.penalizeWrongAnswers) {
      awarded = -half;
    }

    buzzer.score += awarded;
    // Streak counts title-only/artist-only as correct too, same as scoring —
    // any recognition keeps the fire alive; only a clean miss breaks it.
    buzzer.streak = anyCorrect ? buzzer.streak + 1 : 0;
    active.verdict = verdict;
    active.awarded = awarded;

    if (anyCorrect) {
      active.revealed = true;
      this.room.phase = 'REVEAL';
      return ok;
    }

    // Wrong on both: lock this player out and re-arm everyone else.
    active.lockedOutPlayerIds.push(buzzer.id);
    active.lockedPlayerId = null;
    active.lockedAt = null;
    active.verdict = null;

    // Nobody eligible is left (the host and the picker never count) — reveal
    // rather than hang in ARMED with a dead buzzer pool.
    if (this.eligibleBuzzers(active).length === 0) {
      active.revealed = true;
      this.room.phase = 'REVEAL';
      return ok;
    }

    this.room.phase = 'ARMED';
    return ok;
  }

  /** Host ends the round and shows the answer. The only way a round ends
   *  without a correct answer — there is no timer. */
  revealQuestion(hostId: string): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can reveal the answer.');
    if (this.room.phase !== 'ARMED' && this.room.phase !== 'LOCKED') {
      return err('No song in play.');
    }
    const active = this.room.active;
    if (!active) return err('No song in play.');
    active.lockedPlayerId = null;
    active.lockedAt = null;
    active.revealed = true;
    this.room.phase = 'REVEAL';
    return ok;
  }

  nextQuestion(hostId: string): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can advance.');
    if (this.room.phase !== 'REVEAL') return err('The answer has not been revealed yet.');

    // Anyone who joined mid-question plays from here on.
    for (const p of this.room.players) p.pendingJoin = false;

    this.room.active = null;
    const round = this.room.round;
    if (!round) {
      this.endGame();
      return ok;
    }
    round.cursor += 1;
    if (round.cursor < round.queue.length) {
      this.room.phase = 'ON_DECK';
    } else if (round.number < TOTAL_ROUNDS) {
      // beginRound() itself ends the game if nothing is left to pick.
      this.beginRound(round.number + 1);
    } else {
      this.endGame();
    }
    return ok;
  }

  // ----------------------------------------------------------- host powers
  forceEnd(hostId: string): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can end the game.');
    this.room.active = null;
    this.endGame();
    return ok;
  }

  rematch(hostId: string): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can start a rematch.');
    this.room.phase = 'LOBBY';
    this.room.setlist = null;
    this.room.round = null;
    this.room.active = null;
    this.room.winnerPlayerIds = [];
    this.room.pause = { active: false, reason: null, waitingForPlayerId: null };
    this.room.phaseBeforePause = null;
    for (const p of this.room.players) {
      p.score = 0;
      p.streak = 0;
      p.pendingJoin = false;
    }
    return ok;
  }

  private endGame(): void {
    const contenders = this.room.players.filter((p) => !p.pendingJoin);
    if (contenders.length > 0) {
      const best = Math.max(...contenders.map((p) => p.score));
      this.room.winnerPlayerIds = contenders.filter((p) => p.score === best).map((p) => p.id);
    } else {
      this.room.winnerPlayerIds = [];
    }
    this.room.phase = 'GAME_OVER';
    this.room.pause = { active: false, reason: null, waitingForPlayerId: null };
    this.room.phaseBeforePause = null;
  }

  // ------------------------------------------------------ disconnect/pause
  disconnect(playerId: string): EngineResult {
    const p = this.player(playerId);
    if (!p) return err('No such player.');
    p.connected = false;
    const wasHost = p.isHost;
    if (wasHost) this.transferHostOnDisconnect(p);

    // Divergence from pinpoint (where every player is structurally required to
    // continue): here a non-host dropping mid-question just leaves the buzz
    // pool. Only losing the host — the only person who can judge or advance —
    // actually blocks the game, so only that pauses it.
    if (wasHost && !this.host()?.connected && IN_PROGRESS_PHASES.includes(this.room.phase)) {
      this.pause('PLAYER_DISCONNECT', playerId);
    }

    // A dropped player may have been the last one able to answer the question.
    // In a 2-player room this also covers the host dropping mid-round: the
    // crown moves to the only other player, who is instantly ineligible, so
    // the pool empties and the question must auto-reveal rather than hang.
    const active = this.room.active;
    if (active && this.room.phase === 'ARMED' && this.eligibleBuzzers(active).length === 0) {
      active.revealed = true;
      this.room.phase = 'REVEAL';
    }
    return ok;
  }

  /** Permanently remove a player (lobby leave / host kick). */
  removePlayer(playerId: string): EngineResult {
    const p = this.player(playerId);
    if (!p) return err('No such player.');
    if (p.isHost) this.transferHostOnDisconnect(p);
    this.room.players = this.room.players.filter((x) => x.id !== playerId);
    const active = this.room.active;
    if (active?.lockedPlayerId === playerId) {
      active.lockedPlayerId = null;
      active.lockedAt = null;
      if (this.room.phase === 'LOCKED') this.room.phase = 'ARMED';
    }
    if (this.room.phase === 'PAUSED') this.maybeResume();
    return ok;
  }

  /** Pinpoint's succession rule, kept wholesale: prefer a device that can cast. */
  private transferHostOnDisconnect(old: Player): void {
    old.isHost = false;
    const candidates = this.room.players.filter((p) => p.id !== old.id && p.connected);
    if (candidates.length === 0) {
      old.isHost = true; // nobody to take over; keep the crown (game stays paused)
      return;
    }
    const caster = candidates.find((p) => p.canHostCast);
    (caster ?? candidates[0]!).isHost = true;
  }

  private pause(
    reason: 'PLAYER_DISCONNECT' | 'CAST_DROPPED',
    waitingForPlayerId: string | null,
  ): void {
    if (this.room.phase === 'PAUSED') {
      if (!this.room.pause.waitingForPlayerId && waitingForPlayerId) {
        this.room.pause.waitingForPlayerId = waitingForPlayerId;
      }
      return;
    }
    this.room.phaseBeforePause = this.room.phase;
    this.room.phase = 'PAUSED';
    this.room.pause = { active: true, reason, waitingForPlayerId };
  }

  private maybeResume(): void {
    if (this.room.phase !== 'PAUSED') return;
    if (!this.room.castConnected) return;
    const host = this.host();
    if (!host || !host.connected) return;

    this.room.phase = this.room.phaseBeforePause ?? 'LOBBY';
    this.room.phaseBeforePause = null;
    this.room.pause = { active: false, reason: null, waitingForPlayerId: null };
  }

  // -------------------------------------------------------- introspection
  activeQuestion(): ActiveQuestion | null {
    return this.room.active;
  }

  /** Drives PrivateState.canBuzz — the phone's buzz button enablement. */
  canBuzz(playerId: string): boolean {
    const active = this.room.active;
    if (this.room.phase !== 'ARMED' || !active) return false;
    if (active.lockedPlayerId !== null) return false;
    if (this.isHost(playerId) || playerId === active.pickedByPlayerId) return false;
    if (active.lockedOutPlayerIds.includes(playerId)) return false;
    const p = this.player(playerId);
    return !!p && p.connected && !p.pendingJoin;
  }

  /** Section title for the active song (public — it's the theme header). */
  sectionTitle(sectionIndex: number): string {
    return this.room.setlist?.sections[sectionIndex]?.title ?? '';
  }
}
