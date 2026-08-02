// Google Cast Web Sender integration. The Sender SDK only loads in Chrome on
// Android/desktop. We use it solely for the handshake — launching the receiver
// app and passing the room code — while the receiver opens its own WebSocket
// for game data.
//
// Ported from pinpoint's packages/client/src/common/cast.ts essentially
// verbatim; only CAST_NAMESPACE differs. The retry ladder in start() and the
// 8s SDK-load timeout are load-bearing, not defensive noise: the receiver is
// frequently not listening when the first message goes out.
import { CAST_NAMESPACE } from '@setlist/shared';

const SENDER_SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

declare global {
  interface Window {
    __onGCastApiAvailable?: (available: boolean) => void;
    cast?: any;
    chrome?: any;
  }
}

/** Best-effort detection of Cast Sender support (Chrome desktop/Android). */
export function isCastSupported(): boolean {
  const ua = navigator.userAgent;
  const isChrome = /Chrome/.test(ua) && !/Edg|OPR/.test(ua);
  return isChrome;
}

let sdkLoading: Promise<boolean> | null = null;

function loadSenderSdk(): Promise<boolean> {
  if (sdkLoading) return sdkLoading;
  sdkLoading = new Promise<boolean>((resolve) => {
    if (window.cast?.framework) return resolve(true);
    window.__onGCastApiAvailable = (available: boolean) => resolve(available);
    const script = document.createElement('script');
    script.src = SENDER_SDK;
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
    setTimeout(() => resolve(!!window.cast?.framework), 8000);
  });
  return sdkLoading;
}

export interface CastController {
  /** Open the device picker and launch the receiver, passing the room code. */
  start(code: string): Promise<void>;
  stop(): void;
  /** Notified when the session connects (true) or drops (false). */
  onConnectionChange(cb: (connected: boolean) => void): void;
}

export async function initCast(receiverAppId: string): Promise<CastController | null> {
  if (!isCastSupported()) return null;
  const ok = await loadSenderSdk();
  if (!ok || !window.cast?.framework) return null;

  const cast = window.cast;
  const chrome = window.chrome;
  const context = cast.framework.CastContext.getInstance();
  context.setOptions({
    receiverApplicationId: receiverAppId || chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });

  let connectionCb: ((connected: boolean) => void) | null = null;

  context.addEventListener(
    cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
    (event: any) => {
      const S = cast.framework.SessionState;
      if (event.sessionState === S.SESSION_STARTED || event.sessionState === S.SESSION_RESUMED) {
        connectionCb?.(true);
      } else if (
        event.sessionState === S.SESSION_ENDED ||
        event.sessionState === S.SESSION_START_FAILED
      ) {
        connectionCb?.(false);
      }
    },
  );

  return {
    async start(code: string) {
      await context.requestSession();
      const session = context.getCurrentSession();
      if (session) {
        const sendCode = () => {
          try {
            session.sendMessage(CAST_NAMESPACE, { type: 'room', code });
          } catch {
            /* noop */
          }
        };
        // Re-send when the receiver signals ready (most reliable path).
        try {
          session.addMessageListener(CAST_NAMESPACE, (_ns: string, msg: string) => {
            try {
              if (JSON.parse(msg)?.type === 'ready') sendCode();
            } catch {
              /* noop */
            }
          });
        } catch {
          /* noop */
        }
        // Also retry on a fixed schedule in case the ready signal is missed.
        sendCode();
        [500, 1500, 3000, 6000].forEach((ms) => setTimeout(sendCode, ms));
        connectionCb?.(true);
      }
    },
    stop() {
      try {
        context.endCurrentSession(true);
      } catch {
        /* noop */
      }
    },
    onConnectionChange(cb) {
      connectionCb = cb;
    },
  };
}

export { CAST_NAMESPACE };
