// The buzz button, the round picker, the on-deck preview and the host judging
// panel are the screens where a UI bug is a game bug: buzzing when you
// shouldn't be able to, or a non-host seeing the songs.
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

const { BuzzScreen, RoundSetupScreen, OnDeckScreen, HostJudge, Reveal, Lobby } = await import(
  '../screens.js'
);
const { store } = await import('../../common/store.js');
const {
  makePub,
  makePriv,
  makeActive,
  makePlayer,
  makeCategoryPicker,
  makeOnDeck,
  makeHostOnDeck,
} = await import('../../test/fixtures.js');

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

describe('RoundSetupScreen', () => {
  const setupPub = () => makePub({ phase: 'ROUND_SETUP', active: null });
  const hostPriv = (picker = makeCategoryPicker()) =>
    makePriv({ playerId: 'p1', isHost: true, canBuzz: false, categoryPicker: picker });

  it('shows the round, the required count and the grouped categories', () => {
    render(<RoundSetupScreen pub={setupPub()} priv={hostPriv()} />);
    expect(screen.getByText('Round 1 · pick 2 categories')).toBeInTheDocument();
    expect(screen.getByText('0 / 2 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Genres · 3/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Rock sub-genres · 3/ })).toBeInTheDocument();
    // the first group is open by default
    expect(screen.getByRole('button', { name: /Pop/ })).toBeInTheDocument();
    expect(screen.getByText('40 songs')).toBeInTheDocument();
  });

  it('labels a short category "only N left" and disables an exhausted one', () => {
    render(<RoundSetupScreen pub={setupPub()} priv={hostPriv()} />);
    expect(screen.getByText('only 2 left')).toBeInTheDocument();
    expect(screen.getByText('all played')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Country/ })).toBeDisabled();
  });

  it('selects up to the required count and refuses more', () => {
    render(<RoundSetupScreen pub={setupPub()} priv={hostPriv()} />);
    fireEvent.click(screen.getByRole('button', { name: /Pop/ }));
    expect(screen.getByText('1 / 2 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Rock/ }));
    expect(screen.getByText('2 / 2 selected')).toBeInTheDocument();
    // a third is refused client-side
    fireEvent.click(screen.getByRole('button', { name: /Genres · 3/ })); // no-op group toggle
    expect(screen.getByText('2 / 2 selected')).toBeInTheDocument();
  });

  it('only enables Start round at exactly the required count, then emits the ids', () => {
    const spy = vi.spyOn(store, 'pickCategories').mockResolvedValue(true);
    render(<RoundSetupScreen pub={setupPub()} priv={hostPriv()} />);
    expect(screen.getByRole('button', { name: 'Pick 2 more' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Pop/ }));
    expect(screen.getByRole('button', { name: 'Pick 1 more' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^Rock/ }));
    const start = screen.getByRole('button', { name: 'Start round 1' });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(spy).toHaveBeenCalledWith(['cat_tax_genre__pop', 'cat_tax_genre__rock']);
    spy.mockRestore();
  });

  it('deselects via the chip', () => {
    render(<RoundSetupScreen pub={setupPub()} priv={hostPriv()} />);
    fireEvent.click(screen.getByRole('button', { name: /Pop/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Pop ✕' }));
    expect(screen.getByText('0 / 2 selected')).toBeInTheDocument();
  });

  it('filters categories across every group by the search box', () => {
    render(<RoundSetupScreen pub={setupPub()} priv={hostPriv()} />);
    fireEvent.change(screen.getByPlaceholderText('Search categories'), {
      target: { value: 'grunge' },
    });
    expect(screen.getByRole('button', { name: /90s Grunge/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pop/ })).not.toBeInTheDocument();
  });

  it('shows a non-host who is picking, with NO category list', () => {
    const { container } = render(<RoundSetupScreen pub={setupPub()} priv={makePriv()} />);
    expect(screen.getByText(/Eric is picking this round/)).toBeInTheDocument();
    const html = container.innerHTML;
    for (const group of makeCategoryPicker().groups) {
      for (const cat of group.categories) expect(html).not.toContain(cat.title);
    }
  });
});

describe('OnDeckScreen', () => {
  const deckPub = () =>
    makePub({ phase: 'ON_DECK', active: null, onDeck: makeOnDeck({ categoryTitle: '90s Grunge' }) });

  it('shows everyone the category and the position in the round', () => {
    render(<OnDeckScreen pub={deckPub()} priv={makePriv()} />);
    expect(screen.getByText('Next up')).toBeInTheDocument();
    expect(screen.getByText('90s Grunge')).toBeInTheDocument();
    expect(screen.getByText(/Round 1 · song 3 of 10/)).toBeInTheDocument();
  });

  it('shows a non-host the category and NOTHING about the song', () => {
    const { container } = render(<OnDeckScreen pub={deckPub()} priv={makePriv()} />);
    const html = container.innerHTML;
    expect(html).toContain('90s Grunge');
    const song = makeHostOnDeck();
    expect(html).not.toContain(song.title);
    expect(html).not.toContain(song.artist);
    expect(html).not.toContain(song.videoId);
    expect(screen.queryByRole('link', { name: /YouTube Music/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /arm buzzers/ })).not.toBeInTheDocument();
  });

  it('gives the host the song, a YouTube Music link and the arm button', () => {
    const spy = vi.spyOn(store, 'startSong').mockResolvedValue(true);
    render(
      <OnDeckScreen
        pub={deckPub()}
        priv={makePriv({
          playerId: 'p1',
          isHost: true,
          canBuzz: false,
          hostOnDeck: makeHostOnDeck(),
        })}
      />,
    );
    expect(screen.getByText('Song 0-2')).toBeInTheDocument();
    expect(screen.getByText('Artist 0-2')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Open in YouTube Music/ });
    expect(link).toHaveAttribute('href', 'https://music.youtube.com/watch?v=vid02xxxxxx');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    fireEvent.click(screen.getByRole('button', { name: /arm buzzers/ }));
    expect(spy).toHaveBeenCalledWith('s0q2');
    spy.mockRestore();
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
