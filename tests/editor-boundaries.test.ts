/**
 * Module boundary of the Editor (src/app/editor/): code outside it uses the Editor's public
 * members (notify for events, setHover for the rollover highlight ...) and never casts an Editor
 * to reach its private overlay, listeners, event dispatch or the working state its modules share.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('module boundary: the Editor keeps its private members', () => {
  it('no source file outside src/app/editor/ casts its way to them', () => {
    const root = join(import.meta.dirname, '..');
    const offenders: string[] = [];
    for (const file of tsFiles(join(root, 'src'))) {
      const rel = relative(root, file).replace(/\\/g, '/');
      if (rel.startsWith('src/app/editor/')) continue;
      const text = readFileSync(file, 'utf8');
      if (/as unknown as \{[^}]*\b(overlay|listeners|internals|emit)\b/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
