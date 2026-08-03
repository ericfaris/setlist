// The buzz button, the setlist browser and the host judging panel are the
// screens where a UI bug is a game bug: buzzing when you shouldn't be able to,
// or a non-host seeing the songs.
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

const { BuzzScreen, SetlistScreen, HostJudge, Reveal, Lobby } = await import('../screens.js');
const { store } = await import('../../common/store.js');
const { makePub, makePriv, makeActive, makePlayer, makeHostSetlist } = await import(
  '../../test/fixtures.js'
);

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

  it('shows the section and the flat value, never the song', () => {
    render(<BuzzScreen pub={makePub()} priv={makePriv()} />);
    expect(screen.getByText('Category 0')).toBeInTheDocument();
    expect(screen.getByText('100 pts')).toBeInTheDocument();
    expect(screen.getByText(/Name that song… and the artist!/)).toBeInTheDocument();
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

  it("tells the host they're hosting this one instead of a dead buzzer", () => {
    const spy = vi.spyOn(store, 'buzz').mockResolvedValue(true);
    render(
      <BuzzScreen
        pub={makePub()}
        priv={makePriv({ playerId: 'p1', isHost: true, canBuzz: false })}
      />,
    );
    const button = screen.getByRole('button', { name: "👑 You're hosting this one" });
    expect(button).toBeDisabled();
    fireEvent.pointerDown(button);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'BUZZ' })).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it('shows the host the title, artist and a YouTube Music link while armed', () => {
    render(
      <BuzzScreen
        pub={makePub()}
        priv={makePriv({
          playerId: 'p1',
          isHost: true,
          canBuzz: false,
          hostAnswer: { title: 'Song 0-0', artist: 'Artist 0-0' },
          hostVideoId: 'vid00xxxxxx',
        })}
      />,
    );
    expect(screen.getByText('Song 0-0')).toBeInTheDocument();
    expect(screen.getByText('Artist 0-0')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Open in YouTube Music/ });
    expect(link).toHaveAttribute('href', 'https://music.youtube.com/watch?v=vid00xxxxxx');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('gives the host a manual reveal while armed', () => {
    const spy = vi.spyOn(store, 'revealQuestion').mockResolvedValue(true);
    render(
      <BuzzScreen
        pub={makePub()}
        priv={makePriv({ playerId: 'p1', isHost: true, canBuzz: false })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Nobody got it — reveal/ }));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not dispatch when disabled', () => {
    const spy = vi.spyOn(store, 'buzz').mockResolvedValue(true);
    const pub = makePub({ phase: 'LOCKED', active: makeActive({ lockedPlayerId: 'p3' }) });
    render(<BuzzScreen pub={pub} priv={makePriv({ canBuzz: false })} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: /buzzed in/ }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('SetlistScreen', () => {
  const setlistPub = () => makePub({ phase: 'SETLIST', active: null });
  const hostPriv = () =>
    makePriv({ playerId: 'p1', isHost: true, canBuzz: false, setlist: makeHostSetlist() });

  it('shows the host section headers and tappable song rows', () => {
    render(<SetlistScreen pub={setlistPub()} priv={hostPriv()} />);
    expect(screen.getByText(/Category 0 · 3 left/)).toBeInTheDocument();
    expect(screen.getByText(/Category 1 · 3 left/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Song 0-0/ })).toBeInTheDocument();
    expect(screen.getByText('Artist 0-1')).toBeInTheDocument();
  });

  it('arms the round immediately when a song is tapped — no separate confirm step', () => {
    const spy = vi.spyOn(store, 'startSong').mockResolvedValue(true);
    render(<SetlistScreen pub={setlistPub()} priv={hostPriv()} />);
    fireEvent.click(screen.getByRole('button', { name: /Song 0-1/ }));
    expect(spy).toHaveBeenCalledWith('s0q1');
    // no "Start round" button ever exists — tapping the row is the whole action
    expect(screen.queryByRole('button', { name: /Start round/ })).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it('filters rows by the search box', () => {
    render(<SetlistScreen pub={setlistPub()} priv={hostPriv()} />);
    fireEvent.change(screen.getByPlaceholderText('Search songs or artists'), {
      target: { value: 'song 1-2' },
    });
    expect(screen.getByRole('button', { name: /Song 1-2/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Song 0-0/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Category 0 ·/)).not.toBeInTheDocument();
  });

  it('shows a non-host who is choosing, with NO song titles anywhere in the DOM', () => {
    const { container } = render(<SetlistScreen pub={setlistPub()} priv={makePriv()} />);
    expect(screen.getByText('🎧 Eric is choosing a song…')).toBeInTheDocument();
    const html = container.innerHTML;
    for (const section of makeHostSetlist()) {
      for (const song of section.songs) {
        expect(html).not.toContain(song.title);
        expect(html).not.toContain(song.artist);
        expect(html).not.toContain(song.videoId);
      }
    }
  });

  it('does not crash when the host projection has no setlist yet', () => {
    render(
      <SetlistScreen pub={setlistPub()} priv={makePriv({ playerId: 'p1', isHost: true })} />,
    );
    expect(screen.getByText('Loading setlist…')).toBeInTheDocument();
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

  it('reveals and moves on via the secondary button', () => {
    const spy = vi.spyOn(store, 'revealQuestion').mockResolvedValue(true);
    const priv = makePriv({
      playerId: 'p1',
      isHost: true,
      hostAnswer: { title: 'Take On Me', artist: 'a-ha' },
    });
    render(<HostJudge pub={lockedPub()} priv={priv} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reveal & move on' }));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('never shows a non-host the answer during the buzz screen', () => {
    render(<BuzzScreen pub={lockedPub()} priv={makePriv({ canBuzz: false })} />);
    expect(screen.queryByText('Take On Me')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Both ✓' })).not.toBeInTheDocument();
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
        awarded: 50,
        answer: { title: 'Take On Me', artist: 'a-ha' },
      }),
    });
    render(<Reveal pub={pub} priv={makePriv()} />);
    expect(screen.getByText('Take On Me')).toBeInTheDocument();
    expect(screen.getByText('April +50')).toBeInTheDocument();
    expect(screen.getByText(/Category 0 · 100 pts/)).toBeInTheDocument();
    // non-host has no Next button
    expect(screen.queryByRole('button', { name: 'Next →' })).not.toBeInTheDocument();
  });
});

describe('Lobby', () => {
  it('lets the host hand off the crown but disables start without a TV', () => {
    const pub = makePub({
      phase: 'LOBBY',
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
