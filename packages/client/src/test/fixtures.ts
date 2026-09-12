import {
  SONG_POINT_VALUE,
  SONGS_PER_CATEGORY_PER_ROUND,
  type CategoryPicker,
  type HostSong,
  type PrivateState,
  type PublicActiveQuestion,
  type PublicOnDeck,
  type PublicPlayer,
  type PublicRoom,
  type PublicRound,
} from '@setlist/shared';

export function makePlayer(overrides: Partial<PublicPlayer> & { id: string }): PublicPlayer {
  return {
    displayName: overrides.id,
    connected: true,
    isHost: false,
    canHostCast: false,
    score: 0,
    streak: 0,
    joinOrder: 0,
    pendingJoin: false,
    ...overrides,
  };
}

/** Host-only round picker: 2 groups x 3 categories, one short, one exhausted. */
export function makeCategoryPicker(overrides: Partial<CategoryPicker> = {}): CategoryPicker {
  return {
    roundNumber: 1,
    required: 2,
    perCategory: SONGS_PER_CATEGORY_PER_ROUND,
    groups: [
      {
        slug: 'genre',
        label: 'Genres',
        categories: [
          { id: 'cat_tax_genre__pop', title: 'Pop', available: 40 },
          { id: 'cat_tax_genre__rock', title: 'Rock', available: 2 },
          { id: 'cat_tax_genre__country', title: 'Country', available: 0 },
        ],
      },
      {
        slug: 'rock_sub',
        label: 'Rock sub-genres',
        categories: [
          { id: 'cat_tax_rock_sub__grunge', title: '90s Grunge', available: 30 },
          { id: 'cat_tax_rock_sub__punk', title: 'Punk', available: 12 },
          { id: 'cat_tax_rock_sub__yacht', title: 'Yacht Rock', available: 9 },
        ],
      },
    ],
    ...overrides,
  };
}

/** The public on-deck preview: category title and counters, nothing else. */
export function makeOnDeck(overrides: Partial<PublicOnDeck> = {}): PublicOnDeck {
  return {
    categoryTitle: 'Category 0',
    roundNumber: 1,
    indexInRound: 3,
    songsInRound: 10,
    ...overrides,
  };
}

export function makeRound(overrides: Partial<PublicRound> = {}): PublicRound {
  return { number: 1, songsTotal: 10, songsPlayed: 2, ...overrides };
}

/** Host-only on-deck song: the one place song data legitimately reaches a client. */
export function makeHostOnDeck(overrides: Partial<HostSong> = {}): HostSong {
  return {
    songId: 's0q2',
    title: 'Song 0-2',
    artist: 'Artist 0-2',
    videoId: 'vid02xxxxxx',
    ...overrides,
  };
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
    onDeck: null,
    round: makeRound(),
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
    hostVideoId: null,
    categoryPicker: null,
    hostOnDeck: null,
    ...overrides,
  };
}
