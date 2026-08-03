import { useEffect, useMemo, useState } from 'react';
import { youtubeMusicUrl, type HostSetlistSong, type PrivateState, type PublicRoom } from '@setlist/shared';
import { store } from '../common/store.js';
import { nameOf } from '../common/ui.js';

function me(pub: PublicRoom, priv: PrivateState) {
  return pub.players.find((p) => p.id === priv.playerId) ?? null;
}

/** Every in-game screen carries the scores; a party game with hidden scores is no fun. */
export function ScoreStrip({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const sorted = [...pub.players].sort((a, b) => b.score - a.score || a.joinOrder - b.joinOrder);
  return (
    <div className="stack" style={{ gap: 6 }}>
      {sorted.map((p) => (
        <div key={p.id} className={`scorerow${p.id === priv.playerId ? ' me' : ''}`}>
          <span>
            {p.displayName}
            {p.isHost ? ' 👑' : ''}
            {!p.connected ? ' 📴' : ''}
            {p.pendingJoin ? ' ⏳' : ''}
          </span>
          <b>{p.score}</b>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Lobby
export function Lobby({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const self = me(pub, priv);
  const isHost = !!self?.isHost;
  const canStart = isHost && pub.castConnected;

  return (
    <div className="stack">
      <div className="card stack">
        <div className="spread">
          <div className="h2">Lobby</div>
          <div className="pill">Code {pub.code}</div>
        </div>
        <div className="small muted">
          {pub.castConnected ? '📺 TV connected' : '⚠️ Waiting for the TV…'}
        </div>
      </div>

      <div className="card stack">
        <div className="h2">Players</div>
        {pub.players.map((p) => (
          <div key={p.id} className="spread">
            <span>
              👤 {p.displayName} {p.isHost && <span className="pill">host</span>}
              {!p.connected && <span className="pill">offline</span>}
            </span>
            {isHost && !p.isHost && p.connected && (
              <button className="ghost small" onClick={() => store.transferHost(p.id)}>
                Make host
              </button>
            )}
          </div>
        ))}
      </div>

      {isHost && (
        <div className="card stack">
          <div className="h2">Settings</div>
          <label className="spread">
            <span>Penalise a wrong answer (−½ the value)</span>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={pub.settings.penalizeWrongAnswers}
              onChange={(e) => store.updateSettings({ penalizeWrongAnswers: e.target.checked })}
            />
          </label>
          <button className="primary" disabled={!canStart} onClick={() => store.start()}>
            {pub.castConnected ? 'Start game' : 'Waiting for the TV…'}
          </button>
        </div>
      )}
      {!isHost && (
        <div className="card center-text muted">
          Waiting for {nameOf(pub, pub.players.find((p) => p.isHost)?.id ?? null)} to start…
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Setlist
/**
 * The host browses the setlist and taps a song. Tapping is deliberately pure
 * CLIENT state — the server learns nothing until "Start round", which is what
 * makes "buzzing is never live merely from having tapped a song" structurally
 * true rather than merely enforced.
 */
export function SetlistScreen({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const self = me(pub, priv);
  const isHost = !!self?.isHost;
  const hostName = nameOf(pub, pub.players.find((p) => p.isHost)?.id ?? null);
  const [cued, setCued] = useState<HostSetlistSong | null>(null);
  const [query, setQuery] = useState('');

  // Returning to the setlist after a round must start from the list, never a
  // stale cue panel.
  useEffect(() => {
    if (pub.phase !== 'SETLIST') setCued(null);
  }, [pub.phase]);

  const sections = priv.setlist;
  const filtered = useMemo(() => {
    if (!sections) return [];
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections
      .map((sec) => ({
        ...sec,
        songs: sec.songs.filter(
          (song) =>
            song.title.toLowerCase().includes(q) || song.artist.toLowerCase().includes(q),
        ),
      }))
      .filter((sec) => sec.songs.length > 0);
  }, [sections, query]);

  // Non-host (and the TV's own idea of it): never render a single song title.
  if (!isHost) {
    return (
      <div className="stack">
        <div className="card center-text">🎧 {hostName} is choosing a song…</div>
        <ScoreStrip pub={pub} priv={priv} />
      </div>
    );
  }

  if (cued) {
    const sectionTitle =
      sections?.find((sec) => sec.songs.some((song) => song.id === cued.id))?.title ?? '';
    return (
      <div className="stack">
        <div className="card stack">
          <div>
            <b>{cued.title}</b>
          </div>
          <div className="muted">{cued.artist}</div>
          <div className="small muted">{sectionTitle}</div>
          <a
            className="primary"
            href={youtubeMusicUrl(cued.videoId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            ▶ Open in YouTube Music
          </a>
          <button className="primary" onClick={() => void store.startSong(cued.id)}>
            🔔 Start round — arm buzzers
          </button>
          <button className="ghost small" onClick={() => setCued(null)}>
            ← Back to setlist
          </button>
          <div className="small muted">Play it out loud first, then arm the buzzers.</div>
        </div>
        <ScoreStrip pub={pub} priv={priv} />
      </div>
    );
  }

  if (!sections) {
    return (
      <div className="stack">
        <div className="card center-text muted">Loading setlist…</div>
        <ScoreStrip pub={pub} priv={priv} />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card stack">
        <div className="h2">Pick a song</div>
        <input
          value={query}
          placeholder="Search songs or artists"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="setlist">
          {filtered.map((sec) => (
            <div key={sec.title} className="stack" style={{ gap: 4 }}>
              <div className="sechead">
                {sec.title} · {sec.songs.filter((song) => !song.used).length} left
              </div>
              {sec.songs.map((song) =>
                song.used ? (
                  <div key={song.id} className="song used">
                    <b>{song.title}</b>
                    <div className="muted small">
                      {song.artist} · ✓ played
                    </div>
                  </div>
                ) : (
                  <button key={song.id} className="song" onClick={() => setCued(song)}>
                    <b>{song.title}</b>
                    <div className="muted small">{song.artist}</div>
                  </button>
                ),
              )}
            </div>
          ))}
        </div>
        <button className="ghost small" onClick={() => store.forceEnd()}>
          🏁 End game &amp; show scores
        </button>
      </div>
      <ScoreStrip pub={pub} priv={priv} />
    </div>
  );
}

// ---------------------------------------------------------------- Buzz
export function BuzzScreen({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const active = pub.active;
  const self = me(pub, priv);
  const isHost = !!self?.isHost;
  // Optimistic "sent" feedback only. The server projection is the truth — we
  // never render "you won the race" from local state.
  const [sent, setSent] = useState(false);

  if (!active) return null;
  const lockedBy = active.lockedPlayerId;
  const lockedByMe = lockedBy === priv.playerId;
  const lockedOut = active.lockedOutPlayerIds.includes(priv.playerId ?? '');

  let cls = 'buzz';
  let label = 'BUZZ';
  let disabled = false;
  if (lockedByMe) {
    cls += ' mine';
    label = "🎤 You're in! Answer out loud";
    disabled = true;
  } else if (lockedBy) {
    cls += ' locked';
    label = `🔒 ${nameOf(pub, lockedBy)} buzzed in`;
    disabled = true;
  } else if (lockedOut) {
    cls += ' out';
    label = '❌ You already guessed';
    disabled = true;
  } else if (isHost) {
    // The host picked and played this song — don't leave them staring at a
    // dead red button with no explanation.
    cls += ' out';
    label = "👑 You're hosting this one";
    disabled = true;
  } else if (!priv.canBuzz) {
    disabled = true;
  } else if (sent) {
    label = '…';
  }

  return (
    <div className="stack">
      <div className="card nowplaying">
        <div className="spread">
          <b>{active.sectionTitle}</b>
          <span className="pill">{active.value} pts</span>
        </div>
        <div className="small muted">Name that song… and the artist!</div>
      </div>

      <button
        className={cls}
        disabled={disabled}
        // pointerdown, not click: fewer milliseconds between the thumb and the
        // wire, and this is a race.
        onPointerDown={() => {
          if (disabled) return;
          setSent(true);
          void store.buzz().finally(() => setSent(false));
        }}
      >
        {label}
      </button>

      {isHost && pub.phase === 'LOCKED' && <HostJudge pub={pub} priv={priv} />}
      {isHost && pub.phase === 'ARMED' && (
        <button onClick={() => void store.revealQuestion()}>🔎 Nobody got it — reveal</button>
      )}

      <ScoreStrip pub={pub} priv={priv} />
    </div>
  );
}

/** Host-only judging panel: the answer, who buzzed, and the four verdicts.
 * The answer is not shown the instant someone locks in — including when the
 * host is the one who buzzed — the host must tap to reveal it, so whoever
 * buzzed gets a real chance to answer out loud first instead of the screen
 * spoiling it for them. */
export function HostJudge({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const active = pub.active;
  const questionKey = active ? active.songId : null;
  const [revealedFor, setRevealedFor] = useState<string | null>(null);
  if (!active || !priv.isHost) return null;
  const judge = (titleCorrect: boolean, artistCorrect: boolean) =>
    void store.judge({ titleCorrect, artistCorrect });
  const revealed = revealedFor === questionKey;

  return (
    <div className="card stack">
      <div className="h2">🔒 {nameOf(pub, active.lockedPlayerId)} buzzed in</div>
      {revealed && priv.hostAnswer ? (
        <div className="notice stack" style={{ gap: 4 }}>
          <div className="small muted">The answer</div>
          <div>
            <b>{priv.hostAnswer.title}</b>
          </div>
          <div className="muted">{priv.hostAnswer.artist}</div>
        </div>
      ) : (
        <button onClick={() => setRevealedFor(questionKey)}>
          👁 Reveal answer — wait until they've answered out loud
        </button>
      )}
      <div className="grid2">
        <button className="good" onClick={() => judge(true, true)}>
          Both ✓
        </button>
        <button onClick={() => judge(true, false)}>Title only</button>
        <button onClick={() => judge(false, true)}>Artist only</button>
        <button className="bad" onClick={() => judge(false, false)}>
          Both ✗
        </button>
      </div>
      <button className="ghost small" onClick={() => void store.revealQuestion()}>
        Reveal &amp; move on
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Reveal
export function Reveal({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const active = pub.active;
  const self = me(pub, priv);
  const isHost = !!self?.isHost;
  if (!active) return null;

  return (
    <div className="stack">
      <div className="card stack center-text">
        <div className="small muted">
          {active.sectionTitle} · {active.value} pts
        </div>
        <div className="title">{active.answer?.title ?? '—'}</div>
        <div className="muted">{active.answer?.artist ?? ''}</div>
        {active.lockedPlayerId && active.verdict ? (
          <div>
            {nameOf(pub, active.lockedPlayerId)}{' '}
            {active.awarded >= 0 ? `+${active.awarded}` : active.awarded}
          </div>
        ) : (
          <div className="muted">Nobody got it.</div>
        )}
      </div>
      {isHost && (
        <button className="primary" onClick={() => void store.nextQuestion()}>
          Next →
        </button>
      )}
      <ScoreStrip pub={pub} priv={priv} />
    </div>
  );
}

// ---------------------------------------------------------------- Game over
export function GameOver({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const self = me(pub, priv);
  const isHost = !!self?.isHost;
  const winners = pub.winnerPlayerIds.map((id) => nameOf(pub, id));
  return (
    <div className="stack">
      <div className="card stack center-text">
        <div className="title">🏆 {winners.join(' & ') || 'Nobody'} wins</div>
      </div>
      <ScoreStrip pub={pub} priv={priv} />
      {isHost && (
        <button className="primary" onClick={() => void store.rematch()}>
          Rematch
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Paused
export function Paused({ pub }: { pub: PublicRoom }) {
  const reason = pub.pause.reason;
  const who = pub.pause.waitingForPlayerId ? nameOf(pub, pub.pause.waitingForPlayerId) : null;
  return (
    <div className="card center-text stack">
      <div className="title">⏸ Paused</div>
      <div className="muted">
        {reason === 'CAST_DROPPED'
          ? 'Reconnecting to the TV…'
          : who
            ? `Waiting for ${who} to reconnect…`
            : 'Waiting to resume…'}
      </div>
    </div>
  );
}
