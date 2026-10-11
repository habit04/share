import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Drawing } from '../src/core/document';
import type { Entity } from '../src/core/entities';

const line = (id: string, x: number): Entity => ({ id, layer: '0', color: 'ByLayer', type: 'line', a: { x, y: 0 }, b: { x, y: 1 } });

describe('Drawing history API', () => {
  it('history() copies the stacks and restoreHistory() puts them back after load()', () => {
    const doc = new Drawing();
    doc.addEntities([line('a', 0)]);
    doc.addEntities([line('b', 1)]);
    doc.undo();
    const h = doc.history();
    expect(h.undo.length).toBe(1);
    expect(h.redo.length).toBe(1);
    // A copy: later edits do not change it.
    doc.addEntities([line('c', 2)]);
    expect(h.undo.length).toBe(1);
    expect(h.redo.length).toBe(1);

    const parked = doc.snapshot;
    const parkedHistory = doc.history();
    doc.load({ ...parked, entities: [] }, null);
    expect(doc.canUndo()).toBe(false);
    doc.load(parked, null);
    doc.restoreHistory(parkedHistory);
    doc.dirty = true;
    expect(doc.canUndo()).toBe(true);
    expect(doc.undo()).toBe(true);
    expect(doc.entities.map((e) => e.id)).toEqual(['a']);
    expect(doc.redo()).toBe(true);
    expect(doc.entities.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('restoreHistory() leaves the current state and the dirty flag alone', () => {
    const doc = new Drawing();
    doc.addEntities([line('a', 0)]);
    const state = doc.snapshot;
    doc.dirty = false;
    doc.restoreHistory({ undo: [], redo: [] });
    expect(doc.snapshot).toBe(state);
    expect(doc.dirty).toBe(false);
    expect(doc.canUndo()).toBe(false);
  });

  it('undoLimit caps the undo stack', () => {
    const doc = new Drawing();
    for (let i = 0; i < doc.undoLimit + 5; i += 1) doc.addEntities([line(`L${i}`, i)]);
    expect(doc.history().undo.length).toBe(doc.undoLimit);
  });
});

/** Every source file (.ts, .mjs, .cjs, .js) below a folder. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|mjs|cjs|js)$/.test(p)) out.push(p);
  }
  return out;
}

describe('module boundary: the undo history is private to src/core/document.ts', () => {
  it('no other source, test or script file reaches its private fields', () => {
    const root = join(import.meta.dirname, '..');
    const offenders: string[] = [];
    const files = ['src', 'tests', 'scripts', 'e2e', 'electron'].flatMap((d) => sourceFiles(join(root, d)));
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      const rel = relative(root, file).replace(/\\/g, '/');
      if (rel === 'src/core/document.ts' || rel === 'tests/history-api.test.ts') continue;
      const text = readFileSync(file, 'utf8');
      // The private fields by name, or a cast of a Drawing to reach its private `state`.
      if (/\b(undoStack|redoStack)\b/.test(text) || /as unknown as \{\s*state\??:/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
