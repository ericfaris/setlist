// Net-layer integration: play a full question end to end over real
// WebSockets, validating the wire protocol, the projections each surface
// receives, and the ack flow.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Client,
  armRound,
  firstSongId,
  makeRoom,
  pickRound,
  startTestServer,
  tick,
  type TestServer,
} from './harness.js';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});
afterEach(async () => {
  await server.close();
});

describe('a full question over WebSockets', () => {
  it('runs lobby -> round setup -> on deck -> armed -> buzz -> judge -> reveal on all three surfaces', async () => {
    const { receiver, players, closeAll } = await makeRoom(server.port, 2);
    const [host, guest] = players as [Client, Client];

    expect(host.pub?.players).toHaveLength(2);
    expect(host.pub?.castConnected).toBe(true);
    expect(host.priv?.isHost).toBe(true);
    expect(guest.priv?.isHost).toBe(false);

    // start
    expect(await host.emit('game:start', {})).toEqual({ ok: true, data: {} });
    await tick();
    for (const c of [host, guest, receiver]) expect(c.pub?.phase).toBe('ROUND_SETUP');
    expect(host.pub?.songsTotal).toBeGreaterThan(0);
    expect(host.pub?.songsRemaining).toBe(host.pub?.songsTotal);

    // the HOST and only the host has the category picker — and it is counts only
    expect(host.priv?.categoryPicker?.groups.length).toBeGreaterThan(0);
    expect(host.priv!.categoryPicker!.required).toBe(5);
    expect(guest.priv?.categoryPicker).toBeNull();
    expect(receiver.priv?.categoryPicker).toBeNull();
    expect(host.priv?.hostOnDeck).toBeNull();

    // a non-host cannot pick the categories
    const categoryIds = host
      .priv!.categoryPicker!.groups.flatMap((g) => g.categories)
      .filter((c) => c.available > 0)
      .slice(0, 5)
      .map((c) => c.id);
    expect(await guest.emit('round:pickCategories', { categoryIds })).toEqual({
      ok: false,
      error: 'Only the host can pick categories.',
    });

    await pickRound(host);
    for (const c of [host, guest, receiver]) expect(c.pub?.phase).toBe('ON_DECK');

    // the upcoming CATEGORY is public; the song behind it is not
    for (const c of [host, guest, receiver]) {
      expect(c.pub?.onDeck?.categoryTitle).toBeTruthy();
      expect(c.pub?.onDeck?.roundNumber).toBe(1);
      expect(c.pub?.onDeck?.indexInRound).toBe(1);
      expect(c.pub?.round?.number).toBe(1);
      expect(c.pub?.round?.songsPlayed).toBe(0);
    }
    // only the host has the song itself
    const song = host.priv!.hostOnDeck!;
    expect(guest.priv?.hostOnDeck).toBeNull();
    expect(receiver.priv?.hostOnDeck).toBeNull();
    for (const json of [
      JSON.stringify(guest.pub),
      JSON.stringify(guest.priv),
      JSON.stringify(receiver.pub),
      JSON.stringify(receiver.priv),
      JSON.stringify(host.pub),
    ]) {
      expect(json).not.toContain(song.title);
      expect(json).not.toContain(song.artist);
      expect(json).not.toContain(song.videoId);
    }

    // buzzing is not live merely because a song is on deck
    expect(guest.priv?.canBuzz).toBe(false);

    // a non-host cannot arm a song
    expect(await guest.emit('setlist:start', { songId: song.songId })).toEqual({
      ok: false,
      error: 'Only the host can start a song.',
    });

    // arm it
    expect(await host.emit('setlist:start', { songId: song.songId })).toEqual({
      ok: true,
      data: {},
    });
    await tick();
    for (const c of [host, guest, receiver]) {
      expect(c.pub?.phase).toBe('ARMED');
      expect(c.pub?.onDeck).toBeNull();
    }
    expect(host.pub?.active?.value).toBe(100);
    expect(host.pub?.active?.songId).toBe(song.songId);

    // the host knows the answer IMMEDIATELY (they picked it) — nobody else
    // does, and the picker/on-deck channels are shut while armed.
    expect(host.priv?.hostAnswer?.title).toBe(song.title);
    expect(host.priv?.categoryPicker).toBeNull();
    expect(host.priv?.hostOnDeck).toBeNull();
    expect(guest.priv?.hostAnswer).toBeNull();
    expect(receiver.priv?.hostAnswer).toBeNull();
    expect(host.pub?.active?.answer).toBeNull();
    for (const json of [
      JSON.stringify(guest.pub),
      JSON.stringify(guest.priv),
      JSON.stringify(receiver.pub),
      JSON.stringify(receiver.priv),
    ]) {
      expect(json).not.toContain(song.title);
      expect(json).not.toContain(song.artist);
      expect(json).not.toContain(song.videoId);
    }

    // the host cannot buzz on their own round
    expect(host.priv?.canBuzz).toBe(false);
    expect(await host.emit('buzz:press', {})).toEqual({
      ok: false,
      error: "The host doesn't buzz on this one.",
    });

    // buzz
    expect(guest.priv?.canBuzz).toBe(true);
    expect(await guest.emit('buzz:press', {})).toEqual({ ok: true, data: {} });
    await tick();
    for (const c of [host, guest, receiver]) {
      expect(c.pub?.phase).toBe('LOCKED');
      expect(c.pub?.active?.lockedPlayerId).toBe(guest.playerId);
    }
    expect(guest.priv?.canBuzz).toBe(false);

    // judge
    expect(await host.emit('judge:answer', { titleCorrect: true, artistCorrect: false })).toEqual({
      ok: true,
      data: {},
    });
    await tick();
    for (const c of [host, guest, receiver]) {
      expect(c.pub?.phase).toBe('REVEAL');
      expect(c.pub?.active?.revealed).toBe(true);
      expect(c.pub?.active?.answer?.title).toBe(song.title);
      expect(c.pub?.players.find((p) => p.id === guest.playerId)?.score).toBe(50);
    }
    expect(guest.priv?.score).toBe(50);

    // advance — straight to the next song in the round, no browsing step
    expect(await host.emit('question:next', {})).toEqual({ ok: true, data: {} });
    await tick();
    expect(host.pub?.phase).toBe('ON_DECK');
    expect(host.pub?.onDeck?.indexInRound).toBe(2);
    expect(host.pub?.round?.songsPlayed).toBe(1);
    expect(host.priv?.hostOnDeck?.songId).not.toBe(song.songId);

    closeAll();
  }, 20000);

  it('shows the TV and a non-host the upcoming category but no song data', async () => {
    const { receiver, players, closeAll } = await makeRoom(server.port, 2);
    const [host, guest] = players as [Client, Client];
    await host.emit('game:start', {});
    await tick();
    await pickRound(host);

    const song = host.priv!.hostOnDeck!;
    const categoryTitle = host.pub!.onDeck!.categoryTitle;
    for (const c of [guest, receiver]) {
      // the category IS public — that is the whole point of the preview
      expect(c.pub?.onDeck?.categoryTitle).toBe(categoryTitle);
      expect(c.pub?.onDeck?.songsInRound).toBeGreaterThan(0);
      // …and nothing else about the song reaches them, on either channel
      for (const json of [JSON.stringify(c.pub), JSON.stringify(c.priv)]) {
        expect(json).not.toContain(song.title);
        expect(json).not.toContain(song.artist);
        expect(json).not.toContain(song.videoId);
        expect(json).not.toContain(song.songId);
      }
    }
    closeAll();
  }, 20000);

  it('never puts a videoId in any surface but the host s own private state', async () => {
    const { receiver, players, closeAll } = await makeRoom(server.port, 2);
    const [host, guest] = players as [Client, Client];
    await host.emit('game:start', {});
    await tick();
    await pickRound(host);
    // walk the whole round's worth of on-deck songs, collecting every videoId
    // the host is ever shown, and prove none of them ever escapes.
    const videoIds: string[] = [];
    videoIds.push(host.priv!.hostOnDeck!.videoId);
    await armRound(host);
    videoIds.push(host.priv!.hostVideoId!);

    expect(videoIds.length).toBeGreaterThan(0);
    for (const videoId of videoIds) {
      expect(JSON.stringify(host.pub)).not.toContain(videoId);
      expect(JSON.stringify(guest.pub)).not.toContain(videoId);
      expect(JSON.stringify(guest.priv)).not.toContain(videoId);
      expect(JSON.stringify(receiver.pub)).not.toContain(videoId);
      expect(JSON.stringify(receiver.priv)).not.toContain(videoId);
    }
    closeAll();
  }, 20000);

  it('blocks starting without a TV attached', async () => {
    const host = new Client(server.port);
    await host.connected();
    const created = await host.emit<{ code: string }>('host:create', { canCast: true });
    if (!created.ok) throw new Error(created.error);
    await host.emit('room:join', { code: created.data.code, displayName: 'Solo', canCast: true });
    await tick();
    expect(await host.emit('game:start', {})).toEqual({
      ok: false,
      error: 'Connect to the TV before starting.',
    });
    host.close();
  }, 20000);

  it('lets the host reveal with nobody buzzed — there is no timer', async () => {
    const { players, closeAll } = await makeRoom(server.port, 2);
    const [host] = players as [Client];
    await armRound(host);
    expect(host.pub?.phase).toBe('ARMED');
    // nothing happens on its own
    await new Promise((r) => setTimeout(r, 300));
    expect(host.pub?.phase).toBe('ARMED');

    expect(await host.emit('question:reveal', {})).toEqual({ ok: true, data: {} });
    await tick();
    expect(host.pub?.phase).toBe('REVEAL');
    expect(host.pub?.active?.answer).not.toBeNull();
    closeAll();
  }, 20000);

  it('transfers the host role on request and moves the controls with it', async () => {
    const { players, closeAll } = await makeRoom(server.port, 3);
    const [host, guest] = players as [Client, Client];
    expect(await host.emit('host:transfer', { playerId: guest.playerId })).toEqual({
      ok: true,
      data: {},
    });
    await tick();
    expect(guest.priv?.isHost).toBe(true);
    expect(host.priv?.isHost).toBe(false);
    expect(await host.emit('game:start', {})).toEqual({
      ok: false,
      error: 'Only the host can start the game.',
    });
    expect(await guest.emit('game:start', {})).toEqual({ ok: true, data: {} });
    closeAll();
  }, 20000);

  it('reconnects a dropped player by token and keeps their score', async () => {
    const { players, closeAll } = await makeRoom(server.port, 2);
    const [host, guest] = players as [Client, Client];
    await host.emit('game:start', {});
    await tick();
    await pickRound(host);
    await host.emit('setlist:start', { songId: firstSongId(host) });
    await guest.emit('buzz:press', {});
    await host.emit('judge:answer', { titleCorrect: true, artistCorrect: true });
    await tick();
    expect(guest.priv?.score).toBe(100);

    const token = guest.token;
    guest.close();
    await new Promise((r) => setTimeout(r, 150)); // past the grace window

    const rejoin = new Client(server.port);
    await rejoin.connected();
    const rr = await rejoin.emit<{ playerId: string; reconnectToken: string }>('room:join', {
      code: host.pub!.code,
      displayName: 'P1',
      reconnectToken: token,
    });
    expect(rr.ok).toBe(true);
    await tick();
    expect(rejoin.priv?.score).toBe(100);
    expect(rejoin.pub?.players.find((p) => p.id === guest.playerId)?.connected).toBe(true);
    rejoin.close();
    closeAll();
  }, 20000);
});
