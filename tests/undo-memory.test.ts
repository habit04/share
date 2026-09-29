import { describe, it, expect } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import { bigDrawing } from './helpers/big-drawing';

// The undo history keeps whole DrawingState snapshots. That is only affordable because states are
// immutable and share every unchanged entity (and the layer / block tables) with their neighbours:
// one edit costs one new entities array (pointers) plus the edited objects, and the stack is capped.

/** A real gc() for stable heap numbers (exposed at runtime; no node flag needed). */
function gcFn(): () => void {
  setFlagsFromString('--expose_gc');
  const gc = runInNewContext('gc') as (() => void) | undefined;
  return () => {
    gc?.();
    gc?.();
  };
}

interface DrawingInternals {
  undoStack: DrawingState[];
  redoStack: DrawingState[];
  maxUndo: number;
}
const internals = (d: Drawing) => d as unknown as DrawingInternals;

/** 300 small edits of the kinds the tools make: move one line, add a line, erase one, recolour one. */
function applyEdits(doc: Drawing, n: number): void {
  for (let i = 0; i < n; i += 1) {
    const ents = doc.entities;
    switch (i % 4) {
      case 0: {
        const e = ents[(i * 7) % ents.length]!;
        if (e.type === 'line') doc.replaceEntities([{ ...e, a: { x: e.a.x + 0.1, y: e.a.y }, b: { x: e.b.x + 0.1, y: e.b.y } }]);
        else doc.replaceEntities([{ ...e, color: 2 } as Entity]);
        break;
      }
      case 1:
        doc.addEntities([{ id: `N${i}`, layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x: i, y: 0 }, b: { x: i, y: 1 } }]);
        break;
      case 2:
        doc.removeEntities([ents[(i * 13) % ents.length]!.id]);
        break;
      default: {
        const e = ents[(i * 17) % ents.length]!;
        doc.replaceEntities([{ ...e, color: (i % 7) + 1 } as Entity]);
      }
    }
  }
}

describe('undo history on a 5,000-entity drawing', () => {
  it('caps the undo stack at maxUndo after 300 edits and undoes exactly that far', () => {
    const doc = new Drawing(bigDrawing(4000, 600, 400));
    expect(doc.entities.length).toBe(5000);
    const maxUndo = internals(doc).maxUndo;
    expect(maxUndo).toBeGreaterThan(0);
    const states: DrawingState[] = [doc.snapshot];
    for (let i = 0; i < 300; i += 1) {
      applyEdits(doc, 1);
      states.push(doc.snapshot);
    }
    expect(internals(doc).undoStack.length).toBe(Math.min(300, maxUndo));
    expect(internals(doc).redoStack.length).toBe(0);
    let undone = 0;
    while (doc.undo()) undone += 1;
    expect(undone).toBe(Math.min(300, maxUndo));
    // The oldest reachable state is the one maxUndo edits back.
    expect(doc.snapshot).toBe(states[300 - undone]);
    expect(doc.canUndo()).toBe(false);
    // and redo walks all the way forward again
    let redone = 0;
    while (doc.redo()) redone += 1;
    expect(redone).toBe(undone);
    expect(doc.snapshot).toBe(states[300]);
  });

  it('shares unchanged entities, layers and blocks by reference between consecutive states', () => {
    const doc = new Drawing(bigDrawing(4000, 600, 400));
    applyEdits(doc, 300);
    const stack = [...internals(doc).undoStack, doc.snapshot];
    let minShared = Infinity;
    for (let k = 1; k < stack.length; k += 1) {
      const prev = stack[k - 1]!;
      const next = stack[k]!;
      expect(next).not.toBe(prev);
      expect(next.entities).not.toBe(prev.entities);
      expect(next.layers).toBe(prev.layers);
      expect(next.blocks).toBe(prev.blocks);
      const prevById = new Map(prev.entities.map((e) => [e.id, e]));
      let shared = 0;
      let changed = 0;
      for (const e of next.entities) {
        const before = prevById.get(e.id);
        if (before === e) shared += 1;
        else changed += 1;
      }
      // a small edit touches at most one entity (added or replaced); erasing touches none
      expect(changed).toBeLessThanOrEqual(1);
      minShared = Math.min(minShared, shared);
    }
    expect(minShared).toBeGreaterThanOrEqual(4999);
  });

  it('keeps heap growth bounded (pointer arrays, not copies of the drawing)', () => {
    const gc = gcFn();
    const doc = new Drawing(bigDrawing(4000, 600, 400));
    gc();
    const before = process.memoryUsage().heapUsed;
    applyEdits(doc, 300);
    gc();
    const after = process.memoryUsage().heapUsed;
    const growthMb = (after - before) / (1024 * 1024);
    // 200 states x 5,000 pointers x 8 bytes = ~8 MB of entity arrays; copying the drawing per state
    // would be ~200 x 5,000 objects (hundreds of MB).
    const perStateKb = ((after - before) / internals(doc).undoStack.length) / 1024;
    console.log(`undo history: heap +${growthMb.toFixed(1)} MB for ${internals(doc).undoStack.length} states (${perStateKb.toFixed(1)} KB per state)`);
    expect(growthMb).toBeLessThan(40);
    expect(perStateKb).toBeLessThan(200);
    // A further 300 edits must not grow the heap much: the oldest states are dropped.
    applyEdits(doc, 300);
    gc();
    const after2 = process.memoryUsage().heapUsed;
    const growth2Mb = (after2 - after) / (1024 * 1024);
    console.log(`undo history: heap +${growth2Mb.toFixed(1)} MB after 300 more edits (capped stack)`);
    expect(growth2Mb).toBeLessThan(10);
  });
});
