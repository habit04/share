import { describe, it, expect } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { SessionManager, applySaveResult, type SessionHost } from '../src/app/sessions';
import { Autosaver, localAutosaveStore, type AutosaveStore } from '../src/app/autosave';
import { explodeInsert, mirrorEntityAcross, insertTransform, type Entity, type InsertEntity, type BlockDef, type LineEntity } from '../src/core/entities';
import { readDxf, writeDxf, insertScales } from '../src/io/dxf';

function host(): SessionHost & { doc: Drawing } {
  const doc = new Drawing();
  const h: SessionHost & { doc: Drawing } = {
    doc,
    viewport: { center: { x: 0, y: 0 }, scale: 1 },
    selection: new Set(),
    loadState(state, path) {
      doc.load(state, path);
    },
  };
  return h;
}
const line = (id: string, x1: number, y1: number, x2: number, y2: number): LineEntity => ({ id, layer: '0', color: 'ByLayer', type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });

describe('save marks only the saved revision clean', () => {
  it('keeps the dirty flag when an edit lands while the save is pending', () => {
    const h = host();
    const sessions = new SessionManager(h);
    h.doc.addEntities([line('a', 0, 0, 1, 0)]);
    const saved = h.doc.snapshot; // the revision handed to the file writer
    h.doc.addEntities([line('b', 0, 1, 1, 1)]); // edit while the dialog / write is pending
    expect(applySaveResult(sessions, h, sessions.current.id, saved, '/tmp/x.dxf')).toBe('newer-edits');
    expect(h.doc.dirty).toBe(true);
    expect(h.doc.filePath).toBe('/tmp/x.dxf');
    // Saving the current revision clears it.
    expect(applySaveResult(sessions, h, sessions.current.id, h.doc.snapshot, '/tmp/x.dxf')).toBe('clean');
    expect(h.doc.dirty).toBe(false);
  });
  it('applies the result to the right tab when the user switched tabs meanwhile', () => {
    const h = host();
    const sessions = new SessionManager(h);
    h.doc.addEntities([line('a', 0, 0, 1, 0)]);
    const firstId = sessions.current.id;
    const saved = h.doc.snapshot;
    sessions.add(); // new tab becomes active (and is clean)
    h.doc.addEntities([line('c', 0, 0, 2, 0)]);
    expect(applySaveResult(sessions, h, firstId, saved, '/tmp/first.dxf')).toBe('clean');
    expect(h.doc.dirty).toBe(true); // the active (other) tab is untouched
    const first = sessions.all.find((s) => s.id === firstId)!;
    expect(first.dirty).toBe(false);
    expect(first.filePath).toBe('/tmp/first.dxf');
    expect(applySaveResult(sessions, h, 999, saved, '/tmp/gone.dxf')).toBe('closed');
  });
});

describe('recovery keeps the backup until a real save', () => {
  function memoryStore(): AutosaveStore & { files: Map<string, string> } {
    const files = new Map<string, string>();
    return {
      files,
      async write(name, text) {
        files.set(name, text);
      },
      async list() {
        return [...files.keys()].map((name) => ({ name, originalPath: null, title: name, savedAt: 0 }));
      },
      async read(name) {
        return files.get(name) ?? null;
      },
      async remove(name) {
        files.delete(name);
      },
    };
  }
  it('adopts the backup name, rewrites it on autosave and removes it only on discardFor', async () => {
    const h = host();
    const sessions = new SessionManager(h);
    const store = memoryStore();
    store.files.set('backup-1', 'old');
    const auto = new Autosaver(sessions, store, () => 10);
    const idx = sessions.add(new Drawing().snapshot, null, true);
    const id = sessions.all[idx]!.id;
    auto.adopt(id, 'backup-1');
    expect(store.files.has('backup-1')).toBe(true);
    h.doc.addEntities([line('a', 0, 0, 1, 0)]);
    await auto.runNow();
    expect(store.files.get('backup-1')).toContain('ENTITIES'); // refreshed in place, no second file
    expect(store.files.size).toBe(1);
    await auto.discardFor(id);
    expect(store.files.has('backup-1')).toBe(false);
  });
});

describe('browser autosave reports storage failures', () => {
  it('does not record a drawing as backed up when setItem throws', async () => {
    const h = host();
    const sessions = new SessionManager(h);
    let fail = true;
    const items = new Map<string, string>();
    const storage = {
      get length() {
        return items.size;
      },
      key: (i: number) => [...items.keys()][i] ?? null,
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (fail) throw new Error('QuotaExceededError');
        items.set(k, v);
      },
      removeItem: (k: string) => void items.delete(k),
    };
    const auto = new Autosaver(sessions, localAutosaveStore(storage), () => 10);
    const errors: string[] = [];
    auto.onError = (title, err) => errors.push(`${title}: ${(err as Error).message}`);
    h.doc.addEntities([line('a', 0, 0, 1, 0)]);
    expect(await auto.runNow()).toBe(0);
    expect(errors).toHaveLength(1);
    fail = false;
    expect(await auto.runNow()).toBe(1); // retried, not skipped as "already saved"
    expect(items.size).toBe(1);
  });
});

describe('mirrored and non-uniform block inserts', () => {
  const block: BlockDef = {
    name: 'ARROW',
    description: '',
    basePoint: { x: 0, y: 0 },
    entities: [line('l1', 0, 0, 1, 0), line('l2', 1, 0, 0.8, 0.2), { id: 'c1', layer: '0', color: 'ByLayer', type: 'circle', center: { x: 0.5, y: 0.5 }, radius: 0.1 }, { id: 'a1', layer: '0', color: 'ByLayer', type: 'arc', center: { x: 0, y: 0 }, radius: 0.5, startAngle: 0, endAngle: Math.PI / 2 }],
    attributes: [{ tag: 'TAG1', prompt: '', default: 'X', position: { x: 0.5, y: 0.3 }, height: 0.1, align: 'left' }],
  };
  const lookup = (n: string) => (n === 'ARROW' ? block : undefined);
  const ins = (extra: Partial<InsertEntity>): InsertEntity => ({ id: 'i', layer: 'SYMS', color: 'ByLayer', type: 'insert', block: 'ARROW', position: { x: 2, y: 1 }, rotation: 0, scale: 1, attributes: {}, ...extra });
  const lineOf = (es: Entity[], id: string) => es.find((e) => e.id === id) as LineEntity;

  it('mirrors the geometry about the block Y axis and keeps attribute text readable', () => {
    const ex = explodeInsert(ins({ mirror: true }), lookup);
    expect(lineOf(ex, 'l1').b).toEqual({ x: 1, y: 1 }); // (1,0) -> (-1,0) + (2,1)
    expect(lineOf(ex, 'l2').b.y).toBeCloseTo(1.2);
    const arc = ex.find((e) => e.type === 'arc')!;
    // The first-quadrant arc becomes a second-quadrant arc, still counter-clockwise.
    if (arc.type === 'arc') {
      expect(arc.startAngle).toBeCloseTo(Math.PI / 2);
      expect(arc.endAngle).toBeCloseTo(Math.PI);
    }
    const tag = ex.find((e) => e.type === 'text')!;
    if (tag.type === 'text') {
      expect(tag.rotation).toBe(0);
      expect(tag.align).toBe('right');
      expect(tag.position.x).toBeCloseTo(1.5);
    }
  });
  it('stretches with a separate Y scale and turns circles into polylines', () => {
    const ex = explodeInsert(ins({ scale: 1, scaleY: 2 }), lookup);
    expect(lineOf(ex, 'l2').b).toEqual({ x: 2.8, y: 1.4 });
    expect(ex.filter((e) => e.type === 'circle')).toHaveLength(0);
    const poly = ex.find((e) => e.type === 'polyline' && e.closed);
    expect(poly).toBeDefined();
    if (poly?.type === 'polyline') {
      const ys = poly.points.map((p) => p.y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(0.4, 2); // radius 0.1 * 2 * 2
    }
  });
  it('MIRROR of an insert reflects its geometry exactly', () => {
    const original = ins({ rotation: 0.3 });
    const mirrored = mirrorEntityAcross(original, { x: 0, y: 0 }, { x: 0, y: 1 }) as InsertEntity;
    expect(mirrored.mirror).toBe(true);
    const reflect = (p: { x: number; y: number }) => ({ x: -p.x, y: p.y });
    const before = explodeInsert(original, lookup);
    const after = explodeInsert(mirrored, lookup);
    for (const id of ['l1', 'l2']) {
      expect(lineOf(after, id).a.x).toBeCloseTo(reflect(lineOf(before, id).a).x);
      expect(lineOf(after, id).a.y).toBeCloseTo(reflect(lineOf(before, id).a).y);
      expect(lineOf(after, id).b.x).toBeCloseTo(reflect(lineOf(before, id).b).x);
      expect(lineOf(after, id).b.y).toBeCloseTo(reflect(lineOf(before, id).b).y);
    }
    // Mirroring twice restores the original transform.
    const twice = mirrorEntityAcross(mirrored, { x: 0, y: 0 }, { x: 0, y: 1 }) as InsertEntity;
    expect(twice.mirror).toBe(false);
    expect(insertTransform(twice, block)({ x: 1, y: 0.5 }).x).toBeCloseTo(insertTransform(original, block)({ x: 1, y: 0.5 }).x);
  });
  it('round-trips mirror and Y scale through DXF and decodes signed DWG scales', () => {
    const state: DrawingState = { entities: [ins({ mirror: true, scaleY: 1.5, rotation: 0.25 })], layers: new Drawing().layers, blocks: { ARROW: block }, currentLayer: '0' };
    const text = writeDxf(state);
    expect(text).toMatch(/41\r?\n-1(\.0+)?\r?\n42\r?\n1\.5\r?\n/);
    const back = readDxf(text).entities.find((e) => e.type === 'insert');
    expect(back?.type).toBe('insert');
    if (back?.type === 'insert') {
      expect(back.mirror).toBe(true);
      expect(back.scaleY).toBeCloseTo(1.5);
      expect(back.scale).toBe(1);
      expect(back.rotation).toBeCloseTo(0.25);
    }
    expect(insertScales(-2, 2)).toEqual({ scale: 2, mirror: true, rotationOffset: 0 });
    expect(insertScales(2, -2)).toEqual({ scale: 2, mirror: true, rotationOffset: Math.PI });
    expect(insertScales(-2, -2)).toEqual({ scale: 2, rotationOffset: Math.PI });
    expect(insertScales(1, 3)).toEqual({ scale: 1, scaleY: 3, rotationOffset: 0 });
  });
});
