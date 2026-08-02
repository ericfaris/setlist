// The TV's audio. A single YT.Player instance is created once against the
// static #yt-player div in receiver.html and then only ever *commanded* through
// refs — re-creating it on a React re-render causes audio restarts, duplicate
// iframes and phantom onErrors.
//
// The iframe is deliberately invisible (see .ytstage/.ytshield in styles.css):
// the YouTube player chrome prints the song title, which is the answer.
import { useEffect, useRef, useState } from 'react';
import type { ReceiverPlayback } from '@setlist/shared';
import { store } from '../common/store.js';

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

/** Codes 101/150 mean "the owner disabled embedding" — very common for music. */
const ERROR_MESSAGES: Record<number, string> = {
  2: 'Invalid video id',
  5: 'The player cannot play this video',
  100: 'Video not found or private',
  101: 'Embedding disabled by the owner',
  150: 'Embedding disabled by the owner',
};

/** If the player never reaches PLAYING within this window, call it a failure. */
const STALL_TIMEOUT_MS = 5000;

function whenApiReady(cb: () => void): void {
  if (window.YT?.Player) return cb();
  const prev = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => {
    prev?.();
    cb();
  };
}

/**
 * The iframe carries the video's title in a `title` attribute — i.e. the
 * answer, sitting in the TV's DOM and one hover away from being a tooltip.
 * Nothing should ever see it, so blank it whenever YouTube rewrites it.
 */
function muzzleIframeTitle(): void {
  const iframe = document.querySelector<HTMLIFrameElement>('#yt-stage iframe');
  if (iframe && iframe.title !== '') iframe.title = '';
}

export function YouTubePlayer({ playback }: { playback: ReceiverPlayback | null }) {
  const player = useRef<any>(null);
  // State, not a ref: the player often becomes ready *after* the first
  // playback arrives, and the command effect below has to re-run when it does
  // or the very first clip of a game silently never loads.
  const [ready, setReady] = useState(false);
  const lastToken = useRef<number | null>(null);
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);

  // ---- create the player exactly once ----
  useEffect(() => {
    let disposed = false;
    whenApiReady(() => {
      if (disposed || player.current) return;
      const mount = document.getElementById('yt-player');
      if (!mount) return;
      player.current = new window.YT.Player('yt-player', {
        height: '270',
        width: '480',
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          rel: 0,
          iv_load_policy: 3,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            muzzleIframeTitle();
            setReady(true);
          },
          onStateChange: (e: { data: number }) => {
            muzzleIframeTitle();
            if (e.data === window.YT.PlayerState.PLAYING) {
              if (stallTimer.current) clearTimeout(stallTimer.current);
              stallTimer.current = null;
              setNeedsGesture(false);
            }
          },
          onError: (e: { data: number }) => {
            store.reportPlaybackError(
              `${ERROR_MESSAGES[e.data] ?? 'Playback error'} (${e.data})`,
            );
          },
        },
      });
    });
    return () => {
      disposed = true;
    };
  }, []);

  // ---- command it, keyed on playToken ----
  useEffect(() => {
    const p = player.current;
    if (!p || !ready) return;

    if (!playback) {
      lastToken.current = null;
      try {
        p.stopVideo?.();
      } catch {
        /* noop */
      }
      return;
    }

    if (playback.playToken !== lastToken.current) {
      lastToken.current = playback.playToken;
      try {
        p.loadVideoById({
          videoId: playback.videoId,
          startSeconds: playback.startSeconds,
        });
      } catch {
        /* noop */
      }
      // YouTube rewrites the iframe title to the video's title shortly after
      // a load — blank it again once that has happened.
      setTimeout(muzzleIframeTitle, 500);
      setTimeout(muzzleIframeTitle, 2000);
      // Unmuted autoplay is blocked in a plain browser tab (the local-fallback
      // path, which is how all local testing happens) until a user gesture.
      // Don't "fix" this by muting — a muted music game is no game.
      if (stallTimer.current) clearTimeout(stallTimer.current);
      stallTimer.current = setTimeout(() => {
        const state = player.current?.getPlayerState?.();
        if (state !== window.YT?.PlayerState?.PLAYING) setNeedsGesture(true);
      }, STALL_TIMEOUT_MS);
      return;
    }

    try {
      if (playback.paused) p.pauseVideo?.();
      else p.playVideo?.();
    } catch {
      /* noop */
    }
  }, [ready, playback?.playToken, playback?.paused, playback?.videoId, playback?.startSeconds, playback]);

  useEffect(
    () => () => {
      if (stallTimer.current) clearTimeout(stallTimer.current);
    },
    [],
  );

  if (!needsGesture) return null;
  return (
    <button
      className="audiocover"
      onClick={() => {
        setNeedsGesture(false);
        try {
          player.current?.playVideo?.();
        } catch {
          /* noop */
        }
      }}
    >
      ▶ Tap to enable audio
    </button>
  );
}
