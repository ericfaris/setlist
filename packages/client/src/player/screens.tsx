import { useEffect, useMemo, useState } from 'react';
import { youtubeMusicUrl, type PrivateState, type PublicRoom } from '@setlist/shared';
import { store } from '../common/store.js';
import { nameOf } from '../common/ui.js';
import { playSfx } from '../common/sfx.js';

function me(pub: PublicRoom, priv: PrivateState) {
  return pub.players.find((p) => p.id === priv.playerId) ?? null;
}

/** Every in-game screen carries the scores; a party game with hidden scores is
 * no fun. The host never plays, so — like the TV scoreboard — they're left off. */
export function ScoreStrip({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const sorted = [...pub.players]
    .filter((p) => !p.isHost)
    .sort((a, b) => b.score - a.score || a.joinOrder - b.joinOrder);
  return (
    <div className="stack" style={{ gap: 6 }}>
      {sorted.map((p) => (
        <div key={p.id} className={`scorerow${p.id === priv.playerId ? ' me' : ''}`}>
          <span>
            {p.displayName}
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

// ---------------------------------------------------------------- Round setup
/**
 * The host picks this round's categories. Grouping is decided SERVER-side (one
 * implementation, covered by the engine tests); this only renders it. Selection
 * is pure CLIENT state until "Start round" — the server learns nothing before
 * that, which is what keeps a half-made choice from moving the game on.
 */
export function RoundSetupScreen({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const hostName = nameOf(pub, pub.players.find((p) => p.isHost)?.id ?? null);
  const picker = priv.categoryPicker;
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);

  const searching = query.trim().length > 0;
  const groups = useMemo(() => {
    if (!picker) return [];
    const q = query.trim().toLowerCase();
    if (!q) return picker.groups;
    return picker.groups
      .map((g) => ({ ...g, categories: g.categories.filter((c) => c.title.toLowerCase().includes(q)) }))
      .filter((g) => g.categories.length > 0);
  }, [picker, query]);

  // Non-host players (and the TV's own idea of it) see no category list at all.
  if (!picker) {
    return (
      <div className="stack">
        <div className="card center-text">
          🎛 Round {pub.round?.number ?? 1} — {hostName} is picking this round&rsquo;s categories…
        </div>
        <ScoreStrip pub={pub} priv={priv} />
      </div>
    );
  }

  const required = picker.required;
  const complete = selected.length === required;
  const titleOf = (id: string) =>
    picker.groups.flatMap((g) => g.categories).find((c) => c.id === id)?.title ?? id;

  const toggle = (id: string) => {
    setSelected((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (cur.length >= required) return cur; // refused client-side
      return [...cur, id];
    });
  };

  // Sections start collapsed except the first with a match; a live search
  // expands everything so a hit is never hidden behind a closed section.
  const firstSlug = groups[0]?.slug;
  const isOpen = (slug: string) => searching || openGroups.has(slug) || slug === firstSlug;
  const toggleGroup = (slug: string) =>
    setOpenGroups((cur) => {
      const next = new Set(cur);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      // the default-open first section needs an explicit entry to be closable
      if (slug === firstSlug && !cur.has(slug)) next.delete(slug);
      return next;
    });

  return (
    <div className="stack">
      <div className="card stack">
        <div className="spread">
          <div className="h2">
            Round {picker.roundNumber} · pick {required} categories
          </div>
          <div className="pill">
            {selected.length} / {required} selected
          </div>
        </div>
        <div className="small muted">
          {picker.perCategory} songs from each, chosen at random.
        </div>
        {selected.length > 0 && (
          <div className="chiprow">
            {selected.map((id) => (
              <button key={id} className="chip" onClick={() => toggle(id)}>
                {titleOf(id)} ✕
              </button>
            ))}
          </div>
        )}
        <input
          value={query}
          placeholder="Search categories"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="setlist">
          {groups.map((group) => (
            <div key={group.slug} className="stack" style={{ gap: 4 }}>
              <button className="sechead" onClick={() => toggleGroup(group.slug)}>
                {isOpen(group.slug) ? '▾' : '▸'} {group.label} · {group.categories.length}
              </button>
              {isOpen(group.slug) &&
                group.categories.map((cat) => {
                  const picked = selected.includes(cat.id);
                  const exhausted = cat.available === 0;
                  const short = cat.available > 0 && cat.available < picker.perCategory;
                  return (
                    <button
                      key={cat.id}
                      className={`song${exhausted ? ' used' : ''}${picked ? ' picked' : ''}`}
                      disabled={exhausted}
                      onClick={() => toggle(cat.id)}
                    >
                      <b>
                        {picked ? '✓ ' : ''}
                        {cat.title}
                      </b>
                      <div className="muted small">
                        {exhausted
                          ? 'all played'
                          : short
                            ? `only ${cat.available} left`
                            : `${cat.available} songs`}
                      </div>
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
        <button
          className="primary"
          disabled={!complete || starting}
          onClick={() => {
            setStarting(true);
            void store.pickCategories(selected).finally(() => setStarting(false));
          }}
        >
          {complete ? `Start round ${picker.roundNumber}` : `Pick ${required - selected.length} more`}
        </button>
        <button className="ghost small" onClick={() => store.forceEnd()}>
          🏁 End game &amp; show scores
        </button>
      </div>
      <ScoreStrip pub={pub} priv={priv} />
    </div>
  );
}

// ---------------------------------------------------------------- On deck
/**
 * The next song, chosen by the server. Its CATEGORY is public — everyone sees
 * it, on the phone and the TV. Its title/artist/videoId reach the host's own
 * socket only, via `priv.hostOnDeck`, because the host has to play it.
 */
export function OnDeckScreen({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const self = me(pub, priv);
  const isHost = !!self?.isHost;
  const onDeck = pub.onDeck;
  const song = priv.hostOnDeck;
  const [arming, setArming] = useState(false);

  return (
    <div className="stack">
      <div className="card stack center-text">
        <div className="small muted">
          Round {onDeck?.roundNumber ?? pub.round?.number ?? 1} · song{' '}
          {onDeck?.indexInRound ?? 1} of {onDeck?.songsInRound ?? 0}
        </div>
        <div className="small muted">Next up</div>
        <div className="title">{onDeck?.categoryTitle ?? '—'}</div>
      </div>

      {isHost && song && (
        <div className="card stack" style={{ gap: 4 }}>
          <div className="small muted">Play this one</div>
          <div>
            <b>{song.title}</b>
          </div>
          <div className="muted">{song.artist}</div>
          <button
            className="primary"
            disabled={arming}
            // Opening the song IS starting the round — one tap, not two. We
            // open it via window.open() (not a plain link) so we keep a handle
            // to the tab and can close it later when the host judges or moves on.
            onClick={() => {
              playSfx('arm');
              store.openSongWindow(youtubeMusicUrl(song.videoId));
              setArming(true);
              void store.startSong(song.songId).finally(() => setArming(false));
            }}
          >
            ▶ Open in YouTube Music — arms the buzzers
          </button>
          {arming && <div className="small muted">Arming…</div>}
        </div>
      )}

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

  const lockedByMe = pub.active?.lockedPlayerId === priv.playerId;
  // A private "you're in!" cue on the phone that won the race — the room-wide
  // lock chime is the TV's job, this is just for the thumb that got there first.
  useEffect(() => {
    if (lockedByMe) {
      playSfx('lock');
      navigator.vibrate?.([20, 40, 20]);
    }
  }, [lockedByMe]);

  if (!active) return null;
  const lockedBy = active.lockedPlayerId;
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

      {isHost && priv.hostAnswer && priv.hostVideoId && (
        <div className="card stack" style={{ gap: 4 }}>
          <div className="small muted">You picked this one</div>
          <div>
            <b>{priv.hostAnswer.title}</b>
          </div>
          <div className="muted">{priv.hostAnswer.artist}</div>
          <button
            className="primary"
            onClick={() => store.openSongWindow(youtubeMusicUrl(priv.hostVideoId!))}
          >
            ▶ Open in YouTube Music
          </button>
        </div>
      )}

      <button
        className={cls}
        disabled={disabled}
        // pointerdown, not click: fewer milliseconds between the thumb and the
        // wire, and this is a race.
        onPointerDown={() => {
          if (disabled) return;
          playSfx('buzz');
          navigator.vibrate?.(35);
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
  const judge = (titleCorrect: boolean, artistCorrect: boolean) => {
    store.closeSongWindow();
    void store.judge({ titleCorrect, artistCorrect });
  };
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
        <button
          className="primary"
          onClick={() => {
            store.closeSongWindow();
            void store.nextQuestion();
          }}
        >
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
