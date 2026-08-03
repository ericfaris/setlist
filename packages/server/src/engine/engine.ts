// ============================================================================
// Setlist game engine — pure, server-authoritative state machine.
// One GameEngine instance owns exactly one GameRoom. Net side effects live
// outside; this file is deterministic given { rng, bank, now }.
//
//   LOBBY --game:start--> SETLIST --setlist:start--> ARMED --(first buzz)--> LOCKED
//                            ^                        |                        |
//                            |     question:reveal    v      judge:answer      v
//                            +---------------------- REVEAL <------------------+
//                                                      | (question:next)
//                                                      v
//                               every song used --> GAME_OVER   (also: host:forceEnd
//                                                                from any phase)
//
// Nothing plays in our app: the host plays the song themselves from a native
// YouTube Music link and then arms the buzzers. There is no timer of any kind.
// ============================================================================
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  SONG_POINT_VALUE,
  type ActiveQuestion,
  type GameRoom,
  type JudgeVerdict,
  type Player,
  type QuestionBank,
  type RoomPhase,
  type RoomSettings,
  type SetlistSection,
  type SetlistSong,
  type SetlistState,
} from '@setlist/shared';
import { makeRng, type Rng } from './rng.js';

export type EngineResult = { ok: true } | { ok: false; error: string };

const ok: EngineResult = { ok: true };
const err = (error: string): EngineResult => ({ ok: false, error });

/** Phases where a game is actually under way (used by pause/mid-game join). */
const IN_PROGRESS_PHASES: RoomPhase[] = ['SETLIST', 'ARMED', 'LOCKED', 'REVEAL'];

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
    // Kept even though the setlist is built in bank order with no RNG: the room
    // code generator uses its own, and removing the dep churns every harness.
    this.rng = deps.rng ?? makeRng();
    this.bank = deps.bank;
    this.now = deps.now ?? (() => Date.now());
    this.room = {
      code,
      phase: 'LOBBY',
      settings: { ...DEFAULT_SETTINGS },
      players: [],
      setlist: null,
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
      p.pendingJoin = false;
    }
    this.room.winnerPlayerIds = [];
    this.room.active = null;

    const setlist = this.buildSetlist();
    if (!setlist) return err('The question bank has no songs.');
    this.room.setlist = setlist;
    this.room.phase = 'SETLIST';
    return ok;
  }

  /**
   * Flatten the bank into a browsable setlist: every category is a section,
   * every question a song, in bank order (the host is deliberately browsing —
   * a stable order beats a reshuffle). Songs are deduped by videoId, first
   * section wins, so an AI-categorised bank that put one track in two themes
   * can't offer it twice with two independent `used` flags.
   */
  private buildSetlist(): SetlistState | null {
    const sections: SetlistSection[] = [];
    const songs: SetlistSong[] = [];
    const seenVideoIds = new Set<string>();

    this.bank.categories.forEach((cat, sectionIndex) => {
      sections.push({ index: sectionIndex, id: cat.id, title: cat.title });
      cat.questions.forEach((q, j) => {
        if (seenVideoIds.has(q.videoId)) return;
        seenVideoIds.add(q.videoId);
        // Song ids are positional and OPAQUE. Deriving them from the bank's
        // question id (`q_<videoId>`) would put a videoId on the wire — the id
        // is projected publicly as PublicActiveQuestion.songId.
        songs.push({ id: `s${sectionIndex}q${j}`, sectionIndex, question: q, used: false });
      });
    });

    if (songs.length === 0) return null;
    return { sections, songs };
  }

  // ---------------------------------------------------------- setlist flow
  /** Arm the buzzers on a chosen song. The host has already played it out loud. */
  startSong(hostId: string, songId: string): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can start a song.');
    if (this.room.phase !== 'SETLIST') return err('Not choosing a song right now.');
    const setlist = this.room.setlist;
    if (!setlist) return err('No setlist.');
    const song = setlist.songs.find((s) => s.id === songId);
    if (!song) return err('No such song.');
    if (song.used) return err('That song has already been played.');

    song.used = true;
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
    const allUsed = (this.room.setlist?.songs ?? []).every((s) => s.used);
    if (allUsed) {
      this.endGame();
    } else {
      this.room.phase = 'SETLIST';
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
    this.room.active = null;
    this.room.winnerPlayerIds = [];
    this.room.pause = { active: false, reason: null, waitingForPlayerId: null };
    this.room.phaseBeforePause = null;
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
