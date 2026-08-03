// Room registry: owns the map of 4-digit code -> GameEngine, handles collision-
// checked code generation, and frees codes when rooms close. Multiple
// simultaneous rooms fall out of this for free — the registry is keyed by code
// and nothing above it is global.
import type { QuestionBank } from '@setlist/shared';
import { GameEngine } from '../engine/engine.js';
import { makeRng } from '../engine/rng.js';

export interface RoomRuntime {
  engine: GameEngine;
  /** socketId -> playerId for player/host sockets in this room */
  sockets: Map<string, string>;
  /** receiver (TV) socketIds */
  receivers: Set<string>;
  /** playerId -> pending "actually mark them disconnected" timer (see server.ts) */
  disconnectGraceTimers: Map<string, NodeJS.Timeout>;
}

/** How long a just-created room is protected from closeIfEmpty. */
const ROOM_EMPTY_GRACE_MS = 60_000;

export class RoomManager {
  private readonly rooms = new Map<string, RoomRuntime>();
  private readonly rng = makeRng();
  private pendingCastCode: string | null = null;
  private pendingCastAt = 0;

  constructor(private readonly bank: QuestionBank) {}

  setPendingCastCode(code: string): void {
    this.pendingCastCode = code;
    this.pendingCastAt = Date.now();
  }
  getPendingCastCode(): string | null {
    if (!this.pendingCastCode) return null;
    if (Date.now() - this.pendingCastAt > 120_000) return null;
    if (!this.rooms.has(this.pendingCastCode)) return null;
    return this.pendingCastCode;
  }

  has(code: string): boolean {
    return this.rooms.has(code);
  }
  get(code: string): RoomRuntime | undefined {
    return this.rooms.get(code);
  }
  all(): RoomRuntime[] {
    return [...this.rooms.values()];
  }

  private generateCode(): string {
    // up to 10k codes; rooms are short-lived so collisions are rare but checked.
    for (let attempt = 0; attempt < 100000; attempt++) {
      const code = String(this.rng.int(10000)).padStart(4, '0');
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('No free room codes available.');
  }

  create(): RoomRuntime {
    const code = this.generateCode();
    const engine = new GameEngine(code, { bank: this.bank });
    const runtime: RoomRuntime = {
      engine,
      sockets: new Map(),
      receivers: new Set(),
      disconnectGraceTimers: new Map(),
    };
    this.rooms.set(code, runtime);
    return runtime;
  }

  close(code: string): void {
    const r = this.rooms.get(code);
    for (const t of r?.disconnectGraceTimers.values() ?? []) clearTimeout(t);
    this.rooms.delete(code);
  }

  /** Close a room if it has no connected players or receivers. */
  closeIfEmpty(code: string): boolean {
    const r = this.rooms.get(code);
    if (!r) return false;
    const anyConnected = r.engine.room.players.some((p) => p.connected);
    if (anyConnected || r.receivers.size > 0) return false;
    // Grace period: a brand-new room legitimately has zero players (the host
    // hasn't finished the Cast handshake + entered their name yet) and can have
    // zero receivers for a moment (TV reconnecting after the cache-bust
    // redirect). Don't let that normal setup gap destroy the room out from
    // under an in-progress host join.
    if (Date.now() - r.engine.room.createdAt < ROOM_EMPTY_GRACE_MS) return false;
    this.close(code);
    return true;
  }
}
