import { useEffect, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import type { PublicRoom } from '@music-trivia/shared';
import { useGame } from '../common/useGame.js';
import { store } from '../common/store.js';
import { BoardGrid, ClipBar, nameOf } from '../common/ui.js';
import { YouTubePlayer } from './YouTubePlayer.js';

/** Small corner tag so a host can tell which build is live on the TV. */
function VersionTag({ version }: { version: string }) {
  if (!version) return null;
  return (
    <div
      className="muted"
      style={{ position: 'fixed', bottom: '1vh', right: '1vw', fontSize: '1vw', opacity: 0.5 }}
    >
      v{version}
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
        <div className="huge">🎵 MUSIC TRIVIA</div>
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
  } else if (g.pub.phase === 'PLAYING' || g.pub.phase === 'LOCKED') {
    content = <PlayingTV pub={g.pub} />;
  } else {
    content = <BoardTV pub={g.pub} />;
  }

  return (
    <>
      {content}
      {/* Always mounted: the player instance must survive every phase change. */}
      <YouTubePlayer playback={g.priv?.receiverPlayback ?? null} />
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
      <div className="brand">🎵 MUSIC TRIVIA</div>
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

function BoardTV({ pub }: { pub: PublicRoom }) {
  return (
    <div className="tv">
      <div className="brand">PICK A SQUARE</div>
      {pub.board && <BoardGrid board={pub.board} />}
      <Scores pub={pub} />
    </div>
  );
}

function PlayingTV({ pub }: { pub: PublicRoom }) {
  const a = pub.active;
  if (!a) return null;
  const locked = pub.phase === 'LOCKED';
  return (
    <div className="tv">
      <div className="spread">
        <div className="brand">{a.categoryTitle}</div>
        <div className="brand">${a.value}</div>
      </div>
      <div className="stack center-text" style={{ flex: 1, justifyContent: 'center' }}>
        {locked ? (
          <div className="huge">🔒 {nameOf(pub, a.lockedPlayerId)}</div>
        ) : (
          <>
            <div className="huge">🎧</div>
            <div className="sub">Name that song… and the artist!</div>
          </>
        )}
        {a.playbackError && <div className="sub">⚠️ {a.playbackError}</div>}
      </div>
      <ClipBar startedAt={a.startedAt} durationSeconds={a.durationSeconds} />
      <Scores pub={pub} />
    </div>
  );
}

function RevealTV({ pub }: { pub: PublicRoom }) {
  const a = pub.active;
  if (!a) return null;
  return (
    <div className="tv">
      <div className="spread">
        <div className="brand">{a.categoryTitle}</div>
        <div className="brand">${a.value}</div>
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
