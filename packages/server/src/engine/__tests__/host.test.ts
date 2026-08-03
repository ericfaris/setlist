// The host role: assignment, gating, explicit transfer, and succession.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addPlayers,
  checkInvariants,
  armNext,
  makeEngine,
  onDeckSongId,
  pickRound,
  resetInvariantMemory,
  selectableCategoryIds,
  startedGame,
} from './harness.js';

beforeEach(resetInvariantMemory);

describe('host role', () => {
  it('makes the first joiner the host', () => {
    const { engine } = makeEngine(400);
    const seats = addPlayers(engine, 3);
    expect(engine.room.players.find((p) => p.isHost)!.id).toBe(seats[0]!.id);
    checkInvariants(engine);
  });

  it('gates every privileged method behind the host', () => {
    const { engine, seats, bank } = startedGame(401, 3);
    const notHost = seats[1]!.id;
    const pickerIds = selectableCategoryIds(engine).slice(
      0,
      engine.requiredCategoryCount(1),
    );
    const calls: Array<[string, () => { ok: boolean; error?: string }]> = [
      ['pickCategories', () => engine.pickCategories(notHost, pickerIds)],
      ['transferHost', () => engine.transferHost(notHost, seats[2]!.id)],
      ['revealQuestion', () => engine.revealQuestion(notHost)],
      ['nextQuestion', () => engine.nextQuestion(notHost)],
      ['forceEnd', () => engine.forceEnd(notHost)],
      ['rematch', () => engine.rematch(notHost)],
      ['updateSettings', () => engine.updateSettings(notHost, { penalizeWrongAnswers: false })],
      ['start', () => engine.start(notHost)],
    ];
    for (const [name, call] of calls) {
      const res = call();
      expect(res.ok, name).toBe(false);
      expect(res.error, name).toMatch(/Only the host/);
    }
    // startSong needs a song on deck to reach anything but the host check
    pickRound(engine, seats[0]!.id);
    expect(engine.startSong(notHost, onDeckSongId(engine))).toEqual({
      ok: false,
      error: 'Only the host can start a song.',
    });
    // judge is host-gated too, but needs a lock to reach the check
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[1]!.id);
    const judged = engine.judge(notHost, { titleCorrect: true, artistCorrect: true });
    expect(judged).toEqual({ ok: false, error: 'Only the host can judge an answer.' });
    checkInvariants(engine, bank);
  });

  it('transfers the crown on request', () => {
    const { engine } = makeEngine(402);
    const seats = addPlayers(engine, 3);
    expect(engine.transferHost(seats[0]!.id, seats[2]!.id)).toEqual({ ok: true });
    expect(engine.room.players.find((p) => p.isHost)!.id).toBe(seats[2]!.id);
    checkInvariants(engine);
    // and the old host is now just a player
    expect(engine.transferHost(seats[0]!.id, seats[1]!.id)).toEqual({
      ok: false,
      error: 'Only the host can transfer the host role.',
    });
  });

  it('refuses to transfer to an unknown or disconnected player', () => {
    const { engine } = makeEngine(403);
    const seats = addPlayers(engine, 3);
    expect(engine.transferHost(seats[0]!.id, 'nope')).toEqual({
      ok: false,
      error: 'No such player.',
    });
    engine.disconnect(seats[2]!.id);
    expect(engine.transferHost(seats[0]!.id, seats[2]!.id)).toEqual({
      ok: false,
      error: 'That player is disconnected.',
    });
    expect(engine.transferHost(seats[0]!.id, seats[0]!.id)).toEqual({
      ok: false,
      error: 'You are already the host.',
    });
  });

  it('prefers a cast-capable device when the host disconnects', () => {
    const { engine } = makeEngine(404);
    const host = engine.join({ displayName: 'Host', canCast: true });
    const plain = engine.join({ displayName: 'Plain', canCast: false });
    const caster = engine.join({ displayName: 'Caster', canCast: true });
    expect(host.ok && plain.ok && caster.ok).toBe(true);
    if (!host.ok || !caster.ok) return;

    engine.disconnect(host.player.id);
    expect(engine.room.players.find((p) => p.isHost)!.id).toBe(caster.player.id);
    checkInvariants(engine);
  });

  it('keeps the crown when nobody is left to take it', () => {
    const { engine } = makeEngine(405);
    const seats = addPlayers(engine, 2);
    engine.disconnect(seats[1]!.id);
    engine.disconnect(seats[0]!.id);
    expect(engine.room.players[0]!.isHost).toBe(true);
  });

  it('pauses the game when the host drops mid-question and nobody can take over', () => {
    const { engine, seats } = startedGame(406, 2);
    armNext(engine, seats[0]!.id);
    // The guest leaving empties the buzz pool (the host never buzzes), so the
    // round auto-reveals first; then the host drops with nobody to inherit.
    engine.disconnect(seats[1]!.id);
    expect(engine.room.phase).toBe('REVEAL');
    engine.disconnect(seats[0]!.id);
    expect(engine.room.phase).toBe('PAUSED');
    expect(engine.room.pause.reason).toBe('PLAYER_DISCONNECT');
    expect(engine.room.phaseBeforePause).toBe('REVEAL');
    // reconnecting the host resumes it
    const back = engine.join({ displayName: 'P0', reconnectToken: seats[0]!.token });
    expect(back.ok).toBe(true);
    expect(engine.room.phase).toBe('REVEAL');
  });

  it('does not pause when the host drops but a successor is connected', () => {
    const { engine, seats } = startedGame(407, 3);
    armNext(engine, seats[0]!.id);
    engine.disconnect(seats[0]!.id);
    expect(engine.room.phase).toBe('ARMED');
    expect(engine.room.players.find((p) => p.isHost)!.connected).toBe(true);
    checkInvariants(engine);
  });

  it('a reconnecting player keeps their seat, score and name', () => {
    const { engine, seats } = startedGame(408, 2);
    armNext(engine, seats[0]!.id);
    engine.buzz(seats[1]!.id);
    engine.judge(seats[0]!.id, { titleCorrect: true, artistCorrect: true });
    engine.disconnect(seats[1]!.id);
    const back = engine.join({ displayName: 'anything', reconnectToken: seats[1]!.token });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.reconnected).toBe(true);
    expect(back.player.id).toBe(seats[1]!.id);
    expect(back.player.displayName).toBe('P1');
    expect(back.player.score).toBe(100);
  });

  it('rejects a duplicate display name', () => {
    const { engine } = makeEngine(409);
    addPlayers(engine, 2);
    expect(engine.join({ displayName: 'p0' })).toEqual({
      ok: false,
      error: 'That name is taken in this room.',
    });
  });
});
