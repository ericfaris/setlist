import { useEffect, useRef, useState } from 'react';
import { useGame } from '../common/useGame.js';
import { store } from '../common/store.js';
import { initCast, isCastSupported, type CastController } from '../common/cast.js';
import { useWakeLock } from '../common/useWakeLock.js';
import { BoardPick, BuzzScreen, GameOver, Lobby, Paused, Reveal } from './screens.js';

type View = 'landing' | 'host' | 'join';

interface Config {
  castReceiverAppId: string;
  publicBaseUrl: string;
  appVersion: string;
}

/** Small corner tag so a host can tell at a glance which build is live —
 * deploys wipe in-memory rooms with no other visible record. */
function VersionTag({ version }: { version?: string }) {
  if (!version) return null;
  return (
    <div
      className="muted"
      style={{ position: 'fixed', bottom: 6, right: 10, fontSize: '0.7rem', opacity: 0.6 }}
    >
      v{version}
    </div>
  );
}

export default function App() {
  const g = useGame();
  const [view, setView] = useState<View>('landing');
  const [config, setConfig] = useState<Config | null>(null);
  const cast = useRef<CastController | null>(null);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then(setConfig)
      .catch(() =>
        setConfig({
          castReceiverAppId: '',
          publicBaseUrl: window.location.origin,
          appVersion: '',
        }),
      );
  }, []);

  // deep-link join: /join?code=1234 or ?code=1234
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('code')) setView('join');
  }, []);

  const joined = !!g.priv?.playerId && !!g.pub;

  if (joined) {
    return (
      <>
        <InGame />
        <VersionTag version={config?.appVersion} />
      </>
    );
  }

  return (
    <div className="app center">
      <div className="stack" style={{ width: '100%' }}>
        <div className="center-text stack">
          <div className="title">🎵 Setlist</div>
          <div className="muted">Buzz in on your phone · board on the TV</div>
        </div>
        {g.error && <ErrorBanner message={g.error} />}
        {view === 'landing' && (
          <Landing onHost={() => setView('host')} onJoin={() => setView('join')} />
        )}
        {view === 'host' && (
          <HostFlow config={config} castRef={cast} onBack={() => setView('landing')} />
        )}
        {view === 'join' && <JoinFlow onBack={() => setView('landing')} />}
      </div>
      <VersionTag version={config?.appVersion} />
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="banner spread">
      <span>{message}</span>
      <button className="ghost small" onClick={() => store.setError(null)}>
        ✕
      </button>
    </div>
  );
}

function Landing({ onHost, onJoin }: { onHost: () => void; onJoin: () => void }) {
  const supported = isCastSupported();
  return (
    <div className="card stack">
      {!supported && (
        <div className="banner">
          Hosting to a Chromecast needs <b>Chrome on desktop or Android</b>. You can still host
          with the "Open TV view" fallback, or join a game from this browser.
        </div>
      )}
      <button className="primary" onClick={onHost}>
        📺 Host a Game
      </button>
      <button onClick={onJoin}>🎮 Join a Game</button>
    </div>
  );
}

function HostFlow({
  config,
  castRef,
  onBack,
}: {
  config: Config | null;
  castRef: React.MutableRefObject<CastController | null>;
  onBack: () => void;
}) {
  const g = useGame();
  const [stage, setStage] = useState<'cast' | 'name'>('cast');
  const [name, setName] = useState(store.savedName() ?? '');
  const [busy, setBusy] = useState(false);

  const code = g.code;

  async function beginCast() {
    setBusy(true);
    try {
      // 1) create the room (gets the code), 2) open the Cast picker with it
      const newCode = await store.hostCreate(true);
      if (!newCode) {
        setBusy(false);
        return;
      }
      if (!castRef.current) castRef.current = await initCast(config?.castReceiverAppId ?? '');
      const ctrl = castRef.current;
      if (ctrl) {
        ctrl.onConnectionChange((connected) => store.castStatus(connected));
        try {
          await ctrl.start(newCode);
          store.castStatus(true);
          setStage('name');
        } catch {
          store.setError('Cast was cancelled. Try again or use the local TV view.');
        }
      } else {
        // No Cast SDK (non-Chrome / blocked) — the local TV view below covers it.
        store.setError('Cast unavailable in this browser — use "Open TV view".');
      }
    } finally {
      setBusy(false);
    }
  }

  async function createRoomOnly() {
    setBusy(true);
    try {
      await store.hostCreate(false);
    } finally {
      setBusy(false);
    }
  }

  /** The linchpin of local play and of every acceptance test: no Chromecast needed. */
  function openLocalTv() {
    if (!code) return;
    window.open(`/receiver.html?code=${code}`, '_blank', 'noopener');
    store.castStatus(true);
    setStage('name');
  }

  if (stage === 'name') {
    return (
      <div className="card stack">
        <div className="h2">TV connected · Code {code}</div>
        <div className="muted small">Enter your name to join the lobby as a player.</div>
        <input
          value={name}
          placeholder="Your name"
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && store.join(code!, name.trim(), true)}
        />
        <button
          className="primary"
          disabled={!name.trim()}
          onClick={() => store.join(code!, name.trim(), true)}
        >
          Enter lobby
        </button>
      </div>
    );
  }

  return (
    <div className="card stack">
      <div className="h2">Put the game on a TV</div>
      <div className="muted small">
        Tapping below opens Chrome's Cast picker. The TV shows the join code &amp; QR.
      </div>
      <button className="primary" disabled={busy} onClick={beginCast}>
        {busy ? 'Connecting…' : '📺 Choose Chromecast'}
      </button>
      {!code && (
        <button disabled={busy} onClick={createRoomOnly}>
          No Chromecast — just make me a room
        </button>
      )}
      {code && (
        <div className="notice stack">
          <div className="small muted">
            No Chromecast handy? Open the TV view in a browser tab (e.g. a laptop on the big
            screen):
          </div>
          <button onClick={openLocalTv}>Open TV view (code {code})</button>
        </div>
      )}
      <button className="ghost small" onClick={onBack}>
        ← Back
      </button>
    </div>
  );
}

function JoinFlow({ onBack }: { onBack: () => void }) {
  const params = new URLSearchParams(window.location.search);
  const [code, setCode] = useState(params.get('code') ?? '');
  const [name, setName] = useState(store.savedName() ?? '');
  const [busy, setBusy] = useState(false);

  async function join() {
    setBusy(true);
    const ok = await store.join(code.trim(), name.trim(), isCastSupported());
    if (!ok) setBusy(false);
  }

  return (
    <div className="card stack">
      <div className="h2">Join a Game</div>
      <label className="stack small">
        <span className="muted">Room code</span>
        <input
          value={code}
          inputMode="numeric"
          maxLength={4}
          placeholder="4-digit code"
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      </label>
      <label className="stack small">
        <span className="muted">Your name</span>
        <input value={name} placeholder="Your name" onChange={(e) => setName(e.target.value)} />
      </label>
      <button
        className="primary"
        disabled={busy || code.length !== 4 || !name.trim()}
        onClick={join}
      >
        Join
      </button>
      <button className="ghost small" onClick={onBack}>
        ← Back
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- In-game
/** Persistent code + TV-connection status, visible on every in-game screen
 * (not just Lobby) — without this, a TV that drops mid-game (tab closed,
 * refreshed, network blip) can't be reconnected without the host already
 * remembering the 4-digit code from memory. */
function TvStatusStrip({ pub, isHost }: { pub: import('@setlist/shared').PublicRoom; isHost: boolean }) {
  if (pub.phase === 'LOBBY') return null; // Lobby already shows its own code + status.
  return (
    <div className="spread small" style={{ opacity: 0.85 }}>
      <span className="pill">Code {pub.code}</span>
      <span className={pub.castConnected ? 'muted' : 'banner'}>
        {pub.castConnected ? '📺 TV connected' : '⚠️ TV disconnected'}
        {isHost && !pub.castConnected && (
          <button
            style={{ marginLeft: 8 }}
            onClick={() => window.open(`/receiver.html?code=${pub.code}`, '_blank', 'noopener')}
          >
            Reopen TV view
          </button>
        )}
      </span>
    </div>
  );
}

function InGame() {
  const g = useGame();
  const pub = g.pub!;
  const priv = g.priv!;
  const isHost = !!pub.players.find((p) => p.id === priv.playerId)?.isHost;

  // Whole rounds pass with nobody touching their phone — keep the screen awake
  // or a sleeping device can't buzz.
  useWakeLock(true);

  return (
    <div className="app stack">
      {!g.connected && <div className="banner">Reconnecting…</div>}
      {g.error && <ErrorBanner message={g.error} />}
      <TvStatusStrip pub={pub} isHost={isHost} />
      {pub.phase === 'LOBBY' && <Lobby pub={pub} priv={priv} />}
      {pub.phase === 'BOARD' && <BoardPick pub={pub} priv={priv} />}
      {(pub.phase === 'PLAYING' || pub.phase === 'LOCKED') && (
        <BuzzScreen pub={pub} priv={priv} />
      )}
      {pub.phase === 'REVEAL' && <Reveal pub={pub} priv={priv} />}
      {pub.phase === 'GAME_OVER' && <GameOver pub={pub} priv={priv} />}
      {pub.phase === 'PAUSED' && <Paused pub={pub} />}
    </div>
  );
}
