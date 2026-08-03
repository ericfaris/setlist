// ============================================================================
// Question bank — the on-disk contract between the offline Python builder
// (scripts/questionbank/build_bank.py) and the Node server that consumes it.
// The bank is produced manually against the user's own YouTube Music account;
// a committed fixture (packages/server/src/questions/sample-bank.json) makes
// the app runnable with no credentials at all.
// ============================================================================

export interface BankQuestion {
  /** Stable and derived (`q_<videoId>`) so a rebuild doesn't churn ids. */
  id: string;
  /** Song title. This is an ANSWER — never broadcast before the reveal. */
  title: string;
  /** Primary artist string (multiple artists joined with ', '). Also an ANSWER. */
  artist: string;
  /**
   * YouTube video id. HOST-ONLY: the host needs it to build the YouTube Music
   * link they play the song from. It is never sent to another player or to the
   * TV — a player who saw it could simply look the song up.
   */
  videoId: string;
  album: string | null;
  /** May be null — ytmusicapi doesn't always supply it. Unused by the app. */
  durationSeconds: number | null;
  /**
   * Suggested value. The engine IGNORES this entirely — scoring is a flat
   * SONG_POINT_VALUE per song. It is kept in the file because the builder
   * writes it and the validator still requires it; the on-disk bank format is
   * deliberately unchanged. Do not "fix" the redundancy by removing it.
   */
  value: number;
  /** Legacy hand-tunable clip start. Unused by the app; still accepted on disk. */
  startSeconds: number | null;
}

/** Native YT Music deep link. No embed restrictions apply — this is the whole
 *  point of the setlist redesign. */
export function youtubeMusicUrl(videoId: string): string {
  return `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

export interface BankCategory {
  /**
   * `cat_<playlistId>` for a category that mirrors one source playlist, or
   * `cat_ai_<slug>_<hash6>` for an AI-generated cross-cutting category.
   * Derived either way, so a rebuild doesn't churn ids.
   */
  id: string;
  /** Setlist section header — a playlist name, or an AI-chosen theme. */
  title: string;
  /**
   * The single source playlist, when the category maps 1:1 to one. `null` (or
   * absent) for AI-generated categories, which pull from many playlists.
   */
  playlistId?: string | null;
  questions: BankQuestion[];
}

export interface QuestionBank {
  version: 1;
  /** ISO 8601 */
  generatedAt: string;
  source: 'ytmusicapi' | 'fixture';
  categories: BankCategory[];
}

export type ValidateBankResult =
  | { ok: true; bank: QuestionBank }
  | { ok: false; error: string };

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

/**
 * Hand-written runtime validation — deliberately no schema dependency. Anything
 * that reaches here came off disk from a script the server doesn't control, so
 * every field is checked rather than trusted.
 */
export function validateQuestionBank(x: unknown): ValidateBankResult {
  if (!isObject(x)) return { ok: false, error: 'bank is not an object' };
  if (x['version'] !== 1) return { ok: false, error: `unsupported bank version ${String(x['version'])}` };
  if (x['source'] !== 'ytmusicapi' && x['source'] !== 'fixture') {
    return { ok: false, error: `unknown bank source ${String(x['source'])}` };
  }
  if (!isNonEmptyString(x['generatedAt'])) return { ok: false, error: 'generatedAt missing' };

  const categories = x['categories'];
  if (!Array.isArray(categories) || categories.length === 0) {
    return { ok: false, error: 'bank has no categories' };
  }

  for (const [i, rawCat] of categories.entries()) {
    if (!isObject(rawCat)) return { ok: false, error: `category ${i} is not an object` };
    if (!isNonEmptyString(rawCat['id'])) return { ok: false, error: `category ${i} missing id` };
    if (!isNonEmptyString(rawCat['title'])) return { ok: false, error: `category ${i} missing title` };
    // Optional since AI-generated categories draw from many playlists: absent,
    // null and a non-empty string all pass; '', 0 and {} still fail.
    const playlistId = rawCat['playlistId'];
    if (playlistId !== undefined && playlistId !== null && !isNonEmptyString(playlistId)) {
      return { ok: false, error: `category ${i} has an invalid playlistId` };
    }
    const questions = rawCat['questions'];
    if (!Array.isArray(questions) || questions.length === 0) {
      return { ok: false, error: `category "${String(rawCat['title'])}" has no questions` };
    }
    for (const [j, rawQ] of questions.entries()) {
      if (!isObject(rawQ)) return { ok: false, error: `question ${i}.${j} is not an object` };
      for (const field of ['id', 'title', 'artist', 'videoId'] as const) {
        if (!isNonEmptyString(rawQ[field])) {
          return { ok: false, error: `question ${i}.${j} missing ${field}` };
        }
      }
      if (typeof rawQ['value'] !== 'number') {
        return { ok: false, error: `question ${i}.${j} missing numeric value` };
      }
      const dur = rawQ['durationSeconds'];
      if (dur !== null && typeof dur !== 'number') {
        return { ok: false, error: `question ${i}.${j} has a non-numeric durationSeconds` };
      }
      const start = rawQ['startSeconds'];
      if (start !== null && typeof start !== 'number') {
        return { ok: false, error: `question ${i}.${j} has a non-numeric startSeconds` };
      }
      const album = rawQ['album'];
      if (album !== null && typeof album !== 'string') {
        return { ok: false, error: `question ${i}.${j} has a non-string album` };
      }
    }
  }

  return { ok: true, bank: x as unknown as QuestionBank };
}
