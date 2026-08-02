import {
  POINT_VALUES,
  type BoardState,
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

export function makeBoard(columns = 3): BoardState {
  return {
    categories: Array.from({ length: columns }, (_, c) => ({
      id: `cat_${c}`,
      title: `Category ${c}`,
    })),
    cells: Array.from({ length: columns }, (_, c) =>
      POINT_VALUES.map((value, rowIndex) => ({
        categoryIndex: c,
        rowIndex,
        value,
        questionId: `c${c}r${rowIndex}`,
        used: false,
      })),
    ).flat(),
  };
}

export function makeActive(
  overrides: Partial<PublicActiveQuestion> = {},
): PublicActiveQuestion {
  return {
    cell: { categoryIndex: 0, rowIndex: 2, value: 300, questionId: 'c0r2', used: true },
    categoryTitle: 'Category 0',
    value: 300,
    startedAt: Date.now(),
    durationSeconds: 20,
    lockedPlayerId: null,
    lockedOutPlayerIds: [],
    verdict: null,
    awarded: 0,
    revealed: false,
    answer: null,
    playbackError: null,
    timedOut: false,
    ...overrides,
  };
}

/** Minimal but structurally valid PublicRoom, defaulted to a 3-player PLAYING phase. */
export function makePub(overrides: Partial<PublicRoom> = {}): PublicRoom {
  const players = overrides.players ?? [
    makePlayer({ id: 'p1', displayName: 'Eric', isHost: true, joinOrder: 0 }),
    makePlayer({ id: 'p2', displayName: 'Lincoln', joinOrder: 1 }),
    makePlayer({ id: 'p3', displayName: 'April', joinOrder: 2 }),
  ];
  return {
    code: '1234',
    phase: 'PLAYING',
    settings: { penalizeWrongAnswers: true },
    players,
    board: makeBoard(),
    active: makeActive(),
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
    receiverPlayback: null,
    ...overrides,
  };
}
