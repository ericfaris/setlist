import { useEffect, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import type { PublicRoom } from '@setlist/shared';
import { useGame } from '../common/useGame.js';
import { store } from '../common/store.js';
import { nameOf } from '../common/ui.js';

/** Small corner tag so a host can tell which build is live on the TV. Pinned
 * bottom-left so it never collides with the persistent join QR (bottom-right). */
function VersionTag({ version }: { version: string }) {
  if (!version) return null;
  return (
    <div
      className="muted"
      style={{ position: 'fixed', bottom: '1vh', left: '1vw', fontSize: '1vw', opacity: 0.5 }}
    >
      v{version}
    </div>
  );
}

/** Persistent join QR + code, bottom-right, on every screen except the Lobby
 * (which already shows a big one) — so latecomers can join mid-game without
 * the host having to back out to the lobby screen. */
function MiniJoinQr({ pub, baseUrl }: { pub: PublicRoom; baseUrl: string }) {
  const [qr, setQr] = useState('');
  useEffect(() => {
    const url = `${baseUrl}/?code=${pub.code}`;
    QRCode.toDataURL(url, { width: 200, margin: 1 })
      .then(setQr)
      .catch(() => undefined);
  }, [baseUrl, pub.code]);
  if (!qr) return null;
  return (
    <div
      style={{
        position: 'fixed',
        bottom: '1vh',
        right: '1vw',
        background: 'rgba(255,255,255,0.92)',
        borderRadius: 8,
        padding: '0.5vw',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.2vw',
      }}
    >
      <img src={qr} alt="Scan to join" style={{ width: '7vw', minWidth: 56, maxWidth: 110 }} />
      <div style={{ fontSize: '0.9vw', color: '#111', fontWeight: 700, letterSpacing: '0.05em' }}>
        {pub.code}
      </div>
    </div>
  );
}

export default function App() {
  const g = useGame();
  const [baseUrl, setBaseUrl] = useState(window.location.origin);
  const [appVersion, setAppVersion] = useState('');

  // Resolve base URL for QR codes; Cast and ?code= are handled in main.tsx.
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((c) => {
        if (c.publicBaseUrl) setBaseUrl(c.publicBaseUrl);
        if (c.appVersion) setAppVersion(c.appVersion);
      })
      .catch(() => undefined);

    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('code');
    if (fromQuery) void store.receiverSubscribe(fromQuery);
  }, []);

  let content: ReactNode;
  if (!g.pub) {
    const castError = (window as any).__castInitError as string | null;
    content = (
      <div className="tv center">
        <div className="huge">🎵 SETLIST</div>
        <div className="sub">Waiting for a room…</div>
        {castError && (
          <div className="muted" style={{ fontSize: '1.2vw', color: 'red', marginTop: '1vw' }}>
            Cast init error: {castError}
          </div>
        )}
      </div>
    );
  } else if (g.pub.phase === 'LOBBY') {
    content = <LobbyTV pub={g.pub} baseUrl={baseUrl} />;
  } else if (g.pub.phase === 'PAUSED') {
    content = <PausedTV pub={g.pub} />;
  } else if (g.pub.phase === 'GAME_OVER') {
    content = <GameOverTV pub={g.pub} />;
  } else if (g.pub.phase === 'REVEAL') {
    content = <RevealTV pub={g.pub} />;
  } else if (g.pub.phase === 'ARMED' || g.pub.phase === 'LOCKED') {
    content = <ArmedTV pub={g.pub} />;
  } else if (g.pub.phase === 'ROUND_SETUP') {
    content = <RoundSetupTV pub={g.pub} />;
  } else if (g.pub.phase === 'ON_DECK') {
    content = <OnDeckTV pub={g.pub} />;
  } else {
    content = null;
  }

  return (
    <>
      {content}
      {g.pub && g.pub.phase !== 'LOBBY' && <MiniJoinQr pub={g.pub} baseUrl={baseUrl} />}
      <VersionTag version={appVersion} />
    </>
  );
}

function Scores({ pub }: { pub: PublicRoom }) {
  const best = Math.max(0, ...pub.players.map((p) => p.score));
  return (
    <div className="scores">
      {pub.players
        .filter((p) => !p.pendingJoin)
        .map((p) => (
          <div key={p.id} className={`scorecard${p.score === best && best > 0 ? ' leader' : ''}`}>
            <div className="nm">
              {p.displayName}
              {p.isHost ? ' 👑' : ''}
            </div>
            <div className="sc">{p.score}</div>
          </div>
        ))}
    </div>
  );
}

function LobbyTV({ pub, baseUrl }: { pub: PublicRoom; baseUrl: string }) {
  const [qr, setQr] = useState('');
  useEffect(() => {
    const url = `${baseUrl}/?code=${pub.code}`;
    QRCode.toDataURL(url, { width: 360, margin: 1 })
      .then(setQr)
      .catch(() => undefined);
  }, [baseUrl, pub.code]);

  return (
    <div className="tv">
      <div className="brand">🎵 SETLIST</div>
      <div className="spread" style={{ flex: 1 }}>
        <div className="stack center-text">
          <div style={{ fontSize: '2vw' }} className="muted">
            Join at <b>{baseUrl.replace(/^https?:\/\//, '')}</b>
          </div>
          <div className="codebox">{pub.code}</div>
          <div className="muted" style={{ fontSize: '1.6vw' }}>
            {pub.players.filter((p) => !p.pendingJoin).length} players in lobby
          </div>
        </div>
        {qr && (
          <div className="qr">
            <img src={qr} alt="Join QR" />
          </div>
        )}
      </div>
      <div className="players">
        {pub.players.map((p) => (
          <div key={p.id} className="pchip">
            {p.displayName}
            {p.isHost ? ' 👑' : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Fire-and-forget one-shot SFX. Swallows autoplay-policy rejections — a TV
 * that never got a user gesture simply plays no chime, which is not worth
 * blocking anything on. */
function playOneShot(src: string): void {
  new Audio(src).play().catch(() => undefined);
}

function RoundSetupTV({ pub }: { pub: PublicRoom }) {
  const hostName = nameOf(pub, pub.players.find((p) => p.isHost)?.id ?? null);
  // How many categories this round needs is host-only (PrivateState). The TV
  // deliberately does not invent a public field for it.
  return (
    <div className="tv">
      <div className="brand">ROUND {pub.round?.number ?? 1}</div>
      <div className="stack center-text" style={{ flex: 1, justifyContent: 'center' }}>
        <div className="huge">🎛</div>
        <div className="sub">{hostName} is picking this round&rsquo;s categories…</div>
      </div>
      <Scores pub={pub} />
    </div>
  );
}

/** The money screen. Reads `pub` and nothing else: the only song-related thing
 *  that exists on this surface is the category name. */
function OnDeckTV({ pub }: { pub: PublicRoom }) {
  const onDeck = pub.onDeck;
  return (
    <div className="tv">
      <div className="brand">
        ROUND {onDeck?.roundNumber ?? pub.round?.number ?? 1} · {onDeck?.indexInRound ?? 1} of{' '}
        {onDeck?.songsInRound ?? 0}
      </div>
      <div className="stack center-text" style={{ flex: 1, justifyContent: 'center' }}>
        <div className="sub">Next up</div>
        <div className="huge">{onDeck?.categoryTitle ?? '—'}</div>
      </div>
      <Scores pub={pub} />
    </div>
  );
}

function ArmedTV({ pub }: { pub: PublicRoom }) {
  const a = pub.active;
  if (!a) return null;
  const locked = pub.phase === 'LOCKED';
  return (
    <div className="tv">
      <div className="spread">
        <div className="brand">{a.sectionTitle}</div>
        <div className="brand">{a.value} pts</div>
      </div>
      <div className="stack center-text" style={{ flex: 1, justifyContent: 'center' }}>
        {locked ? (
          <div className="huge">🔒 {nameOf(pub, a.lockedPlayerId)}</div>
        ) : (
          <>
            <div className="huge">🎧</div>
            <div className="sub">Name that song… and the artist!</div>
            <div className="sub">🔔 Buzzers live</div>
          </>
        )}
      </div>
      <Scores pub={pub} />
    </div>
  );
}

function RevealTV({ pub }: { pub: PublicRoom }) {
  const a = pub.active;
  // "Nobody got it": revealed with no lock and no verdict. Keyed on songId so
  // it fires exactly once per question.
  const nobodyGotIt = !!a && !a.lockedPlayerId && !a.verdict;
  useEffect(() => {
    if (nobodyGotIt) playOneShot('/sounds/times-up.mp3');
  }, [a?.songId, nobodyGotIt]);
  if (!a) return null;
  return (
    <div className="tv">
      <div className="spread">
        <div className="brand">{a.sectionTitle}</div>
        <div className="brand">{a.value} pts</div>
      </div>
      <div className="stack center-text" style={{ flex: 1, justifyContent: 'center' }}>
        <div className="big">{a.answer?.title ?? '—'}</div>
        <div className="sub">{a.answer?.artist ?? ''}</div>
        {a.lockedPlayerId && a.verdict && (
          <div className="sub">
            {nameOf(pub, a.lockedPlayerId)} {a.awarded >= 0 ? `+${a.awarded}` : a.awarded}
          </div>
        )}
      </div>
      <Scores pub={pub} />
    </div>
  );
}

function GameOverTV({ pub }: { pub: PublicRoom }) {
  const winners = pub.winnerPlayerIds.map((id) => nameOf(pub, id));
  return (
    <div className="tv">
      <div className="stack center-text" style={{ flex: 1, justifyContent: 'center' }}>
        <div className="huge">🏆</div>
        <div className="big">{winners.join(' & ') || 'Nobody'} wins!</div>
      </div>
      <Scores pub={pub} />
    </div>
  );
}

function PausedTV({ pub }: { pub: PublicRoom }) {
  return (
    <div className="tv center">
      <div className="codebox">⏸</div>
      <div className="brand">
        {pub.pause.reason === 'CAST_DROPPED'
          ? 'Reconnecting to TV…'
          : 'Paused — waiting for the host'}
      </div>
    </div>
  );
}
