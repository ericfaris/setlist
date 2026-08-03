import { useState } from 'react';
import type { PrivateState, PublicRoom } from '@setlist/shared';
import { store } from '../common/store.js';
import { BoardGrid, ClipBar, nameOf } from '../common/ui.js';

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

// ---------------------------------------------------------------- Board
export function BoardPick({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const self = me(pub, priv);
  const isHost = !!self?.isHost;
  const hostName = nameOf(pub, pub.players.find((p) => p.isHost)?.id ?? null);

  return (
    <div className="stack">
      <div className="card stack">
        <div className="h2">{isHost ? 'Pick a square' : `🎧 ${hostName} is picking…`}</div>
        {pub.board && (
          <BoardGrid
            board={pub.board}
            onPick={isHost ? (c, r) => void store.selectCell(c, r) : undefined}
          />
        )}
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
  } else if (active.retrying) {
    // Ahead of the generic !canBuzz branch so the reason is explained rather
    // than the button just going dead. After the lock branches: a lock is a
    // stronger statement, and the two can't co-occur anyway.
    cls += ' out';
    label = '🔎 Finding another version…';
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
          <b>{active.categoryTitle}</b>
          <span className="pill">${active.value}</span>
        </div>
        <ClipBar startedAt={active.startedAt} durationSeconds={active.durationSeconds} />
        {active.retrying && (
          <div className="banner small">🔎 That track won't play — finding another version…</div>
        )}
        {!active.retrying && active.playbackError && (
          <div className="banner small">This track won't play: {active.playbackError}</div>
        )}
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
      {isHost && pub.phase === 'PLAYING' && (
        <div className="row">
          <button className="grow" onClick={() => void store.replayClip()}>
            🔁 Replay clip
          </button>
          <button className="grow" onClick={() => void store.skipQuestion()}>
            ⏭ Skip
          </button>
        </div>
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
  const questionKey = active ? `${active.cell.categoryIndex}:${active.cell.rowIndex}` : null;
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
      <button className="ghost small" onClick={() => void store.skipQuestion()}>
        Skip question
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
          {active.categoryTitle} · ${active.value}
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
