// ============================================================================
// Spectator-safe projectors. Build the broadcast PublicRoom and the per-socket
// PrivateState from the authoritative GameRoom, stripping hidden info.
//
// Two secrets, and exactly where each is allowed to appear:
//   1. The ANSWER (title + artist) — PublicActiveQuestion.answer stays null
//      until `revealed`; before that only the host sees it, via
//      PrivateState.hostAnswer. The host picked the song, so they get it from
//      the moment the round is armed — but on their own socket and nowhere else.
//   2. The CATALOG's song data (titles, artists, videoIds) — only
//      PrivateState.hostOnDeck, only for the host, and only for the one song
//      the server has queued up next. A player who saw a videoId could just
//      look the song up.
//
// The CATEGORY of the upcoming song is public from ON_DECK onwards
// (PublicRoom.onDeck) — a category name is not an answer. PublicOnDeck carries
// nothing else about the song, and is built field by field so it cannot grow
// one by accident.
//
// The TV receiver is now the LEAST privileged surface: it plays no media, so it
// needs nothing private at all.
// ============================================================================
import type {
  CategoryGroup,
  CategoryOption,
  CategoryPicker,
  GameRoom,
  HostSong,
  PrivateState,
  PublicActiveQuestion,
  PublicAnswer,
  PublicOnDeck,
  PublicRoom,
  PublicRound,
} from '@setlist/shared';
import {
  SONG_POINT_VALUE,
  SONGS_PER_CATEGORY_PER_ROUND,
  TAXONOMY_GROUPS,
  parseCategoryGroup,
} from '@setlist/shared';
import type { GameEngine } from './engine.js';

export function toPublicRoom(room: GameRoom, now: number): PublicRoom {
  let active: PublicActiveQuestion | null = null;
  if (room.active) {
    const a = room.active;
    const answer: PublicAnswer | null = a.revealed
      ? { title: a.question.title, artist: a.question.artist }
      : null;
    active = {
      songId: a.songId,
      sectionTitle: room.setlist?.sections[a.sectionIndex]?.title ?? '',
      value: SONG_POINT_VALUE,
      startedAt: a.startedAt,
      lockedPlayerId: a.lockedPlayerId,
      lockedOutPlayerIds: [...a.lockedOutPlayerIds],
      verdict: a.verdict ? { ...a.verdict } : null,
      awarded: a.awarded,
      revealed: a.revealed,
      answer,
      // `question` (title/artist/videoId) and pickedByPlayerId intentionally
      // omitted. This object is built field by field (never `...a`) precisely
      // so a new server-only field can't leak by accident.
    };
  }

  const r = room.phase === 'GAME_OVER' ? null : room.round;

  // Round progress, counts only.
  const round: PublicRound | null = r
    ? { number: r.number, songsTotal: r.queue.length, songsPlayed: r.cursor }
    : null;

  // The ONE new public field. Category title + counters and nothing else —
  // never a song id, title, artist or videoId. Built field by field, and only
  // in ON_DECK.
  let onDeck: PublicOnDeck | null = null;
  if (r && room.phase === 'ON_DECK') {
    const songId = r.queue[r.cursor];
    const cat = songId ? r.categories.find((c) => c.songIds.includes(songId)) : undefined;
    onDeck = {
      categoryTitle: cat?.title ?? '',
      roundNumber: r.number,
      indexInRound: r.cursor + 1,
      songsInRound: r.queue.length,
    };
  }

  const songs = room.setlist?.songs ?? [];

  return {
    code: room.code,
    phase: room.phase,
    settings: { ...room.settings },
    players: room.players.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      connected: p.connected,
      isHost: p.isHost,
      canHostCast: p.canHostCast,
      score: p.score,
      streak: p.streak,
      joinOrder: p.joinOrder,
      pendingJoin: p.pendingJoin,
    })),
    active,
    onDeck,
    round,
    // Counts only. There is deliberately NO setlist field on PublicRoom — the
    // songs live on GameRoom now, and this is the sole reason that is safe.
    songsTotal: songs.length,
    songsRemaining: songs.filter((s) => !s.used).length,
    winnerPlayerIds: [...room.winnerPlayerIds],
    castConnected: room.castConnected,
    pause: { ...room.pause },
    serverNow: now,
  };
}

/**
 * The host's round picker: every catalog category, grouped by its taxonomy
 * group, with the count of songs it still has. Counts and titles only — no song
 * ever appears here. Empty groups are dropped; the rest keep TAXONOMY_GROUPS
 * order, so a bank the new builder didn't produce lands wholesale in 'other'
 * ("All categories") and stays fully playable.
 */
function toCategoryPicker(engine: GameEngine): CategoryPicker | null {
  const room = engine.room;
  const setlist = room.setlist;
  const round = room.round;
  if (!setlist || !round) return null;

  const unused = engine.unusedByCategory();
  const bySlug = new Map<string, CategoryOption[]>();
  for (const section of setlist.sections) {
    const slug = parseCategoryGroup(section.id);
    const option: CategoryOption = {
      id: section.id,
      title: section.title,
      available: unused.get(section.index) ?? 0,
    };
    const list = bySlug.get(slug);
    if (list) list.push(option);
    else bySlug.set(slug, [option]);
  }

  const groups: CategoryGroup[] = [];
  for (const g of TAXONOMY_GROUPS) {
    const categories = bySlug.get(g.slug);
    if (!categories || categories.length === 0) continue;
    groups.push({ slug: g.slug, label: g.label, categories });
  }

  return {
    roundNumber: round.number,
    required: engine.requiredCategoryCount(round.number),
    perCategory: SONGS_PER_CATEGORY_PER_ROUND,
    groups,
  };
}

export function toPrivateState(engine: GameEngine, playerId: string | null): PrivateState {
  const room = engine.room;
  const a = room.active;

  // Receiver (and unseated) sockets: nothing privileged at all.
  if (!playerId) {
    return {
      playerId: null,
      reconnectToken: null,
      isHost: false,
      score: 0,
      canBuzz: false,
      hostAnswer: null,
      hostVideoId: null,
      categoryPicker: null,
      hostOnDeck: null,
    };
  }

  const p = room.players.find((pl) => pl.id === playerId);
  const isHost = p?.isHost ?? false;
  // The host picked the song, so they legitimately know it from the moment the
  // round is armed — but still ONLY on the host's own socket. Do not widen this
  // to `a !== null`: that would hand the answer to every player.
  const hostAnswer: PublicAnswer | null =
    isHost && a ? { title: a.question.title, artist: a.question.artist } : null;
  // Same gate as hostAnswer — lets the host reopen the YouTube Music link at
  // any point while armed/locked, server-driven so a reload/reconnect doesn't
  // strand them without it.
  const hostVideoId: string | null = isHost && a ? a.question.videoId : null;
  // Host-only, and only while picking: category titles and counts, no songs.
  const categoryPicker =
    isHost && room.phase === 'ROUND_SETUP' ? toCategoryPicker(engine) : null;
  // Host-only, and only while a song is on deck: the one song they must play.
  // Field by field — a SetlistSong carries the whole BankQuestion.
  let hostOnDeck: HostSong | null = null;
  if (isHost && room.phase === 'ON_DECK') {
    const song = engine.onDeckSong();
    if (song) {
      hostOnDeck = {
        songId: song.id,
        title: song.question.title,
        artist: song.question.artist,
        videoId: song.question.videoId,
      };
    }
  }

  return {
    playerId,
    reconnectToken: p?.reconnectToken ?? null,
    isHost,
    score: p?.score ?? 0,
    canBuzz: engine.canBuzz(playerId),
    hostAnswer,
    hostVideoId,
    categoryPicker,
    hostOnDeck,
  };
}
