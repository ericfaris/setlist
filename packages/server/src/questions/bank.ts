// Question-bank loading. The real bank is produced offline by
// scripts/questionbank/build_bank.py against the user's own YouTube Music
// account and is gitignored (it's their data). If it's missing or malformed we
// fall back to the committed sample fixture rather than refusing to boot — the
// same shape as pinpoint's "no ANTHROPIC_API_KEY -> bundled seed cards"
// fallback, and what makes the app runnable with zero credentials.
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { validateQuestionBank, type QuestionBank } from '@music-trivia/shared';
import sampleBank from './sample-bank.json' with { type: 'json' };

/** Same 3-levels-up trick as env.rootEnvPath(): stable under tsx (src/) and node (dist/). */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../../..');
}

export function sampleQuestionBank(): QuestionBank {
  const res = validateQuestionBank(sampleBank);
  if (!res.ok) {
    // The fixture is committed and covered by a test; if this ever fires the
    // build is broken in a way no fallback can paper over.
    throw new Error(`bundled sample bank is invalid: ${res.error}`);
  }
  return res.bank;
}

export interface LoadedBank {
  bank: QuestionBank;
  /** Which source actually won — surfaced on /api/health and in the boot log. */
  source: 'file' | 'fixture';
  path: string | null;
  warning: string | null;
}

export function loadQuestionBank(path?: string): LoadedBank {
  const configured = path ?? process.env.QUESTION_BANK_PATH ?? 'question-bank/bank.json';
  const resolved = isAbsolute(configured) ? configured : join(repoRoot(), configured);

  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch {
    return {
      bank: sampleQuestionBank(),
      source: 'fixture',
      path: resolved,
      warning: `not found at ${resolved}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      bank: sampleQuestionBank(),
      source: 'fixture',
      path: resolved,
      warning: `unparseable JSON at ${resolved}: ${(e as Error).message}`,
    };
  }

  const res = validateQuestionBank(parsed);
  if (!res.ok) {
    return {
      bank: sampleQuestionBank(),
      source: 'fixture',
      path: resolved,
      warning: `invalid bank at ${resolved}: ${res.error}`,
    };
  }

  return { bank: res.bank, source: 'file', path: resolved, warning: null };
}
