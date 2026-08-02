// ============================================================================
// Music Trivia game engine — pure, server-authoritative state machine.
// One GameEngine instance owns exactly one GameRoom. Net/timer side effects
// live outside; this file is deterministic given { rng, bank, now }.
//
//   LOBBY --game:start--> BOARD --board:select--> PLAYING --(first buzz)--> LOCKED
//                           ^                       |                        |
//                           |     clip expired      v      judge             v
//                           +------------------- REVEAL <--------------------+
//                                                  | (host: next)
//                                                  v
//                              all cells used --> GAME_OVER
// ============================================================================
import {
  BOARD_COLUMNS,
  BOARD_ROWS,
  DEFAULT_CLIP_DURATION_SECONDS,
  DEFAULT_CLIP_START_SECONDS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  POINT_VALUES,
  type ActiveQuestion,
  type BankQuestion,
  type BoardCell,
  type BoardState,
  type GameRoom,
  type JudgeVerdict,
  type Player,
  type QuestionBank,
  type RoomPhase,
  type RoomSettings,
} from '@music-trivia/shared';
import { makeRng, type Rng } from './rng.js';

export type EngineResult = { ok: true } | { ok: false; error: string };
const ok: EngineResult = { ok: true };
const err = (error: string): EngineResult => ({ ok: false, error });

/** Phases where a game is actually under way (used by pause/mid-game join). */
const IN_PROGRESS_PHASES: RoomPhase[] = ['BOARD', 'PLAYING', 'LOCKED', 'REVEAL'];

export interface EngineDeps {
  rng?: Rng;
  bank: QuestionBank;
  now?: () => number;
  clipStartSeconds?: number;
  clipDurationSeconds?: number;
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
  private readonly clipStartSeconds: number;
  private readonly clipDurationSeconds: number;

  /**
   * The laid-out questions, keyed by cell questionId. Deliberately NOT on
   * GameRoom: if the answers never live on the broadcastable model there is no
   * way for a projector bug to leak them.
   */
  private questions = new Map<string, BankQuestion>();
  private joinCounter = 0;

  constructor(code: string, deps: EngineDeps) {
    this.rng = deps.rng ?? makeRng();
    this.bank = deps.bank;
    this.now = deps.now ?? (() => Date.now());
    this.clipStartSeconds = deps.clipStartSeconds ?? DEFAULT_CLIP_START_SECONDS;
    this.clipDurationSeconds = deps.clipDurationSeconds ?? DEFAULT_CLIP_DURATION_SECONDS;
    this.room = {
      code,
      phase: 'LOBBY',
      settings: { ...DEFAULT_SETTINGS },
      players: [],
      board: null,
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
    // Same gate as pinpoint: the TV must be up before play begins — the board
    // and the music both live there.
    if (!this.room.castConnected) return err('Connect to the TV before starting.');

    const present = this.room.players.filter((p) => p.connected);
    if (present.length < MIN_PLAYERS) return err(`Need at least ${MIN_PLAYERS} player.`);
    if (present.length > MAX_PLAYERS) return err(`At most ${MAX_PLAYERS} players.`);

    for (const p of this.room.players) {
      p.score = 0;
      p.pendingJoin = false;
    }
    this.room.winnerPlayerIds = [];
    this.room.active = null;

    const board = this.layOutBoard();
    if (!board) return err('The question bank has no category with enough songs.');
    this.room.board = board;
    this.room.phase = 'BOARD';
    return ok;
  }

  /**
   * Board layout: take bank categories with at least BOARD_ROWS questions, use
   * the first BOARD_COLUMNS of them, and pick BOARD_ROWS questions per category
   * with the room's seeded RNG (so a rematch reshuffles). A smaller bank yields
   * a narrower board rather than a refusal to start — a user's first real bank
   * may well be small.
   */
  private layOutBoard(): BoardState | null {
    const eligible = this.bank.categories.filter((c) => c.questions.length >= BOARD_ROWS);
    if (eligible.length === 0) return null;
    const chosen = eligible.slice(0, BOARD_COLUMNS);

    this.questions = new Map();
    const cells: BoardCell[] = [];
    chosen.forEach((cat, categoryIndex) => {
      const pool = this.rng.shuffle(cat.questions.slice()).slice(0, BOARD_ROWS);
      pool.forEach((q, rowIndex) => {
        // Cell ids are positional and OPAQUE. Deriving them from the bank's
        // question id would embed the videoId — which is projected on every
        // public cell — and hand players the answer.
        const questionId = `c${categoryIndex}r${rowIndex}`;
        this.questions.set(questionId, q);
        cells.push({
          categoryIndex,
          rowIndex,
          value: POINT_VALUES[rowIndex] ?? POINT_VALUES[POINT_VALUES.length - 1]!,
          questionId,
          used: false,
        });
      });
    });

    return {
      categories: chosen.map((c) => ({ id: c.id, title: c.title })),
      cells,
    };
  }

  // ------------------------------------------------------------ board flow
  selectCell(hostId: string, categoryIndex: number, rowIndex: number): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can pick a square.');
    if (this.room.phase !== 'BOARD') return err('Not picking a square right now.');
    const board = this.room.board;
    if (!board) return err('No board.');
    const cell = board.cells.find(
      (c) => c.categoryIndex === categoryIndex && c.rowIndex === rowIndex,
    );
    if (!cell) return err('No such square.');
    if (cell.used) return err('That square has already been played.');
    const question = this.questions.get(cell.questionId);
    if (!question) return err('That square has no question.');

    cell.used = true;
    const startSeconds = this.resolveStartSeconds(question);
    const prevToken = this.room.active?.playToken ?? 0;
    this.room.active = {
      cell,
      question,
      startedAt: this.now(),
      startSeconds,
      durationSeconds: this.clipDurationSeconds,
      lockedPlayerId: null,
      lockedAt: null,
      lockedOutPlayerIds: [],
      verdict: null,
      awarded: 0,
      revealed: false,
      playToken: prevToken + 1,
      playbackError: null,
    };
    this.room.phase = 'PLAYING';
    return ok;
  }

  /**
   * Clip offset (see the plan §2.3): a hand-tuned per-question `startSeconds`
   * wins; otherwise the configured constant, clamped so a short track doesn't
   * start past its own end. No hook detection — that is explicitly out of scope.
   */
  private resolveStartSeconds(q: BankQuestion): number {
    if (q.startSeconds !== null && q.startSeconds >= 0) return q.startSeconds;
    const wanted = this.clipStartSeconds;
    if (q.durationSeconds === null) return wanted;
    const latest = Math.max(0, q.durationSeconds - this.clipDurationSeconds - 5);
    return Math.min(wanted, latest);
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
    if (this.room.phase !== 'PLAYING' || !active) return err('Buzzers are not armed.');
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

    const value = active.cell.value;
    const half = value / 2;
    const anyCorrect = verdict.titleCorrect || verdict.artistCorrect;

    let awarded = 0;
    if (anyCorrect) {
      awarded = (verdict.titleCorrect ? half : 0) + (verdict.artistCorrect ? half : 0);
    } else if (this.room.settings.penalizeWrongAnswers) {
      awarded = -half;
    }

    buzzer.score += awarded;
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

    const stillIn = this.activePlayers().filter(
      (p) => p.connected && !active.lockedOutPlayerIds.includes(p.id),
    );
    if (stillIn.length === 0) {
      active.revealed = true;
      this.room.phase = 'REVEAL';
      return ok;
    }

    // Resume the clip for whoever is left.
    active.playToken += 1;
    active.startedAt = this.now();
    this.room.phase = 'PLAYING';
    return ok;
  }

  skipQuestion(hostId: string): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can skip a question.');
    if (this.room.phase !== 'PLAYING' && this.room.phase !== 'LOCKED') {
      return err('No question in play.');
    }
    const active = this.room.active;
    if (!active) return err('No question in play.');
    active.lockedPlayerId = null;
    active.lockedAt = null;
    active.revealed = true;
    this.room.phase = 'REVEAL';
    return ok;
  }

  /** The clip ran its full length with nobody buzzing. Driven by a net-layer timer. */
  clipExpired(): EngineResult {
    if (this.room.phase !== 'PLAYING') return err('No clip is playing.');
    const active = this.room.active;
    if (!active) return err('No clip is playing.');
    active.revealed = true;
    this.room.phase = 'REVEAL';
    return ok;
  }

  replayClip(hostId: string): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can replay the clip.');
    const active = this.room.active;
    if (!active) return err('No question in play.');
    if (this.room.phase !== 'PLAYING') return err('The clip is not playing.');
    active.playToken += 1;
    active.startedAt = this.now();
    return ok;
  }

  /** The receiver's YouTube player errored or stalled. Surfaces to the host as "Skip". */
  reportPlaybackError(message: string): EngineResult {
    const active = this.room.active;
    if (!active) return err('No question in play.');
    active.playbackError = message;
    return ok;
  }

  nextQuestion(hostId: string): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can advance.');
    if (this.room.phase !== 'REVEAL') return err('The answer has not been revealed yet.');

    // Anyone who joined mid-question plays from here on.
    for (const p of this.room.players) p.pendingJoin = false;

    this.room.active = null;
    const allUsed = (this.room.board?.cells ?? []).every((c) => c.used);
    if (allUsed) {
      this.endGame();
    } else {
      this.room.phase = 'BOARD';
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
    this.room.board = null;
    this.room.active = null;
    this.room.winnerPlayerIds = [];
    this.room.pause = { active: false, reason: null, waitingForPlayerId: null };
    this.room.phaseBeforePause = null;
    this.questions = new Map();
    for (const p of this.room.players) {
      p.score = 0;
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
    const active = this.room.active;
    if (active && this.room.phase === 'PLAYING') {
      const stillIn = this.activePlayers().filter(
        (pl) => pl.connected && !active.lockedOutPlayerIds.includes(pl.id),
      );
      if (stillIn.length === 0) {
        active.revealed = true;
        this.room.phase = 'REVEAL';
      }
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
      if (this.room.phase === 'LOCKED') this.room.phase = 'PLAYING';
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
    if (this.room.phase !== 'PLAYING' || !active) return false;
    if (active.lockedPlayerId !== null) return false;
    if (active.lockedOutPlayerIds.includes(playerId)) return false;
    const p = this.player(playerId);
    return !!p && p.connected && !p.pendingJoin;
  }

  /** Category title for a laid-out cell (public — it's a board header). */
  categoryTitle(categoryIndex: number): string {
    return this.room.board?.categories[categoryIndex]?.title ?? '';
  }
}
