// Pure unit tests for the same-song matcher. No network, no engine.
import { describe, expect, it } from 'vitest';
import { normalize, pickCandidates, scoreCandidate, tokens } from '../songmatch.js';

const SONG = { title: 'Song 0-0', artist: 'Artist 0-0' };
const c = (videoId: string, title: string, channelTitle: string) => ({
  videoId,
  title,
  channelTitle,
});

describe('normalize / tokens', () => {
  it('strips diacritics, case and punctuation', () => {
    expect(normalize('Björk — Jóga (Official Video)')).toBe('bjork joga official video');
  });

  it('expands ampersands', () => {
    expect(normalize('Simon & Garfunkel')).toBe('simon and garfunkel');
  });

  it('drops stopwords and noise words', () => {
    expect(tokens('The Boxer (Official Audio) [Remastered]')).toEqual(['boxer']);
  });
});

describe('scoreCandidate', () => {
  it('accepts an official-audio upload on a Topic channel', () => {
    const s = scoreCandidate(SONG, c('alt1aaaaaaa', 'Song 0-0 (Official Audio)', 'Artist 0-0 - Topic'));
    expect(s.accepted).toBe(true);
  });

  it('rejects karaoke, covers and live versions outright', () => {
    for (const title of [
      'Song 0-0 (Karaoke Version)',
      'Song 0-0 - Instrumental',
      'Song 0-0 (cover)',
      'Song 0-0 — Live at Wembley',
      'Song 0-0 (Sped Up)',
    ]) {
      expect(scoreCandidate(SONG, c('xxxxxxxxxxx', title, 'Artist 0-0 - Topic')).accepted).toBe(
        false,
      );
    }
  });

  it('does not reject a title that merely contains "live" as a word', () => {
    const s = scoreCandidate(
      { title: 'Live and Let Die', artist: 'Wings' },
      c('vvvvvvvvvvv', 'Live and Let Die (Official Audio)', 'Wings - Topic'),
    );
    expect(s.accepted).toBe(true);
  });

  it('rejects a completely different song', () => {
    expect(
      scoreCandidate(SONG, c('yyyyyyyyyyy', 'Totally Other Track', 'Some Channel')).accepted,
    ).toBe(false);
  });

  it('rejects the right title by the wrong artist', () => {
    expect(
      scoreCandidate(
        { title: 'Wichita Lineman', artist: 'Glen Campbell' },
        c('zzzzzzzzzzz', 'Wichita Lineman', 'Nobody In Particular'),
      ).accepted,
    ).toBe(false);
  });

  it('requires an exact match for a one-word title', () => {
    const song = { title: 'Africa', artist: 'Toto' };
    expect(scoreCandidate(song, c('a1aaaaaaaaa', 'Africa', 'Toto - Topic')).accepted).toBe(true);
    expect(scoreCandidate(song, c('a2aaaaaaaaa', 'Amerika', 'Toto - Topic')).accepted).toBe(false);
  });

  it('ranks Topic-channel audio above the official music video', () => {
    const topic = scoreCandidate(SONG, c('t1ttttttttt', 'Song 0-0', 'Artist 0-0 - Topic'));
    const mv = scoreCandidate(SONG, c('m1mmmmmmmmm', 'Song 0-0 (Official Video)', 'Artist 0-0'));
    expect(topic.rank).toBeGreaterThan(mv.rank);
  });
});

describe('pickCandidates', () => {
  it('filters, ranks and caps at the limit', () => {
    const picked = pickCandidates(
      SONG,
      [
        c('mv111111111', 'Song 0-0 (Official Music Video)', 'Artist 0-0'),
        c('junk1111111', 'Completely Different Song', 'Some Channel'),
        c('topic111111', 'Song 0-0', 'Artist 0-0 - Topic'),
        c('lyric111111', 'Song 0-0 (Lyric Video)', 'Artist 0-0 Fan'),
        c('kar11111111', 'Song 0-0 Karaoke', 'Artist 0-0 - Topic'),
      ],
      { excludeVideoIds: [], limit: 2 },
    );
    expect(picked.map((p) => p.videoId)).toEqual(['topic111111', 'lyric111111']);
  });

  it('excludes the original videoId and anything already attempted', () => {
    const picked = pickCandidates(
      SONG,
      [
        c('origvid0000', 'Song 0-0 (Official Audio)', 'Artist 0-0 - Topic'),
        c('tried000000', 'Song 0-0 (Lyrics)', 'Artist 0-0 - Topic'),
        c('fresh000000', 'Song 0-0', 'Artist 0-0 - Topic'),
      ],
      { excludeVideoIds: ['origvid0000', 'tried000000'], limit: 2 },
    );
    expect(picked.map((p) => p.videoId)).toEqual(['fresh000000']);
  });

  it('returns nothing when every result is rejected', () => {
    const picked = pickCandidates(
      SONG,
      [
        c('a0000000000', 'Some Other Song', 'Random'),
        c('b0000000000', 'Song 0-0 (Karaoke)', 'Artist 0-0 - Topic'),
      ],
      { excludeVideoIds: [], limit: 2 },
    );
    expect(picked).toEqual([]);
  });

  it('dedupes repeated videoIds', () => {
    const dupe = c('dupe0000000', 'Song 0-0', 'Artist 0-0 - Topic');
    const picked = pickCandidates(SONG, [dupe, dupe], { excludeVideoIds: [], limit: 2 });
    expect(picked).toHaveLength(1);
  });
});
