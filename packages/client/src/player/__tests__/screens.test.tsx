// The buzz button and the host judging panel are the two screens where a UI
// bug is a game bug: buzzing when you shouldn't be able to, or a non-host
// seeing the answer.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// screens.tsx imports the socket-backed `store` singleton, which opens a real
// socket.io connection on module load. Stub it out so tests don't hit network.
vi.mock('socket.io-client', () => ({
  io: () => ({
    on: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

const { BuzzScreen, BoardPick, HostJudge, Reveal, Lobby } = await import('../screens.js');
const { store } = await import('../../common/store.js');
const { makePub, makePriv, makeActive, makePlayer } = await import('../../test/fixtures.js');

describe('BuzzScreen', () => {
  it('is armed and dispatches a buzz on pointer down', () => {
    const spy = vi.spyOn(store, 'buzz').mockResolvedValue(true);
    render(<BuzzScreen pub={makePub()} priv={makePriv({ canBuzz: true })} />);
    const button = screen.getByRole('button', { name: 'BUZZ' });
    expect(button).toBeEnabled();
    fireEvent.pointerDown(button);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('shows who locked in and disables the button for everyone else', () => {
    const pub = makePub({
      phase: 'LOCKED',
      active: makeActive({ lockedPlayerId: 'p3' }),
    });
    render(<BuzzScreen pub={pub} priv={makePriv({ canBuzz: false })} />);
    const button = screen.getByRole('button', { name: '🔒 April buzzed in' });
    expect(button).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'BUZZ' })).not.toBeInTheDocument();
  });

  it('tells the winner they are in', () => {
    const pub = makePub({ phase: 'LOCKED', active: makeActive({ lockedPlayerId: 'p2' }) });
    render(<BuzzScreen pub={pub} priv={makePriv({ playerId: 'p2', canBuzz: false })} />);
    expect(screen.getByRole('button', { name: /You're in/ })).toBeDisabled();
  });

  it('disables the button for a player already locked out of this question', () => {
    const pub = makePub({ active: makeActive({ lockedOutPlayerIds: ['p2'] }) });
    render(<BuzzScreen pub={pub} priv={makePriv({ playerId: 'p2', canBuzz: false })} />);
    const button = screen.getByRole('button', { name: '❌ You already guessed' });
    expect(button).toBeDisabled();
  });

  it('does not dispatch when disabled', () => {
    const spy = vi.spyOn(store, 'buzz').mockResolvedValue(true);
    const pub = makePub({ phase: 'LOCKED', active: makeActive({ lockedPlayerId: 'p3' }) });
    render(<BuzzScreen pub={pub} priv={makePriv({ canBuzz: false })} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: /buzzed in/ }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('surfaces a receiver playback error to the room', () => {
    const pub = makePub({ active: makeActive({ playbackError: "Embedding disabled (150)" }) });
    render(<BuzzScreen pub={pub} priv={makePriv()} />);
    expect(screen.getByText(/Embedding disabled \(150\)/)).toBeInTheDocument();
  });
});

describe('HostJudge', () => {
  const lockedPub = () =>
    makePub({ phase: 'LOCKED', active: makeActive({ lockedPlayerId: 'p3' }) });

  it('does not show the answer until the host taps to reveal it', () => {
    const priv = makePriv({
      playerId: 'p1',
      isHost: true,
      hostAnswer: { title: 'Take On Me', artist: 'a-ha' },
    });
    render(<HostJudge pub={lockedPub()} priv={priv} />);
    expect(screen.queryByText('Take On Me')).not.toBeInTheDocument();
    for (const label of ['Both ✓', 'Title only', 'Artist only', 'Both ✗']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: /Reveal answer/ }));
    expect(screen.getByText('Take On Me')).toBeInTheDocument();
    expect(screen.getByText('a-ha')).toBeInTheDocument();
  });

  it('renders nothing for a non-host', () => {
    const { container } = render(<HostJudge pub={lockedPub()} priv={makePriv()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['Both ✓', { titleCorrect: true, artistCorrect: true }],
    ['Title only', { titleCorrect: true, artistCorrect: false }],
    ['Artist only', { titleCorrect: false, artistCorrect: true }],
    ['Both ✗', { titleCorrect: false, artistCorrect: false }],
  ])('%s emits the matching verdict', (label, verdict) => {
    const spy = vi.spyOn(store, 'judge').mockResolvedValue(true);
    const priv = makePriv({
      playerId: 'p1',
      isHost: true,
      hostAnswer: { title: 'Take On Me', artist: 'a-ha' },
    });
    render(<HostJudge pub={lockedPub()} priv={priv} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(spy).toHaveBeenCalledWith(verdict);
    spy.mockRestore();
  });

  it('never shows a non-host the answer during the buzz screen', () => {
    render(<BuzzScreen pub={lockedPub()} priv={makePriv({ canBuzz: false })} />);
    expect(screen.queryByText('Take On Me')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Both ✓' })).not.toBeInTheDocument();
  });
});

describe('BoardPick', () => {
  it('lets the host tap a square', () => {
    const spy = vi.spyOn(store, 'selectCell').mockResolvedValue(true);
    const pub = makePub({ phase: 'BOARD', active: null });
    render(<BoardPick pub={pub} priv={makePriv({ playerId: 'p1', isHost: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Category 1 for 300' }));
    expect(spy).toHaveBeenCalledWith(1, 2);
    spy.mockRestore();
  });

  it('shows a non-host who is picking, with no tappable squares', () => {
    const pub = makePub({ phase: 'BOARD', active: null });
    render(<BoardPick pub={pub} priv={makePriv()} />);
    expect(screen.getByText('🎧 Eric is picking…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /for 300/ })).not.toBeInTheDocument();
  });
});

describe('Reveal', () => {
  it('shows the answer and the delta to everyone', () => {
    const pub = makePub({
      phase: 'REVEAL',
      active: makeActive({
        revealed: true,
        lockedPlayerId: 'p3',
        verdict: { titleCorrect: true, artistCorrect: false },
        awarded: 150,
        answer: { title: 'Take On Me', artist: 'a-ha' },
      }),
    });
    render(<Reveal pub={pub} priv={makePriv()} />);
    expect(screen.getByText('Take On Me')).toBeInTheDocument();
    expect(screen.getByText('April +150')).toBeInTheDocument();
    // non-host has no Next button
    expect(screen.queryByRole('button', { name: 'Next →' })).not.toBeInTheDocument();
  });
});

describe('Lobby', () => {
  it('lets the host hand off the crown but disables start without a TV', () => {
    const pub = makePub({
      phase: 'LOBBY',
      board: null,
      active: null,
      castConnected: false,
      players: [
        makePlayer({ id: 'p1', displayName: 'Eric', isHost: true }),
        makePlayer({ id: 'p2', displayName: 'Lincoln', joinOrder: 1 }),
      ],
    });
    const spy = vi.spyOn(store, 'transferHost').mockResolvedValue(true);
    render(<Lobby pub={pub} priv={makePriv({ playerId: 'p1', isHost: true })} />);
    expect(screen.getByRole('button', { name: 'Waiting for the TV…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Make host' }));
    expect(spy).toHaveBeenCalledWith('p2');
    spy.mockRestore();
  });
});
