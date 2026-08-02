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
  /** YouTube video id. Receiver-only: a player who saw it could look it up. */
  videoId: string;
  album: string | null;
  /** May be null — ytmusicapi doesn't always supply it. Used only to clamp the clip offset. */
  durationSeconds: number | null;
  /**
   * Suggested board value. The engine OVERRIDES this with the ladder value for
   * the row it lays the question out in (POINT_VALUES[rowIndex]); it is kept in
   * the file purely so a hand-edited bank reads sensibly. Do not "fix" the
   * redundancy by removing it — the builder writes it.
   */
  value: number;
  /** Hand-tunable clip start. null = use CLIP_START_SECONDS. */
  startSeconds: number | null;
}

export interface BankCategory {
  /** `cat_<playlistId>` */
  id: string;
  /** Playlist name → board column header. */
  title: string;
  playlistId: string;
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
    if (!isNonEmptyString(rawCat['playlistId'])) {
      return { ok: false, error: `category ${i} missing playlistId` };
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
