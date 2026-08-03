// Runtime song substitution, end to end over real WebSockets with a fake
// YouTube search client. ZERO real network calls; no YOUTUBE_API_KEY required
// or read anywhere in this file.
import { afterEach, describe, expect, it } from 'vitest';
import { POINT_VALUES, type QuestionBank } from '@setlist/shared';
import {
  Client,
  deferred,
  fakeYouTube,
  makeRoom,
  startTestServer,
  tick,
  type FakeYouTube,
  type TestServer,
} from './harness.js';
import type { YouTubeSearchResult } from '../youtube.js';

const TITLE = 'Wichita Lineman';
const ARTIST = 'Glen Campbell';
const EXPECTED_QUERY = `${TITLE} ${ARTIST}`;

/**
 * Every question is the same song (different videoIds) so the test knows the
 * title/artist of whatever cell the board layout happens to pick.
 */
function uniformBank(): QuestionBank {
  return {
    version: 1,
    generatedAt: '2026-01-01T00:00:00Z',
    source: 'fixture',
    categories: Array.from({ length: 5 }, (_, c) => ({
      id: `cat_${c}`,
      title: `Category ${c}`,
      playlistId: `PL${c}`,
      questions: Array.from({ length: 5 }, (_, q) => ({
        id: `q_c${c}q${q}`,
        title: TITLE,
        artist: ARTIST,
        videoId: `orig${c}${q}xxxxx`,
        album: null,
        durationSeconds: 240,
        value: POINT_VALUES[q]!,
        startSeconds: null,
      })),
    })),
  };
}

const ALT_1 = 'altoneaaaaa';
const ALT_2 = 'alttwobbbbb';
const ALT_3 = 'altthreecc';

/** Three good candidates, ranked ALT_1 > ALT_2 > ALT_3, plus noise the
 * matcher must throw away. */
function goodResults(): YouTubeSearchResult[] {
  return [
    { videoId: 'junkccccccc', title: 'Completely Different Song', channelTitle: 'Some Channel' },
    { videoId: ALT_1, title: `${TITLE} (Official Audio)`, channelTitle: `${ARTIST} - Topic` },
    { videoId: 'karaokedddd', title: `${TITLE} (Karaoke Version)`, channelTitle: `${ARTIST} - Topic` },
    { videoId: ALT_2, title: `${TITLE} (Lyric Video)`, channelTitle: `${ARTIST} Fan Uploads` },
    { videoId: ALT_3, title: TITLE, channelTitle: ARTIST },
  ];
}

let server: TestServer;
afterEach(async () => {
  if (server) await server.close();
});

async function boot(yt: FakeYouTube | null, clipDurationSeconds?: number) {
  server = await startTestServer({ bank: uniformBank(), youtube: yt, clipDurationSeconds });
  const room = await makeRoom(server.port, 2);
  const [host, guest] = room.players as [Client, Client];
  await host.emit('game:start', {});
  await host.emit('board:select', { categoryIndex: 0, rowIndex: 0 });
  await tick();
  return { ...room, host, guest };
}

/** Criterion 5: no candidate id — accepted or rejected — reaches a player. */
function expectNoLeak(host: Client, guest: Client, results: YouTubeSearchResult[]) {
  expect(host.priv?.receiverPlayback).toBeNull();
  expect(guest.priv?.receiverPlayback).toBeNull();
  for (const c of [host, guest]) {
    const serialized = JSON.stringify(c.pub);
    for (const r of results) expect(serialized).not.toContain(r.videoId);
    expect(serialized).not.toContain('orig');
  }
}

describe('runtime song substitution', () => {
  it('recovers on the first alternate with no host action', async () => {
    const yt = fakeYouTube(goodResults());
    const { receiver, host, guest, closeAll } = await boot(yt);

    const original = receiver.priv!.receiverPlayback!;
    expect(original.videoId).toMatch(/^orig/);

    receiver.socket.emit('receiver:playbackError', {
      message: 'Embedding disabled (150)',
      playToken: original.playToken,
    });
    await tick();

    // exactly one search, with the plain "title artist" query
    expect(yt.queries).toEqual([EXPECTED_QUERY]);
    // the substitute is playing, delivered purely by a playToken bump
    expect(receiver.priv?.receiverPlayback?.videoId).toBe(ALT_1);
    expect(receiver.priv!.receiverPlayback!.playToken).toBeGreaterThan(original.playToken);
    expect(host.pub?.active?.retrying).toBe(false);
    expect(host.pub?.active?.playbackError).toBeNull();
    expect(host.pub?.phase).toBe('PLAYING');
    expect(guest.priv?.canBuzz).toBe(true);
    expectNoLeak(host, guest, yt.results);
    closeAll();
  }, 20000);

  it('tries three alternates, then auto-skips with no host action', async () => {
    const yt = fakeYouTube(goodResults());
    const { receiver, host, guest, closeAll } = await boot(yt);

    // first failure -> candidate 1
    receiver.socket.emit('receiver:playbackError', {
      message: 'Embedding disabled (150)',
      playToken: receiver.priv!.receiverPlayback!.playToken,
    });
    await tick();
    expect(receiver.priv?.receiverPlayback?.videoId).toBe(ALT_1);

    // second failure -> candidate 2, with NO further search
    receiver.socket.emit('receiver:playbackError', {
      message: 'Embedding disabled (150)',
      playToken: receiver.priv!.receiverPlayback!.playToken,
    });
    await tick();
    expect(yt.queries).toHaveLength(1);
    expect(receiver.priv?.receiverPlayback?.videoId).toBe(ALT_2);

    // third failure -> candidate 3, still no further search
    receiver.socket.emit('receiver:playbackError', {
      message: 'Embedding disabled (150)',
      playToken: receiver.priv!.receiverPlayback!.playToken,
    });
    await tick();
    expect(yt.queries).toHaveLength(1);
    expect(receiver.priv?.receiverPlayback?.videoId).toBe(ALT_3);

    // fourth failure -> exhausted; every alternate also failed, so the room
    // auto-skips (reveals) instead of waiting on the host to notice and Skip
    receiver.socket.emit('receiver:playbackError', {
      message: 'Embedding disabled (150)',
      playToken: receiver.priv!.receiverPlayback!.playToken,
    });
    await tick();
    expect(yt.queries).toHaveLength(1);
    expect(host.pub?.active?.retrying).toBe(false);
    expect(host.pub?.phase).toBe('REVEAL');
    expect(host.pub?.active?.revealed).toBe(true);
    expectNoLeak(host, guest, yt.results);
    closeAll();
  }, 20000);

  it('rejects a result that is not plausibly the same song', async () => {
    const results: YouTubeSearchResult[] = [
      { videoId: 'unrelated11', title: 'Completely Different Song', channelTitle: 'Some Channel' },
    ];
    const yt = fakeYouTube(results);
    const { receiver, host, guest, closeAll } = await boot(yt);
    const original = receiver.priv!.receiverPlayback!.videoId;

    receiver.socket.emit('receiver:playbackError', { message: 'Embedding disabled (150)' });
    await tick();

    expect(yt.queries).toEqual([EXPECTED_QUERY]);
    expect(receiver.priv?.receiverPlayback?.videoId).toBe(original); // unchanged
    expect(host.pub?.active?.retrying).toBe(false);
    // no plausible candidate at all -> nothing left to try -> auto-reveal
    expect(host.pub?.phase).toBe('REVEAL');
    expectNoLeak(host, guest, results);
    closeAll();
  }, 20000);

  it('disables buzzing and shows retrying while the search is in flight', async () => {
    const yt = fakeYouTube(goodResults());
    const gate = deferred();
    yt.gate = gate.promise;
    const { receiver, host, guest, closeAll } = await boot(yt);

    receiver.socket.emit('receiver:playbackError', { message: 'Embedding disabled (150)' });
    await tick();

    // mid-search window
    expect(host.pub?.active?.retrying).toBe(true);
    expect(host.pub?.active?.playbackError).toBeNull();
    expect(guest.priv?.canBuzz).toBe(false);
    expect(await guest.emit('buzz:press', {})).toEqual({
      ok: false,
      error: 'Finding another version…',
    });
    expect(host.pub?.phase).toBe('PLAYING');
    expectNoLeak(host, guest, yt.results);

    gate.resolve();
    await tick();
    expect(host.pub?.active?.retrying).toBe(false);
    expect(receiver.priv?.receiverPlayback?.videoId).toBe(ALT_1);
    closeAll();
  }, 20000);

  it('suspends the clip-expiry timer while retrying', async () => {
    const yt = fakeYouTube(goodResults());
    const gate = deferred();
    yt.gate = gate.promise;
    // A 1-second clip: without the reconcileTimer suspension this would expire
    // mid-search and reveal the answer.
    const { receiver, host, closeAll } = await boot(yt, 1);

    receiver.socket.emit('receiver:playbackError', { message: 'Embedding disabled (150)' });
    await tick();
    await new Promise((r) => setTimeout(r, 1500));

    expect(host.pub?.phase).toBe('PLAYING');
    expect(host.pub?.active?.retrying).toBe(true);
    expect(host.pub?.active?.revealed).toBe(false);

    gate.resolve();
    await tick();
    // the substitute gets a fresh full clip (startedAt re-stamped)
    expect(host.pub?.phase).toBe('PLAYING');
    expect(receiver.priv?.receiverPlayback?.videoId).toBe(ALT_1);
    closeAll();
  }, 20000);

  it('ignores a search that resolves after the question has moved on', async () => {
    const yt = fakeYouTube(goodResults());
    const gate = deferred();
    yt.gate = gate.promise;
    const { receiver, host, guest, closeAll } = await boot(yt);

    receiver.socket.emit('receiver:playbackError', { message: 'Embedding disabled (150)' });
    await tick();
    expect(host.pub?.active?.retrying).toBe(true);

    // drive the room forward while the search is still pending
    expect(await host.emit('question:skip', {})).toEqual({ ok: true, data: {} });
    await tick();
    expect(await host.emit('question:next', {})).toEqual({ ok: true, data: {} });
    await tick();
    expect(await host.emit('board:select', { categoryIndex: 1, rowIndex: 1 })).toEqual({
      ok: true,
      data: {},
    });
    await tick();
    const fresh = receiver.priv!.receiverPlayback!;
    expect(fresh.videoId).toMatch(/^orig/);

    // ...now let the stale search land
    gate.resolve();
    await tick();
    await tick();

    expect(receiver.priv?.receiverPlayback?.videoId).toBe(fresh.videoId);
    expect(receiver.priv?.receiverPlayback?.playToken).toBe(fresh.playToken);
    expect(host.pub?.active?.retrying).toBe(false);
    expect(host.pub?.phase).toBe('PLAYING');
    expectNoLeak(host, guest, yt.results);
    closeAll();
  }, 20000);

  it('enforces the 3-attempt cap server-side against a spamming receiver', async () => {
    const yt = fakeYouTube(goodResults());
    const { receiver, host, guest, closeAll } = await boot(yt);

    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      receiver.socket.emit('receiver:playbackError', {
        message: 'Embedding disabled (150)',
        playToken: receiver.priv!.receiverPlayback!.playToken,
      });
      await tick();
      const vid = receiver.priv?.receiverPlayback?.videoId;
      if (vid && !vid.startsWith('orig')) seen.add(vid);
    }

    expect(yt.queries).toHaveLength(1); // exactly one search, ever
    expect(seen.size).toBeLessThanOrEqual(3);
    expect([...seen]).toEqual([ALT_1, ALT_2, ALT_3]);
    expect(host.pub?.active?.retrying).toBe(false);
    // every alternate also failed -> auto-revealed, not left waiting on the host
    expect(host.pub?.phase).toBe('REVEAL');
    expectNoLeak(host, guest, yt.results);
    closeAll();
  }, 20000);

  it('auto-reveals immediately when the search returns nothing', async () => {
    const yt = fakeYouTube([]);
    const { receiver, host, closeAll } = await boot(yt);
    const original = receiver.priv!.receiverPlayback!.videoId;

    receiver.socket.emit('receiver:playbackError', { message: 'Embedding disabled (150)' });
    await tick();

    // no candidates were ever found, so there's nothing to try -> reveal now
    expect(host.pub?.active?.retrying).toBe(false);
    expect(receiver.priv?.receiverPlayback?.videoId).toBe(original);
    expect(host.pub?.phase).toBe('REVEAL');
    expect(host.pub?.active?.revealed).toBe(true);
    closeAll();
  }, 20000);

  it('survives a search client that rejects', async () => {
    const yt = fakeYouTube(goodResults());
    yt.throws = true;
    const { receiver, host, closeAll } = await boot(yt);
    const original = receiver.priv!.receiverPlayback!.videoId;

    receiver.socket.emit('receiver:playbackError', { message: 'Embedding disabled (150)' });
    await tick();

    expect(host.pub?.active?.retrying).toBe(false);
    expect(receiver.priv?.receiverPlayback?.videoId).toBe(original);
    // a rejected search yields no candidates -> nothing to try -> reveal now
    expect(host.pub?.phase).toBe('REVEAL');
    expect(host.pub?.active?.revealed).toBe(true);
    closeAll();
  }, 20000);

  it('behaves exactly like today when no search client is configured', async () => {
    const { receiver, host, closeAll } = await boot(null);
    const original = receiver.priv!.receiverPlayback!.videoId;

    receiver.socket.emit('receiver:playbackError', { message: 'Embedding disabled (150)' });
    await tick();

    expect(host.pub?.active?.retrying).toBe(false);
    expect(host.pub?.active?.playbackError).toBe('Embedding disabled (150)');
    expect(receiver.priv?.receiverPlayback?.videoId).toBe(original);
    expect(await host.emit('question:skip', {})).toEqual({ ok: true, data: {} });
    await tick();
    expect(host.pub?.phase).toBe('REVEAL');
    closeAll();
  }, 20000);

  it('ignores a stale playback error from a superseded video', async () => {
    const yt = fakeYouTube(goodResults());
    const { receiver, host, closeAll } = await boot(yt);
    const staleToken = receiver.priv!.receiverPlayback!.playToken;

    receiver.socket.emit('receiver:playbackError', {
      message: 'Embedding disabled (150)',
      playToken: staleToken,
    });
    await tick();
    expect(receiver.priv?.receiverPlayback?.videoId).toBe(ALT_1);

    // a late onError from the ORIGINAL video, arriving after the substitute
    receiver.socket.emit('receiver:playbackError', {
      message: 'Embedding disabled (150)',
      playToken: staleToken,
    });
    await tick();

    expect(yt.queries).toHaveLength(1);
    expect(receiver.priv?.receiverPlayback?.videoId).toBe(ALT_1); // not bumped to ALT_2
    expect(host.pub?.active?.playbackError).toBeNull();
    closeAll();
  }, 20000);
});
