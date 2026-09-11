/**
 * Tiny sound-effect bus for the "xerox mixtape zine" identity.
 *
 * - One <audio> per cue, preloaded, cloned on play so rapid repeats overlap.
 * - Muted state lives in localStorage so it survives reloads (a TV that
 *   refreshes shouldn't start blaring again). Defaults to ON.
 * - play() swallows autoplay-policy rejections: a surface that never got a
 *   user gesture simply stays silent, which is never worth blocking on.
 */

export type Sfx = 'arm' | 'buzz' | 'lock' | 'correct' | 'wrong' | 'reveal' | 'streak';

const FILES: Record<Sfx, string> = {
  arm: '/sounds/arm.mp3',
  buzz: '/sounds/buzz.mp3',
  lock: '/sounds/lock.mp3',
  correct: '/sounds/correct.mp3',
  wrong: '/sounds/wrong.mp3',
  reveal: '/sounds/reveal.mp3',
  streak: '/sounds/streak.mp3',
};

const VOL: Partial<Record<Sfx, number>> = { buzz: 0.9, arm: 0.7, lock: 0.85 };

const STORAGE_KEY = 'setlist.muted';

function readMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

let muted = readMuted();
const listeners = new Set<(m: boolean) => void>();

const pool: Partial<Record<Sfx, HTMLAudioElement>> = {};
function base(name: Sfx): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null;
  if (!pool[name]) {
    const a = new Audio(FILES[name]);
    a.preload = 'auto';
    a.volume = VOL[name] ?? 1;
    pool[name] = a;
  }
  return pool[name]!;
}

/** Warm the cache. Safe to call on mount; does nothing server-side. */
export function preloadSfx(): void {
  (Object.keys(FILES) as Sfx[]).forEach(base);
}

export function playSfx(name: Sfx): void {
  if (muted) return;
  const src = base(name);
  if (!src) return;
  const node = src.cloneNode() as HTMLAudioElement;
  node.volume = src.volume;
  node.play().catch(() => undefined);
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(next: boolean): void {
  muted = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    /* private mode — in-memory only */
  }
  listeners.forEach((fn) => fn(muted));
}

export function toggleMuted(): void {
  setMuted(!muted);
}

/** Subscribe to mute changes; returns an unsubscribe. */
export function onMuteChange(fn: (m: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
