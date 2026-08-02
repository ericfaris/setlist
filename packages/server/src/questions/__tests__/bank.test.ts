// The committed sample fixture is what makes the app runnable with no
// YT Music credentials — so it has to stay valid and big enough for a board.
import { describe, expect, it } from 'vitest';
import { BOARD_COLUMNS, BOARD_ROWS, validateQuestionBank } from '@setlist/shared';
import sampleBank from '../sample-bank.json' with { type: 'json' };
import { loadQuestionBank, sampleQuestionBank } from '../bank.js';

describe('sample bank fixture', () => {
  it('passes validateQuestionBank', () => {
    const res = validateQuestionBank(sampleBank);
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
  });

  it('has enough categories and questions to fill a board', () => {
    const bank = sampleQuestionBank();
    const usable = bank.categories.filter((c) => c.questions.length >= BOARD_ROWS);
    expect(usable.length).toBeGreaterThanOrEqual(BOARD_COLUMNS);
    expect(bank.source).toBe('fixture');
  });

  it('has unique, plausible video ids', () => {
    const bank = sampleQuestionBank();
    const ids = bank.categories.flatMap((c) => c.questions.map((q) => q.videoId));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });
});

describe('validateQuestionBank', () => {
  const good = () => JSON.parse(JSON.stringify(sampleBank));

  it('rejects a wrong version', () => {
    const b = good();
    b.version = 2;
    expect(validateQuestionBank(b).ok).toBe(false);
  });

  it('rejects an empty category list', () => {
    const b = good();
    b.categories = [];
    expect(validateQuestionBank(b)).toEqual({ ok: false, error: 'bank has no categories' });
  });

  it('rejects a category with no questions', () => {
    const b = good();
    b.categories[0].questions = [];
    expect(validateQuestionBank(b).ok).toBe(false);
  });

  it.each(['videoId', 'title', 'artist'])('rejects a question missing %s', (field) => {
    const b = good();
    delete b.categories[0].questions[0][field];
    const res = validateQuestionBank(b);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(field);
  });

  it('rejects non-objects', () => {
    expect(validateQuestionBank(null).ok).toBe(false);
    expect(validateQuestionBank([]).ok).toBe(false);
    expect(validateQuestionBank('nope').ok).toBe(false);
  });
});

describe('loadQuestionBank', () => {
  it('falls back to the fixture when the path does not exist', () => {
    const loaded = loadQuestionBank('/nonexistent/definitely-not-here.json');
    expect(loaded.source).toBe('fixture');
    expect(loaded.warning).toContain('not found');
    expect(loaded.bank.categories.length).toBeGreaterThan(0);
  });
});
