/**
 * PR #41 fixes (Codex review at 7331766; lead rulings 2026-10-22) —
 * host-seam halves, failing-first:
 *
 * (1) [P1] STALE REFRESH: refreshDataLink must re-validate after the
 * async source read — same drawing/session, link still present, its
 * version/range unchanged — and DISCARD the result, surfacing
 * 'link changed during refresh; retry', when anything moved.
 * (2) [P1] UNBOUNDED CSV PADDING: parsing must never pad the whole
 * grid; rows stay ragged, missing cells are read as empty only when a
 * range is extracted, and a source whose bounding box (rows x widest
 * row) exceeds the 1,000,000-cell parse cap is refused.
 *
 * Round 2 (Codex re-review at e582369; lead rulings 2026-10-22):
 * (1) [P1] CROSS-DOCUMENT REFRESH: the round-1 generation + record
 * identity check can still pass against a DIFFERENT document —
 * Drawing.load can reuse the same frozen link record, and Save As
 * changes filePath without replacing the link. refreshDataLink must
 * also capture drawing.loadCount, the resolved source path and its
 * resolution basis (the drawing filePath) before the read, and
 * revalidate all of them after it.
 * (2) [P2] CAP GRANULARITY: the parse cap was checked only at row end,
 * so one enormous row overran before the check fired. The in-progress
 * row and the bounding-box budget must be checked at EVERY field
 * boundary, before the field is pushed.
 */
import { describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { TableCell, TableEntity } from '../src/core/table';
import type { CadNode } from '../src/core/cad-graph';
import type { Layer } from '../src/core/entities';
import {
  createDataLink,
  extractSourceRange,
  parseDelimitedSource,
  reRangeDataLink,
  refreshDataLink,
  type DataLinkFileSeam,
} from '../src/app/data-link-refresh';
import type { CreateDataLinkSpec } from '../src/project/data-links';

const NOW1 = '2026-10-21T00:00:00.000Z';
const NOW2 = '2026-10-21T01:00:00.000Z';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const layer0: Layer = { name: '0', color: 7, visible: true, locked: false, lineWeight: -1 };
const importedState = (texts: string[][] = [['a', 'b'], ['c', 'd'], ['e', 'f']]): DrawingState => {
  const table: TableEntity = {
    id: 't1', type: 'table', layer: '0', color: 'ByLayer', cadIdentity: 'AB12',
    position: { x: 0, y: 0 }, rotation: 0,
    rowHeights: texts.map(() => 1), columnWidths: texts[0]!.map(() => 2),
    cells: texts.map((row) => row.map((text): TableCell => ({ text }))),
    textHeight: 0.18,
  };
  const { cadIdentity: _identity, ...stripped } = table;
  const base = new Drawing({
    entities: [stripped as TableEntity], layers: [layer0], blocks: {}, currentLayer: '0',
  }).snapshot;
  const node: CadNode = {
    id: 'AB12', sourceHandle: 'AB12', type: 'ACAD_TABLE', section: 'ENTITIES',
    anchor: { kind: 'entity', id: 't1' }, baselineEntity: table,
    groups: [[5, 'AB12']],
  };
  return { ...base, entities: [table], cadGraph: { schema: 1, documentId: 'p31-pr41-source', sourceFormat: 'DXF', nodes: [node] } };
};

const tableOf = (state: DrawingState): TableEntity => state.entities.find((e) => e.type === 'table') as TableEntity;

const specFor = (state: DrawingState, over: Partial<CreateDataLinkSpec> = {}): CreateDataLinkSpec => ({
  id: 'L1',
  sourcePath: 'data/parts.csv',
  sourceRange: { firstRow: 0, firstCol: 0, rowCount: 3, colCount: 2 },
  tableId: tableOf(state).id,
  firstRow: 0,
  firstCol: 0,
  now: NOW1,
  ...over,
});

const docWithLink = (): Drawing => {
  const doc = new Drawing();
  doc.load(importedState(), '/proj/draw.dxf');
  const created = createDataLink(doc, specFor(doc.snapshot));
  if (created.kind !== 'created') throw new Error(`setup create failed: ${JSON.stringify(created)}`);
  return doc;
};

/** A seam whose readBytes stays pending until the test releases it. */
class DeferredSeam implements DataLinkFileSeam {
  readonly reads: string[] = [];
  private releaseFn: ((bytes: Uint8Array) => void) | null = null;
  readBytes(path: string): Promise<Uint8Array> {
    this.reads.push(path);
    return new Promise((resolve) => { this.releaseFn = resolve; });
  }
  async modifiedAt(): Promise<string | undefined> { return undefined; }
  release(bytes: Uint8Array): void {
    if (!this.releaseFn) throw new Error('release called before readBytes');
    this.releaseFn(bytes);
  }
}

const CHANGED_CSV = 'a,B2\nc,D2\nE1,F2';

describe('PR #41 (1) — stale refresh re-validation', () => {
  it('a re-range landing during a pending read is NOT reverted: the refresh discards and writes nothing', async () => {
    const doc = docWithLink();
    const seam = new DeferredSeam();
    const pending = refreshDataLink(doc, seam, 'L1');
    const re = reRangeDataLink(doc, 'L1', { sourceRange: { firstRow: 0, firstCol: 0, rowCount: 2, colCount: 2 } }, NOW2);
    expect(re.kind).toBe('re-ranged');
    const afterReRange = doc.snapshot;
    seam.release(enc(CHANGED_CSV));
    const out = await pending;
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.reason).toBe('link changed during refresh; retry');
    // The refresh wrote nothing at all: state and the re-ranged record stand.
    expect(doc.snapshot).toBe(afterReRange);
    expect(doc.snapshot.dataLinks?.[0]?.sourceRange.rowCount).toBe(2);
    expect(doc.snapshot.dataLinks?.[0]?.lastRefresh?.refreshedAt).toBe(NOW2);
    expect(tableOf(doc.snapshot).cells.map((r) => r.map((c) => c.text))).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']]);
  });

  it('a refresh landing after a NEW DRAWING was loaded writes nothing into it', async () => {
    const doc = docWithLink();
    const seam = new DeferredSeam();
    const pending = refreshDataLink(doc, seam, 'L1', { confirmOverwrite: true });
    doc.load(importedState([['n1', 'n2'], ['n3', 'n4'], ['n5', 'n6']]), '/proj/other.dxf');
    const loaded = doc.snapshot;
    seam.release(enc(CHANGED_CSV));
    const out = await pending;
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.reason).toBe('link changed during refresh; retry');
    expect(doc.snapshot).toBe(loaded);
    expect(doc.snapshot.dataLinks).toBeUndefined();
    expect(tableOf(doc.snapshot).cells.map((r) => r.map((c) => c.text))).toEqual([['n1', 'n2'], ['n3', 'n4'], ['n5', 'n6']]);
  });

  it('an undisturbed refresh still applies (control: the re-validation is not a blanket refusal)', async () => {
    const doc = docWithLink();
    const seam = new DeferredSeam();
    const pending = refreshDataLink(doc, seam, 'L1');
    seam.release(enc(CHANGED_CSV));
    const out = await pending;
    expect(out.kind).toBe('refreshed');
    expect(tableOf(doc.snapshot).cells.map((r) => r.map((c) => c.text))).toEqual([['a', 'B2'], ['c', 'D2'], ['E1', 'F2']]);
  });
});

describe('PR #41 (2) — bounded parse: no whole-grid padding, a bounding-box cap', () => {
  it('a sparse WIDE source (8000 cols x 200 rows from ~16 KB) is refused by the parse cap, not padded', () => {
    const wide = `${'a,'.repeat(7999)}a\n${'b\n'.repeat(199)}`;
    const out = parseDelimitedSource(enc(wide), 'f.csv');
    expect(out.kind).toBe('refuse');
    if (out.kind === 'refuse') expect(out.reason).toContain('over the 1,000,000-cell parse cap');
  });

  it('a sparse TALL source (1100 cols x 1000 rows from ~4 KB) is refused by the parse cap, not padded', () => {
    const tall = `${'a,'.repeat(1099)}a\n${'b\n'.repeat(999)}`;
    const out = parseDelimitedSource(enc(tall), 'f.csv');
    expect(out.kind).toBe('refuse');
    if (out.kind === 'refuse') expect(out.reason).toContain('over the 1,000,000-cell parse cap');
  });

  it('rows stay ragged after parsing; missing cells become empty only inside an extracted range', () => {
    const parsed = parseDelimitedSource(enc('a,b,c\nx'), 'f.csv');
    expect(parsed).toEqual({ kind: 'grid', grid: [['a', 'b', 'c'], ['x']] });
    if (parsed.kind !== 'grid') throw new Error('expected a grid');
    // The trailing-cell convention now lives at extraction: the range is
    // materialized (bounded by the range itself), never the whole grid.
    expect(extractSourceRange(parsed.grid, { firstRow: 0, firstCol: 0, rowCount: 2, colCount: 3 }))
      .toEqual([['a', 'b', 'c'], ['x', '', '']]);
    // Beyond the widest row the slice stays short — never padded into existence.
    expect(extractSourceRange(parsed.grid, { firstRow: 0, firstCol: 0, rowCount: 2, colCount: 5 }))
      .toEqual([['a', 'b', 'c'], ['x', '', '']]);
  });
});

describe('PR #41 round 2 (1) — refresh revalidates load count and resolution basis', () => {
  it('a load of the same snapshot at another path landing during the read writes NOTHING', async () => {
    const doc = docWithLink();
    const seam = new DeferredSeam();
    const pending = refreshDataLink(doc, seam, 'L1');
    // Codex's case: Drawing.load reuses the SAME frozen link record (the
    // very snapshot is reloaded), so the round-1 record-identity and
    // generation checks still pass after the load — only the load
    // count and the drawing path reveal the document swap.
    doc.load(doc.snapshot, '/proj/other.dxf');
    const loaded = doc.snapshot;
    seam.release(enc(CHANGED_CSV));
    const out = await pending;
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.reason).toBe('link changed during refresh; retry');
    // The refresh wrote nothing into the loaded document.
    expect(doc.snapshot).toBe(loaded);
    expect(tableOf(doc.snapshot).cells.map((r) => r.map((c) => c.text))).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']]);
  });

  it('a Save As during the read (filePath changes, the link untouched) writes NOTHING', async () => {
    const doc = docWithLink();
    const seam = new DeferredSeam();
    const pending = refreshDataLink(doc, seam, 'L1');
    const before = doc.snapshot;
    const dirtyBefore = doc.dirty;
    const revisionBefore = doc.revision;
    // Save As assigns doc.filePath directly (src/app/sessions.ts): no
    // load, no new link record, no generation bump — the round-1 checks
    // cannot see it, but the resolution basis moved mid-read.
    doc.filePath = '/elsewhere/moved.dxf';
    seam.release(enc(CHANGED_CSV));
    const out = await pending;
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.reason).toBe('link changed during refresh; retry');
    // State, history, dirty flag and revision are exactly as the
    // refresh found them; the Save As itself stands.
    expect(doc.snapshot).toBe(before);
    expect(doc.dirty).toBe(dirtyBefore);
    expect(doc.revision).toBe(revisionBefore);
    expect(doc.canUndo()).toBe(true);
    expect(doc.filePath).toBe('/elsewhere/moved.dxf');
    expect(tableOf(doc.snapshot).cells.map((r) => r.map((c) => c.text))).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']]);
    // The read itself went to the path resolved against the OLD basis.
    expect(seam.reads).toEqual(['/proj/data/parts.csv']);
  });

  it('a refresh STARTED after a Save As resolves against the new path and applies (control)', async () => {
    const doc = docWithLink();
    doc.filePath = '/elsewhere/moved.dxf';
    const reads: string[] = [];
    const seam: DataLinkFileSeam = {
      readBytes: async (path: string) => { reads.push(path); return enc(CHANGED_CSV); },
      modifiedAt: async () => undefined,
    };
    const out = await refreshDataLink(doc, seam, 'L1');
    expect(out.kind).toBe('refreshed');
    expect(reads).toEqual(['/elsewhere/data/parts.csv']);
    expect(tableOf(doc.snapshot).cells.map((r) => r.map((c) => c.text))).toEqual([['a', 'B2'], ['c', 'D2'], ['E1', 'F2']]);
  });
});

describe('PR #41 round 2 (2) — the parse cap is checked at every field boundary', () => {
  it('a single row of 1,000,100 commas refuses having pushed no more than the cap', () => {
    // Allocation-counting: count every Array.push the parser performs
    // during the parse (the scan is synchronous, so nothing else runs
    // under the patched prototype). At row end only (the old shape) the
    // row materializes all 1,000,101 fields before any check fires.
    const originalPush = Array.prototype.push as (this: unknown[], ...items: unknown[]) => number;
    let pushes = 0;
    (Array.prototype as { push: unknown }).push = function (this: unknown[], ...items: unknown[]): number {
      pushes += items.length;
      return originalPush.apply(this, items);
    };
    let out: ReturnType<typeof parseDelimitedSource>;
    try {
      out = parseDelimitedSource(enc(','.repeat(1_000_100)), 'f.csv');
    } finally {
      (Array.prototype as { push: unknown }).push = originalPush;
    }
    expect(out.kind).toBe('refuse');
    if (out.kind === 'refuse') {
      expect(out.reason).toBe('source grid bounds 1 rows x 1000001 columns = 1000001 cells, over the 1,000,000-cell parse cap');
    }
    expect(pushes).toBeGreaterThan(0);
    expect(pushes).toBeLessThanOrEqual(1_000_000);
  });
});
