import { useEffect, useRef, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { ON_FIRE_STREAK, type PublicRoom } from '@setlist/shared';
import { useGame } from '../common/useGame.js';
import { store } from '../common/store.js';
import { MuteToggle, nameOf } from '../common/ui.js';
import { playSfx } from '../common/sfx.js';

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
  const [toasts, setToasts] = useState<{ id: string; text: string }[]>([]);

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

  // "On fire" toast: fires once per player, exactly when their streak first
  // CROSSES the threshold (not on every correct answer after — the flame ring
  // on their chip, below, is the ongoing signal for that). Lives up here
  // rather than inside Scores: Scores is nested in whichever *TV component the
  // phase is currently rendering, so it remounts fresh on every phase change
  // and would forget a player is already on fire, re-toasting them on the
  // next reveal.
  const prevStreaks = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const players = g.pub?.players ?? [];
    const prev = prevStreaks.current;
    for (const p of players) {
      const before = prev.get(p.id) ?? 0;
      if (p.streak >= ON_FIRE_STREAK && before < ON_FIRE_STREAK) {
        const id = `${p.id}-${Date.now()}`;
        setToasts((t) => [...t, { id, text: `🔥 ${p.displayName} is on fire!` }]);
        playSfx('streak');
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
      }
      prev.set(p.id, p.streak);
    }
  }, [g.pub?.players]);

  let content: ReactNode;
  if (!g.pub) {
    const castError = (window as any).__castInitError as string | null;
    content = (
      <div className="tv center">
        <img
          src="/img/wordmark.png"
          alt="Setlist"
          style={{ width: '46vw', mixBlendMode: 'multiply', transform: 'rotate(-1.5deg)' }}
        />
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
      <MuteToggle corner="tr" />
      <VersionTag version={appVersion} />
      <OnFireToasts toasts={toasts} />
    </>
  );
}

/** Stacks top-center, above everything, on every screen — a streak doesn't
 * pause for whatever phase the board happens to be in. */
function OnFireToasts({ toasts }: { toasts: { id: string; text: string }[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}

function Scores({ pub }: { pub: PublicRoom }) {
  // The host never plays — showing them on the TV scoreboard alongside actual
  // contestants is just confusing. Player phones still show the host in the
  // roster (via ScoreStrip) since a player might want to know who's running
  // the game; the TV only cares about who's competing.
  const contestants = pub.players.filter((p) => !p.pendingJoin && !p.isHost);
  const best = Math.max(0, ...contestants.map((p) => p.score));
  return (
    <div className="scores">
      {contestants.map((p) => {
        const onFire = p.streak >= ON_FIRE_STREAK;
        return (
          <div
            key={p.id}
            className={`scorecard${p.score === best && best > 0 ? ' leader' : ''}${onFire ? ' on-fire' : ''}`}
          >
            {/* Decoration only — the score itself is untouched below. */}
            {onFire && <span className="flame-badge">🔥</span>}
            <div className="nm">{p.displayName}</div>
            <div className="sc">{p.score}</div>
          </div>
        );
      })}
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
      <img
        src="/img/wordmark.png"
        alt="Setlist"
        style={{ width: '28vw', mixBlendMode: 'multiply', transform: 'rotate(-1.5deg)' }}
      />
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
  const locked = pub.phase === 'LOCKED';

  // Buzz-in chime: lets everyone in the room know the board just locked,
  // without them having to glance up. Fires once per lock (keyed on who
  // locked it in — clears back to null between locks on the same question).
  useEffect(() => {
    if (locked) playSfx('lock');
  }, [a?.lockedPlayerId, locked]);

  // Wrong-answer chime: the host judged someone out and the round re-armed
  // with buzzers still open (right/nobody-left cases go to REVEAL instead —
  // see the correct/nobodyGotIt chimes in RevealTV). lockedOutPlayerIds only
  // grows, so an increase — not just the phase flipping back to ARMED, which
  // also happens once at the very start of a fresh question — is the signal.
  const lockedOutCount = a?.lockedOutPlayerIds.length ?? 0;
  const prevLockedOutCount = useRef(lockedOutCount);
  useEffect(() => {
    if (lockedOutCount > prevLockedOutCount.current) playSfx('wrong');
    prevLockedOutCount.current = lockedOutCount;
  }, [lockedOutCount]);

  if (!a) return null;
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
    if (nobodyGotIt) playSfx('wrong');
  }, [a?.songId, nobodyGotIt]);
  // Correct-answer chime: whoever locked in got at least title or artist.
  // Also keyed on songId — the verdict object is new every question, so
  // without the songId key this would refire on unrelated re-renders once a
  // question resolves correct and then just sits in REVEAL.
  const anyCorrect = !!a?.verdict && (a.verdict.titleCorrect || a.verdict.artistCorrect);
  useEffect(() => {
    if (anyCorrect) playSfx('correct');
  }, [a?.songId, anyCorrect]);
  // The reveal sting fires once per question, right as the card flips up —
  // whether or not anyone got it (the correct/wrong cues layer on top).
  useEffect(() => {
    playSfx('reveal');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a?.songId]);
  // Server-proxied, keyed on the public songId — the videoId that drives it
  // never reaches this client. See /api/art in the server. A song this thin
  // bank doesn't have art for 404s; just hide it, don't show a broken image.
  const [artFailed, setArtFailed] = useState(false);
  useEffect(() => setArtFailed(false), [a?.songId]);
  if (!a) return null;
  const artUrl = `/api/art/${pub.code}/${a.songId}`;
  return (
    <div className="tv">
      <div className="spread">
        <div className="brand">{a.sectionTitle}</div>
        <div className="brand">{a.value} pts</div>
      </div>
      <div className="row reveal-row" style={{ flex: 1, alignItems: 'center', gap: '3vw' }}>
        {!artFailed && (
          <img
            className="reveal-art"
            src={artUrl}
            alt=""
            onError={() => setArtFailed(true)}
          />
        )}
        <div className="stack center-text" style={{ flex: 1 }}>
          <div className="big reveal-title">{a.answer?.title ?? '—'}</div>
          <div className="sub reveal-artist">{a.answer?.artist ?? ''}</div>
          {a.lockedPlayerId && a.verdict && (
            <div className="sub">
              {nameOf(pub, a.lockedPlayerId)} {a.awarded >= 0 ? `+${a.awarded}` : a.awarded}
            </div>
          )}
        </div>
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
