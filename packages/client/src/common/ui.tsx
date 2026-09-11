import { useEffect, useState } from 'react';
import type { PublicRoom } from '@setlist/shared';
import { isMuted, onMuteChange, preloadSfx, toggleMuted } from './sfx.js';

export const nameOf = (pub: PublicRoom, id: string | null) =>
  (id && pub.players.find((p) => p.id === id)?.displayName) || '???';

/** A little taped-on speaker switch. `corner` keeps it clear of each surface's
 * own furniture — the phone's code pill (top-right) and the TV's brand. */
export function MuteToggle({ corner = 'bl' }: { corner?: 'tr' | 'bl' }) {
  const [muted, setMuted] = useState(isMuted());
  useEffect(() => {
    preloadSfx();
    return onMuteChange(setMuted);
  }, []);
  return (
    <button
      className={`mute-toggle mute-${corner}`}
      aria-pressed={muted}
      title={muted ? 'Sound off — tap for sound' : 'Sound on — tap to mute'}
      onClick={() => toggleMuted()}
    >
      {muted ? '🔇 Sound off' : '🔊 Sound on'}
    </button>
  );
}
