// Socket client + tiny observable store shared by the player and receiver UIs.
import { io, type Socket } from 'socket.io-client';
import {
  SOCKET_PATH,
  type Ack,
  type JudgeVerdict,
  type PrivateState,
  type PublicRoom,
} from '@setlist/shared';

export interface GameState {
  connected: boolean;
  pub: PublicRoom | null;
  priv: PrivateState | null;
  code: string | null;
  error: string | null;
  /** client_now - server_now at the last projection, to reconcile clock skew */
  serverOffset: number;
}

type Listener = () => void;

const LS_CODE = 'sl:code';
const LS_TOKEN = 'sl:token';
const LS_NAME = 'sl:name';

class GameStore {
  private socket: Socket;
  private listeners = new Set<Listener>();
  /** The host's YouTube Music tab, opened via window.open() (not a plain link)
   * specifically so we keep a handle to close it — the only way to actually
   * stop playback in a cross-origin tab we never embed or control otherwise. */
  private songWindow: Window | null = null;
  /** Set once the transport has connected at least once, so we can tell a
   * fresh connect apart from a reconnect after a drop. */
  private hasConnectedBefore = false;
  state: GameState = {
    connected: false,
    pub: null,
    priv: null,
    code: null,
    error: null,
    serverOffset: 0,
  };

  constructor() {
    this.socket = io({ path: SOCKET_PATH, autoConnect: true });
    this.socket.on('connect', () => {
      const isReconnect = this.hasConnectedBefore;
      this.hasConnectedBefore = true;
      this.patch({ connected: true });
      // socket.io transparently reconnects the transport, but that does NOT
      // re-run room:join / receiver:subscribe server-side — the server has no
      // idea this new connection belongs to the room it just dropped from.
      // Without this, a player disconnected mid-game (screen lock, backgrounded
      // tab, brief WiFi drop) stays a ghost with nothing on screen telling them
      // to act. Re-establish membership using what got us here the first time.
      if (!isReconnect) return;
      if (this.state.priv?.playerId) {
        const code = this.savedCode();
        const name = this.savedName();
        if (code && name) void this.join(code, name);
      } else if (this.state.code) {
        void this.receiverSubscribe(this.state.code);
      }
    });
    this.socket.on('disconnect', () => this.patch({ connected: false }));
    this.socket.on('room:state', (pub: PublicRoom) =>
      this.patch({ pub, serverOffset: Date.now() - pub.serverNow }),
    );
    this.socket.on('you:state', (priv: PrivateState) => this.patch({ priv }));
    this.socket.on('host:created', ({ code }: { code: string }) => this.patch({ code }));
    this.socket.on('error', ({ message }: { message: string }) => this.patch({ error: message }));
    this.socket.on('room:closed', () =>
      this.patch({ pub: null, priv: null, error: 'Room closed.' }),
    );
    this.socket.on('cast:roomCode', ({ code }: { code: string }) => this.receiverSubscribe(code));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private patch(p: Partial<GameState>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l());
  }
  private emit<T>(event: string, payload: unknown): Promise<Ack<T>> {
    return new Promise((resolve) =>
      this.socket.emit(event, payload, (ack: Ack<T>) => resolve(ack)),
    );
  }

  setError(error: string | null) {
    this.patch({ error });
  }

  // ---- saved identity for reconnection ----
  savedCode(): string | null {
    return localStorage.getItem(LS_CODE);
  }
  savedToken(): string | null {
    return localStorage.getItem(LS_TOKEN);
  }
  savedName(): string | null {
    return localStorage.getItem(LS_NAME);
  }
  clearSaved() {
    localStorage.removeItem(LS_CODE);
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_NAME);
  }

  // ---- host ----
  async hostCreate(canCast: boolean): Promise<string | null> {
    const res = await this.emit<{ code: string }>('host:create', { canCast });
    if (res.ok) {
      this.patch({ code: res.data.code });
      return res.data.code;
    }
    this.patch({ error: res.error });
    return null;
  }
  castStatus(connected: boolean) {
    this.socket.emit('host:castStatus', { connected });
  }

  // ---- join ----
  async join(code: string, displayName: string, canCast = false): Promise<boolean> {
    const token = this.savedToken() ?? undefined;
    const reconnectToken = this.savedCode() === code ? token : undefined;
    const res = await this.emit<{ playerId: string; reconnectToken: string }>('room:join', {
      code,
      displayName,
      reconnectToken,
      canCast,
    });
    if (res.ok) {
      localStorage.setItem(LS_CODE, code);
      localStorage.setItem(LS_TOKEN, res.data.reconnectToken);
      localStorage.setItem(LS_NAME, displayName);
      this.patch({ code, error: null });
      return true;
    }
    this.patch({ error: res.error });
    return false;
  }

  // ---- lobby ----
  updateSettings(patch: Partial<{ penalizeWrongAnswers: boolean }>) {
    this.socket.emit('game:settings', patch);
  }
  async start(): Promise<boolean> {
    const res = await this.emit('game:start', {});
    if (!res.ok) this.patch({ error: res.error });
    return res.ok;
  }
  async transferHost(playerId: string): Promise<boolean> {
    const res = await this.emit('host:transfer', { playerId });
    if (!res.ok) this.patch({ error: res.error });
    return res.ok;
  }

  // ---- YouTube Music tab ----
  openSongWindow(url: string) {
    this.songWindow = window.open(url, '_blank');
  }
  closeSongWindow() {
    try {
      this.songWindow?.close();
    } catch {
      // cross-origin tabs the user navigated away from can refuse close(); ignore.
    }
    this.songWindow = null;
  }

  // ---- rounds / play ----
  /** Host picks this round's categories: ROUND_SETUP -> ON_DECK. */
  async pickCategories(categoryIds: string[]): Promise<boolean> {
    const res = await this.emit('round:pickCategories', { categoryIds });
    if (!res.ok) this.patch({ error: res.error });
    return res.ok;
  }
  /** Arm the buzzers on the on-deck song, which the host has just played. */
  async startSong(songId: string): Promise<boolean> {
    const res = await this.emit('setlist:start', { songId });
    if (!res.ok) this.patch({ error: res.error });
    return res.ok;
  }
  /**
   * The buzz. Losing this race is normal, not an error worth a toast — the
   * broadcast projection flips the UI to locked regardless of ack ordering,
   * so we deliberately swallow "Already locked in."
   */
  async buzz(): Promise<boolean> {
    const res = await this.emit('buzz:press', {});
    if (!res.ok && res.error !== 'Already locked in.') this.patch({ error: res.error });
    return res.ok;
  }
  async judge(verdict: JudgeVerdict): Promise<boolean> {
    const res = await this.emit('judge:answer', verdict);
    if (!res.ok) this.patch({ error: res.error });
    return res.ok;
  }
  async revealQuestion(): Promise<boolean> {
    const res = await this.emit('question:reveal', {});
    if (!res.ok) this.patch({ error: res.error });
    return res.ok;
  }
  async nextQuestion(): Promise<boolean> {
    const res = await this.emit('question:next', {});
    if (!res.ok) this.patch({ error: res.error });
    return res.ok;
  }
  forceEnd() {
    this.socket.emit('host:forceEnd', {});
  }
  async rematch(): Promise<boolean> {
    const res = await this.emit('host:rematch', {});
    if (!res.ok) this.patch({ error: res.error });
    return res.ok;
  }

  // ---- receiver ----
  receiverStandby() {
    this.socket.emit('receiver:standby', {});
  }

  async receiverSubscribe(code: string): Promise<boolean> {
    const res = await this.emit('receiver:subscribe', { code });
    if (res.ok) {
      this.patch({ code });
      // Every code-delivery path (Cast messaging, server push, ?code= in the
      // URL) converges here. A successful subscribe means the receiver.html
      // HTTP-polling fallback is no longer needed — stop it so it can't reload
      // the page (a real socket disconnect) on top of a live session.
      const pollTimer = (window as unknown as { __castPollTimer?: number }).__castPollTimer;
      if (pollTimer) clearInterval(pollTimer);
    } else {
      this.patch({ error: res.error });
    }
    return res.ok;
  }
}

export const store = new GameStore();
