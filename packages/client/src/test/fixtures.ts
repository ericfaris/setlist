import {
  SONG_POINT_VALUE,
  type HostSetlistSection,
  type PrivateState,
  type PublicActiveQuestion,
  type PublicPlayer,
  type PublicRoom,
} from '@setlist/shared';

export function makePlayer(overrides: Partial<PublicPlayer> & { id: string }): PublicPlayer {
  return {
    displayName: overrides.id,
    connected: true,
    isHost: false,
    canHostCast: false,
    score: 0,
    joinOrder: 0,
    pendingJoin: false,
    ...overrides,
  };
}

/** Host-only setlist projection: `sections` sections of `per` songs each. */
export function makeHostSetlist(sections = 2, per = 3): HostSetlistSection[] {
  return Array.from({ length: sections }, (_, s) => ({
    title: `Category ${s}`,
    songs: Array.from({ length: per }, (_, q) => ({
      id: `s${s}q${q}`,
      title: `Song ${s}-${q}`,
      artist: `Artist ${s}-${q}`,
      videoId: `vid${s}${q}`.padEnd(11, 'x'),
      used: false,
    })),
  }));
}

export function makeActive(overrides: Partial<PublicActiveQuestion> = {}): PublicActiveQuestion {
  return {
    songId: 's0q2',
    sectionTitle: 'Category 0',
    value: SONG_POINT_VALUE,
    startedAt: Date.now(),
    lockedPlayerId: null,
    lockedOutPlayerIds: [],
    verdict: null,
    awarded: 0,
    revealed: false,
    answer: null,
    ...overrides,
  };
}

/** Minimal but structurally valid PublicRoom, defaulted to a 3-player ARMED phase. */
export function makePub(overrides: Partial<PublicRoom> = {}): PublicRoom {
  const players = overrides.players ?? [
    makePlayer({ id: 'p1', displayName: 'Eric', isHost: true, joinOrder: 0 }),
    makePlayer({ id: 'p2', displayName: 'Lincoln', joinOrder: 1 }),
    makePlayer({ id: 'p3', displayName: 'April', joinOrder: 2 }),
  ];
  return {
    code: '1234',
    phase: 'ARMED',
    settings: { penalizeWrongAnswers: true },
    players,
    active: makeActive(),
    songsTotal: 6,
    songsRemaining: 5,
    winnerPlayerIds: [],
    castConnected: true,
    pause: { active: false, reason: null, waitingForPlayerId: null },
    serverNow: Date.now(),
    ...overrides,
  };
}

/** Minimal but structurally valid PrivateState for a non-host player. */
export function makePriv(overrides: Partial<PrivateState> = {}): PrivateState {
  return {
    playerId: 'p2',
    reconnectToken: 'tok',
    isHost: false,
    score: 0,
    canBuzz: true,
    hostAnswer: null,
    setlist: null,
    ...overrides,
  };
}
