// .env.example is the documented config surface. Every var it lists must be
// read somewhere in the server source, so settings nothing reads (old
// CLIP_*, ANTHROPIC_*, YOUTUBE_API_KEY) can't pile up again unnoticed.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(srcDir, '../../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sourceFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('.env.example', () => {
  it('only lists vars the server actually reads', () => {
    const vars = readFileSync(join(repoRoot, '.env.example'), 'utf8')
      .split('\n')
      .map((l) => l.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter((v): v is string => !!v);
    expect(vars.length).toBeGreaterThan(0);

    const source = sourceFiles(srcDir).map((f) => readFileSync(f, 'utf8')).join('\n');
    const unread = vars.filter((v) => !source.includes(`process.env.${v}`));
    expect(unread).toEqual([]);
  });
});
