import { useEffect } from 'react';

/**
 * Keeps the screen from sleeping while `active` (e.g. joined to a room, in
 * the lobby or mid-game) — players write clues and guess out loud, so the
 * screen is often untouched for stretches long enough to hit a device's
 * auto-lock timeout. The Wake Lock API auto-releases when the tab is
 * backgrounded, so we re-acquire on visibilitychange (e.g. after the OS's
 * own lock screen kicks in and the user unlocks back into the tab).
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void lock.release();
          return;
        }
        sentinel = lock;
      } catch {
        // Not fatal — e.g. denied, or device doesn't actually support it.
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !sentinel) void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void sentinel?.release();
    };
  }, [active]);
}
