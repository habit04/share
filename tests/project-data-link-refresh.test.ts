/**
 * P31-B data links — host-seam tests (src/app/data-link-refresh.ts).
 *
 * Acceptance example (10) of PROPOSAL-P31-B (parse rules, bounded work,
 * path discipline) plus the end-to-end seam flows: create / refresh /
 * re-range / check through a Drawing, the Q7 drawing-directory resolution
 * with climbsOut refusal, Q8 invalidation through the ONE transact call
 * site, and the in-session-only user notice carried on every outcome.
 */
import { describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { setCellText, type TableCell, type TableEntity } from '../src/core/table';
import type { CadNode } from '../src/core/cad-graph';
import type { Layer } from '../src/core/entities';
import { drawingContentDigest } from '../src/project/canonical-digest';
import { capturePreservedSignature } from '../src/project/drawing-signature';
import {
  DATA_LINKS_NOT_SAVED_NOTICE,
  checkDataLinks,
  createDataLink,
  extractSourceRange,
  parseDelimitedSource,
  reRangeDataLink,
  refreshDataLink,
  type DataLinkFileSeam,
} from '../src/app/data-link-refresh';
import type { CreateDataLinkSpec } from '../src/project/data-links';

const NOW1 = '2026-10-21T00:00:00.000Z';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A captured source state (the cad-graph fixture pattern): a table carrying
 * cadIdentity 'AB12' backed by a retained graph node, built on a sealed
 * Drawing snapshot — the legitimate route to a resolvable link target. */
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
  return { ...base, entities: [table], cadGraph: { schema: 1, documentId: 'p31b-test-source', sourceFormat: 'DXF', nodes: [node] } };
};

const tableOf = (state: DrawingState): TableEntity => state.entities.find((e) => e.type === 'table') as TableEntity;

class FakeSeam implements DataLinkFileSeam {
  readonly files = new Map<string, Uint8Array>();
  readonly mtimes = new Map<string, string>();
  readonly reads: string[] = [];
  async readBytes(path: string): Promise<Uint8Array> {
    this.reads.push(path);
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    return bytes;
  }
  async modifiedAt(path: string): Promise<string | undefined> {
    return this.mtimes.get(path);
  }
}

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

const docWithLink = (seamPath = '/proj/data/parts.csv', csv = 'a,B2\nc,D2\nE1,F2'): { doc: Drawing; seam: FakeSeam } => {
  const doc = new Drawing();
  doc.load(importedState(), '/proj/draw.dxf');
  const created = createDataLink(doc, specFor(doc.snapshot));
  if (created.kind !== 'created') throw new Error(`setup create failed: ${JSON.stringify(created)}`);
  const seam = new FakeSeam();
  seam.files.set(seamPath, enc(csv));
  return { doc, seam };
};

describe('P31-B host seam — end-to-end flows', () => {
  it('create + refresh through the seam: one transact, Q7-relative read, notice on every outcome', async () => {
    const { doc, seam } = docWithLink();
    seam.mtimes.set('/proj/data/parts.csv', '2026-10-20T12:00:00.000Z');
    expect(doc.snapshot.dataLinks).toHaveLength(1);
    const out = await refreshDataLink(doc, seam, 'L1');
    expect(out.kind).toBe('refreshed');
    expect(out.notice).toBe(DATA_LINKS_NOT_SAVED_NOTICE);
    expect(seam.reads).toEqual(['/proj/data/parts.csv']);
    const t = tableOf(doc.snapshot);
    expect(t.cells.map((r) => r.map((c) => c.text))).toEqual([['a', 'B2'], ['c', 'D2'], ['E1', 'F2']]);
    expect(doc.snapshot.dataLinks?.[0]?.lastRefresh?.sourceModifiedAt).toBe('2026-10-20T12:00:00.000Z');
    // A second refresh over the unchanged source is already-current: no transact.
    const before = doc.snapshot;
    const again = await refreshDataLink(doc, seam, 'L1');
    expect(again.kind).toBe('already-current');
    expect(doc.snapshot).toBe(before);
  });

  it('the notice states the in-session-only limit plainly', () => {
    expect(DATA_LINKS_NOT_SAVED_NOTICE).toContain('not saved with the drawing');
    expect(DATA_LINKS_NOT_SAVED_NOTICE).toContain('session');
  });

  it('Q8 through the seam: a refresh invalidates a preserved signature; already-current does not', async () => {
    const { doc, seam } = docWithLink();
    const record = capturePreservedSignature({
      payload: new Uint8Array([7, 7]),
      contentDigest: drawingContentDigest(doc.snapshot),
      sourceFormat: 'DXF',
    });
    doc.load({ ...doc.snapshot, signatureRecord: record }, '/proj/draw.dxf');
    expect(doc.snapshot.signatureRecord?.status).toBe('preserved-unverified');
    const out = await refreshDataLink(doc, seam, 'L1');
    expect(out.kind).toBe('refreshed');
    expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot.signatureRecord?.status).toBe('preserved-unverified');
  });

  it('drift through the seam: needs-confirmation writes nothing; confirmation refreshes', async () => {
    const { doc, seam } = docWithLink();
    const first = await refreshDataLink(doc, seam, 'L1');
    expect(first.kind).toBe('refreshed');
    const tid = tableOf(doc.snapshot).id;
    doc.transact((s) => ({
      ...s,
      entities: s.entities.map((e) => (e.id === tid ? setCellText(e as TableEntity, 0, 1, 'HAND') : e)),
    }));
    seam.files.set('/proj/data/parts.csv', enc('a,B9\nc,D2\nE1,F2'));
    const before = doc.snapshot;
    const out = await refreshDataLink(doc, seam, 'L1');
    expect(out.kind).toBe('needs-confirmation');
    if (out.kind === 'needs-confirmation') expect(out.issue.cells).toEqual([[0, 1]]);
    expect(doc.snapshot).toBe(before);
    const confirmed = await refreshDataLink(doc, seam, 'L1', { confirmOverwrite: true });
    expect(confirmed.kind).toBe('refreshed');
    expect(tableOf(doc.snapshot).cells[0]![1]!.text).toBe('B9');
  });

  it('re-range through the seam re-baselines the link record', async () => {
    const { doc } = docWithLink();
    const out = reRangeDataLink(doc, 'L1', { sourceRange: { firstRow: 0, firstCol: 0, rowCount: 2, colCount: 2 } }, '2026-10-21T03:00:00.000Z');
    expect(out.kind).toBe('re-ranged');
    expect(out.notice).toBe(DATA_LINKS_NOT_SAVED_NOTICE);
    expect(doc.snapshot.dataLinks?.[0]?.sourceRange.rowCount).toBe(2);
    expect(doc.snapshot.dataLinks?.[0]?.lastRefresh?.gridRows).toBe(3);
    expect(doc.snapshot.dataLinks?.[0]?.lastRefresh?.refreshedAt).toBe('2026-10-21T03:00:00.000Z');
  });

  it('checkDataLinks reports staleness and unreadable sources without touching the drawing', async () => {
    const { doc, seam } = docWithLink();
    await refreshDataLink(doc, seam, 'L1');
    seam.files.set('/proj/data/parts.csv', enc('a,CHANGED\nc,D2\nE1,F2'));
    const before = doc.snapshot;
    const report = await checkDataLinks(doc, seam);
    expect(report).toHaveLength(1);
    expect(report[0]!.issues.map((i) => i.kind)).toContain('stale');
    expect(doc.snapshot).toBe(before);
    seam.files.delete('/proj/data/parts.csv');
    const report2 = await checkDataLinks(doc, seam);
    expect(report2[0]!.issues.map((i) => i.kind)).toContain('source-unreadable');
    expect(doc.snapshot).toBe(before);
  });

  it('an unknown link id refuses cleanly', async () => {
    const { doc, seam } = docWithLink();
    const out = await refreshDataLink(doc, seam, 'NOPE');
    expect(out.kind).toBe('refused');
    expect(out.notice).toBe(DATA_LINKS_NOT_SAVED_NOTICE);
  });
});

describe('P31-B host seam — (10) parse rules', () => {
  it('parses quoted fields, embedded delimiters/newlines and escaped quotes', () => {
    const out = parseDelimitedSource(enc('"a""b",c\n"x,\ny",d'), 'f.csv');
    expect(out).toEqual({ kind: 'grid', grid: [['a"b', 'c'], ['x,\ny', 'd']] });
  });
  it('strips a UTF-8 BOM and accepts CRLF line endings', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('a,b\r\nc,d\r\n')]);
    expect(parseDelimitedSource(bytes, 'f.csv')).toEqual({ kind: 'grid', grid: [['a', 'b'], ['c', 'd']] });
  });
  it('uses the delimiter fixed by extension: tab for .tsv, and refuses unknown types (no sniffing)', () => {
    expect(parseDelimitedSource(enc('a\tb\nc\td'), 'f.tsv')).toEqual({ kind: 'grid', grid: [['a', 'b'], ['c', 'd']] });
    expect(parseDelimitedSource(enc('a\tb'), 'f.csv')).toEqual({ kind: 'grid', grid: [['a\tb']] });
    expect(parseDelimitedSource(enc('a,b'), 'f.xlsx').kind).toBe('refuse');
  });
  it('pads short rows with empty cells (the stated trailing-cell convention)', () => {
    expect(parseDelimitedSource(enc('a,b,c\nx'), 'f.csv')).toEqual({ kind: 'grid', grid: [['a', 'b', 'c'], ['x', '', '']] });
  });
  it('refuses malformed quotes: unterminated field and junk after a closing quote', () => {
    expect(parseDelimitedSource(enc('"abc'), 'f.csv').kind).toBe('refuse');
    expect(parseDelimitedSource(enc('"ab"x,c'), 'f.csv').kind).toBe('refuse');
  });
  it('refuses undecodable bytes and accepts an empty file as an empty grid', () => {
    expect(parseDelimitedSource(new Uint8Array([0x61, 0xff, 0x62]), 'f.csv').kind).toBe('refuse');
    expect(parseDelimitedSource(new Uint8Array(0), 'f.csv')).toEqual({ kind: 'grid', grid: [] });
  });
  it('extractSourceRange slices exactly what the file covers — never padded into existence', () => {
    const grid = [['a', 'b'], ['c', 'd']];
    expect(extractSourceRange(grid, { firstRow: 0, firstCol: 0, rowCount: 2, colCount: 2 })).toEqual(grid);
    expect(extractSourceRange(grid, { firstRow: 1, firstCol: 0, rowCount: 5, colCount: 2 })).toEqual([['c', 'd']]);
    expect(extractSourceRange(grid, { firstRow: 9, firstCol: 0, rowCount: 2, colCount: 2 })).toEqual([]);
  });
});

describe('P31-B host seam — (10) bounds and path discipline', () => {
  it('refuses a source over the 8 MiB cap before parsing; the drawing is untouched', async () => {
    const { doc, seam } = docWithLink();
    seam.files.set('/proj/data/parts.csv', new Uint8Array(8 * 1024 * 1024 + 1));
    const before = doc.snapshot;
    const out = await refreshDataLink(doc, seam, 'L1');
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.reason).toMatch(/8 MiB|size|cap/i);
    expect(doc.snapshot).toBe(before);
  });

  it('refuses a single cell over the 32 KiB cap', async () => {
    const { doc, seam } = docWithLink();
    seam.files.set('/proj/data/parts.csv', enc(`a,${'x'.repeat(33 * 1024)}\nc,d\ne,f`));
    const out = await refreshDataLink(doc, seam, 'L1');
    expect(out.kind).toBe('refused');
  });

  it('refuses an over-cap range at creation (>100,000 cells)', () => {
    const doc = new Drawing();
    doc.load(importedState(), '/proj/draw.dxf');
    const out = createDataLink(doc, specFor(doc.snapshot, { sourceRange: { firstRow: 0, firstCol: 0, rowCount: 200, colCount: 600 } }));
    expect(out.kind).toBe('refused');
    expect(doc.snapshot.dataLinks).toBeUndefined();
  });

  it('refuses a malformed-quote source as a whole refresh, drawing untouched', async () => {
    const { doc, seam } = docWithLink();
    seam.files.set('/proj/data/parts.csv', enc('a,"unterminated\nc,d\ne,f'));
    const before = doc.snapshot;
    const out = await refreshDataLink(doc, seam, 'L1');
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.issue?.kind).toBe('source-parse-refused');
    expect(doc.snapshot).toBe(before);
  });

  it('a formula-looking source cell lands as literal text — refresh never evaluates', async () => {
    const { doc, seam } = docWithLink('/proj/data/parts.csv', '=SUM(A1:A2),b\nc,d\ne,f');
    const out = await refreshDataLink(doc, seam, 'L1');
    expect(out.kind).toBe('refreshed');
    expect(tableOf(doc.snapshot).cells[0]![0]!.text).toBe('=SUM(A1:A2)');
  });

  it('Q7: a relative path climbing out of the drawing tree refuses and is never read', async () => {
    const doc = new Drawing();
    doc.load(importedState(), '/proj/draw.dxf');
    const created = createDataLink(doc, specFor(doc.snapshot, { sourcePath: '../secret.csv' }));
    expect(created.kind).toBe('created');
    const seam = new FakeSeam();
    seam.files.set('/secret.csv', enc('a,b\nc,d\ne,f'));
    const out = await refreshDataLink(doc, seam, 'L1');
    expect(out.kind).toBe('refused');
    expect(seam.reads).toEqual([]);
  });

  it('Q7: an absolute source path is used as recorded, even outside the drawing tree', async () => {
    const doc = new Drawing();
    doc.load(importedState(), '/proj/draw.dxf');
    const created = createDataLink(doc, specFor(doc.snapshot, { sourcePath: '/elsewhere/abs.csv' }));
    expect(created.kind).toBe('created');
    const seam = new FakeSeam();
    seam.files.set('/elsewhere/abs.csv', enc('a,B2\nc,D2\nE1,F2'));
    const out = await refreshDataLink(doc, seam, 'L1');
    expect(out.kind).toBe('refreshed');
    expect(seam.reads).toEqual(['/elsewhere/abs.csv']);
  });

  it('Q7: a relative path on an unsaved drawing refuses (no base directory)', async () => {
    const doc = new Drawing();
    doc.load(importedState());
    const created = createDataLink(doc, specFor(doc.snapshot));
    expect(created.kind).toBe('created');
    const seam = new FakeSeam();
    const out = await refreshDataLink(doc, seam, 'L1');
    expect(out.kind).toBe('refused');
    expect(seam.reads).toEqual([]);
  });

  it('refuses a network source outright', async () => {
    const doc = new Drawing();
    doc.load(importedState(), '/proj/draw.dxf');
    const created = createDataLink(doc, specFor(doc.snapshot, { sourcePath: 'https://example.invalid/x.csv' }));
    expect(created.kind).toBe('created');
    const seam = new FakeSeam();
    const out = await refreshDataLink(doc, seam, 'L1');
    expect(out.kind).toBe('refused');
    expect(seam.reads).toEqual([]);
  });
});
