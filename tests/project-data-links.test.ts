/**
 * P31-B data links — acceptance tests for PROPOSAL-P31-B (ADMITTED FOR
 * DEVELOPMENT by the lead 2026-10-21 with Q1 digest-EXCLUDED, Q7 drawing-dir
 * path resolution, Q8 refresh-is-an-edit dispositions).
 *
 * The proposal's 10 failing-first acceptance examples are the spine; this
 * file covers examples (1)–(9) at the pure-module / Drawing level. Example
 * (10) (parse + bounds + path discipline through the host seam) lives in
 * tests/project-data-link-refresh.test.ts.
 *
 * At the branch head before this slice every case fails because the surface
 * (src/project/data-links.ts, DrawingState.dataLinks) does not exist.
 */
import { describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity, Layer } from '../src/core/entities';
import type { Layout } from '../src/core/layouts';
import type { TableCell, TableEntity } from '../src/core/table';
import type { CadNode } from '../src/core/cad-graph';
import { drawingContentDigest } from '../src/project/canonical-digest';
import {
  capturePreservedSignature,
  type PreservedSignatureRecord,
} from '../src/project/drawing-signature';
import {
  cellFingerprint,
  dataLinkIssues,
  evaluateCreateDataLink,
  evaluateRefreshDataLink,
  evaluateReRangeDataLink,
  snapshotDigest,
  sourceSnapshotOf,
  validateDataLinks,
  type CreateDataLinkSpec,
  type DataLink,
} from '../src/project/data-links';
import { readDxf, writeDxf } from '../src/io/dxf';

const layer0: Layer = { name: '0', color: 7, visible: true, locked: false, lineWeight: -1 };
const NOW1 = '2026-10-21T00:00:00.000Z';
const NOW2 = '2026-10-21T01:00:00.000Z';
const NOW3 = '2026-10-21T02:00:00.000Z';

const line = (id: string): Entity => ({
  id, type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 1 },
} as Entity);

const makeTable = (over: Partial<TableEntity> = {}): TableEntity => ({
  id: 't1', type: 'table', layer: '0', color: 'ByLayer', cadIdentity: 'AB12',
  position: { x: 0, y: 0 }, rotation: 0,
  rowHeights: [1, 1, 1], columnWidths: [2, 2],
  cells: [
    [{ text: 'a' }, { text: 'b' }],
    [{ text: 'c', raw: '39' }, { text: 'd' }],
    [{ text: 'e' }, { text: 'f' }],
  ],
  textHeight: 0.18,
  ...over,
});

const stateWith = (entities: readonly Entity[], extra: Partial<DrawingState> = {}): DrawingState => ({
  entities: [...entities], layers: [layer0], blocks: {}, currentLayer: '0', ...extra,
});

const createSpec = (over: Partial<CreateDataLinkSpec> = {}): CreateDataLinkSpec => ({
  id: 'L1',
  sourcePath: 'data/parts.csv',
  sourceRange: { firstRow: 0, firstCol: 0, rowCount: 3, colCount: 2 },
  tableId: 't1',
  firstRow: 0,
  firstCol: 0,
  now: NOW1,
  ...over,
});

const mustCreate = (state: DrawingState, spec: CreateDataLinkSpec = createSpec()): DataLink => {
  const ev = evaluateCreateDataLink(state, spec);
  if (ev.kind !== 'create') throw new Error(`expected create, got refuse: ${ev.message}`);
  return ev.link;
};

const tableOf = (state: DrawingState, id = 't1'): TableEntity =>
  state.entities.find((e) => e.id === id) as TableEntity;

/** makeTable() without the cadIdentity: safe to hand to a Drawing directly. */
const plainTable = (over: Partial<TableEntity> = {}): TableEntity => {
  const { cadIdentity: _identity, ...rest } = makeTable(over);
  return rest as TableEntity;
};

/**
 * A captured source state (the cad-graph fixture pattern): a table carrying
 * cadIdentity 'AB12', backed by a retained graph node anchoring it, built on
 * a sealed Drawing snapshot. The only legitimate way to put an
 * identity-carrying entity into a Drawing by hand.
 */
const capturedTableState = (): DrawingState => {
  const table = makeTable();
  const base = new Drawing(stateWith([plainTable()])).snapshot;
  const node: CadNode = {
    id: 'AB12', sourceHandle: 'AB12', type: 'ACAD_TABLE', section: 'ENTITIES',
    anchor: { kind: 'entity', id: 't1' }, baselineEntity: table,
    groups: [[5, 'AB12']],
  };
  return { ...base, entities: [table], cadGraph: { schema: 1, documentId: 'p31b-test-source', sourceFormat: 'DXF', nodes: [node] } };
};

const layout1: Layout = {
  name: 'Layout1',
  paper: { id: 'custom', width: 297, height: 210, units: 'mm', orientation: 'landscape' },
  plotScale: '1:1',
  margins: { left: 0, bottom: 0, right: 0, top: 0 },
  entities: [],
  viewports: [],
};

describe('P31-B data links — acceptance examples (PROPOSAL-P31-B)', () => {
  it('(1) HAPPY REFRESH: one transact writes owner cells, clears changed raw, replaces lastRefresh atomically', () => {
    const state = stateWith([makeTable()]);
    const link = mustCreate(state);
    // Creation baselines lastRefresh on the CURRENT cells (cells-as-snapshot).
    expect(link.lastRefresh?.gridRows).toBe(3);
    expect(link.lastRefresh?.gridCols).toBe(2);
    expect(link.lastRefresh?.cellFingerprints).toHaveLength(6);
    expect(link.lastRefresh?.cellFingerprints[0]).toBe(cellFingerprint({ text: 'a' }));
    expect(link.lastRefresh?.refreshedAt).toBe(NOW1);
    expect(link.target.tableCadIdentity).toBe('AB12');
    expect(link.direction).toBe('down');

    // The pure builder's write semantics (raw cleared/kept) …
    const snapshot = sourceSnapshotOf([['a', 'B2'], ['c', 'D2'], ['E1', 'F2']]);
    const pure = evaluateRefreshDataLink({ ...state, dataLinks: [link] }, link, snapshot, { now: NOW2 });
    expect(pure.kind).toBe('proceed');
    if (pure.kind !== 'proceed') return;
    expect(tableOf(pure.next).cells[0]![1]!.raw).toBeUndefined();
    expect(tableOf(pure.next).cells[1]![0]!.raw).toBe('39');
    // … and the same evaluation as ONE Drawing transaction on a captured state.
    const captured = capturedTableState();
    const docLink = mustCreate(captured);
    const doc = new Drawing({ ...captured, dataLinks: [docLink] });
    const ev = evaluateRefreshDataLink(doc.snapshot, docLink, snapshot, { now: NOW2, sourceModifiedAt: '2026-10-20T00:00:00.000Z' });
    expect(ev.kind).toBe('proceed');
    if (ev.kind !== 'proceed') return;
    doc.transactDrawing(() => ev.next);
    const t = tableOf(doc.snapshot);
    expect(t.cells.map((r) => r.map((c) => c.text))).toEqual([['a', 'B2'], ['c', 'D2'], ['E1', 'F2']]);
    const lr = doc.snapshot.dataLinks?.[0]?.lastRefresh;
    expect(lr?.sourceDigest).toBe(snapshot.digest);
    expect(lr?.sourceDigest).toBe(snapshotDigest([['a', 'B2'], ['c', 'D2'], ['E1', 'F2']]));
    expect(lr?.sourceModifiedAt).toBe('2026-10-20T00:00:00.000Z');
    expect(lr?.refreshedAt).toBe(NOW2);
    expect(lr?.gridRows).toBe(3);
    expect(lr?.cellFingerprints).toHaveLength(6);
    expect(lr?.cellFingerprints[1]).toBe(cellFingerprint({ text: 'B2' }));
    // ONE undo restores cells AND the prior lastRefresh together.
    expect(doc.undo()).toBe(true);
    expect(tableOf(doc.snapshot).cells[0]![1]!.text).toBe('b');
    expect(doc.snapshot.dataLinks?.[0]?.lastRefresh?.refreshedAt).toBe(NOW1);
    expect(doc.redo()).toBe(true);
    expect(tableOf(doc.snapshot).cells[0]![1]!.text).toBe('B2');
  });

  it('(2) DRIFT CONFIRMATION: an edited cell is reported with its coordinate; nothing writes until confirmed', () => {
    const state = stateWith([makeTable()]);
    const link = mustCreate(state);
    const linked = { ...state, dataLinks: [link] };
    // First refresh proceeds (source differs from the cells).
    const snap1 = sourceSnapshotOf([['a', 'B2'], ['c', 'D2'], ['E1', 'F2']]);
    const ev1 = evaluateRefreshDataLink(linked, link, snap1, { now: NOW2 });
    expect(ev1.kind).toBe('proceed');
    if (ev1.kind !== 'proceed') return;
    // The user then edits one cell by hand.
    const editedTable = tableOf(ev1.next);
    const drifted: DrawingState = {
      ...ev1.next,
      entities: [{
        ...editedTable,
        cells: editedTable.cells.map((row, r) => row.map((cell, c) => (r === 0 && c === 1 ? { ...cell, text: 'HAND' } : cell))),
      }],
    };
    const liveLink = drifted.dataLinks![0]!;
    const snap2 = sourceSnapshotOf([['a', 'B9'], ['c', 'D2'], ['E1', 'F2']]);
    const ev2 = evaluateRefreshDataLink(drifted, liveLink, snap2, { now: NOW3 });
    expect(ev2.kind).toBe('needs-confirmation');
    if (ev2.kind !== 'needs-confirmation') return;
    expect(ev2.issue.kind).toBe('cells-modified-since-refresh');
    expect(ev2.issue.cells).toEqual([[0, 1]]);
    // Evaluation is pure: the drifted state is untouched.
    expect(tableOf(drifted).cells[0]![1]!.text).toBe('HAND');
    const ev3 = evaluateRefreshDataLink(drifted, liveLink, snap2, { now: NOW3, confirmOverwrite: true });
    expect(ev3.kind).toBe('proceed');
    if (ev3.kind !== 'proceed') return;
    expect(tableOf(ev3.next).cells[0]![1]!.text).toBe('B9');
  });

  it('(3) GRID-SHAPE REFUSAL, both limbs: refusal is unconditional; re-range is the remedy', () => {
    const state = stateWith([makeTable()]);
    const link = mustCreate(state);
    const snap = sourceSnapshotOf([['a', 'b'], ['c', 'd'], ['e', 'f']]);

    // Limb A: a row inserted ABOVE the rectangle shifts every target row.
    const taller = makeTable({
      rowHeights: [1, 1, 1, 1],
      cells: [
        [{ text: 'NEWROW' }, { text: 'NEWROW' }],
        [{ text: 'a' }, { text: 'b' }],
        [{ text: 'c', raw: '39' }, { text: 'd' }],
        [{ text: 'e' }, { text: 'f' }],
      ],
    });
    const evA = evaluateRefreshDataLink({ ...state, entities: [taller], dataLinks: [link] }, link, snap, { now: NOW2, confirmOverwrite: true });
    expect(evA.kind).toBe('refuse');
    if (evA.kind === 'refuse') expect(evA.issue.kind).toBe('grid-shape-changed');

    // Limb B: identical rows — every fingerprint still matches, shape changed.
    const uniform = (rows: number): TableEntity => makeTable({
      rowHeights: Array.from({ length: rows }, () => 1),
      cells: Array.from({ length: rows }, () => [{ text: 'x' }, { text: 'x' }]),
    });
    const linkU = mustCreate(stateWith([uniform(3)]), createSpec({ id: 'LU' }));
    const grown = { ...stateWith([uniform(4)]), dataLinks: [linkU] };
    const snapU = sourceSnapshotOf([['x', 'x'], ['x', 'x'], ['x', 'x']]);
    const evB = evaluateRefreshDataLink(grown, linkU, snapU, { now: NOW2, confirmOverwrite: true });
    expect(evB.kind).toBe('refuse');
    if (evB.kind === 'refuse') expect(evB.issue.kind).toBe('grid-shape-changed');

    // Remedy: explicit re-range re-baselines; a matching refresh then proceeds.
    const rr = evaluateReRangeDataLink(grown, linkU, { sourceRange: { firstRow: 0, firstCol: 0, rowCount: 4, colCount: 2 } }, NOW3);
    expect(rr.kind).toBe('rerange');
    if (rr.kind !== 'rerange') return;
    const reRanged = { ...grown, dataLinks: [rr.link] };
    const evC = evaluateRefreshDataLink(reRanged, rr.link, sourceSnapshotOf([['x', 'x'], ['x', 'x'], ['x', 'x'], ['Y', 'x']]), { now: NOW3 });
    expect(evC.kind).toBe('proceed');
  });

  it('(4) SOURCE-SHAPE REFUSAL: the source gaining a row refuses; no cell is ever written', () => {
    const state = stateWith([makeTable()]);
    const link = mustCreate(state);
    const linked = { ...state, dataLinks: [link] };
    const grown = sourceSnapshotOf([['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h']]);
    const ev = evaluateRefreshDataLink(linked, link, grown, { now: NOW2 });
    expect(ev.kind).toBe('refuse');
    if (ev.kind === 'refuse') expect(ev.issue.kind).toBe('source-shape-changed');
    const shrunk = sourceSnapshotOf([['a', 'b'], ['c', 'd']]);
    const ev2 = evaluateRefreshDataLink(linked, link, shrunk, { now: NOW2 });
    expect(ev2.kind).toBe('refuse');
    if (ev2.kind === 'refuse') expect(ev2.issue.kind).toBe('source-shape-changed');
    // The linked state itself is unchanged by the evaluations.
    expect(tableOf(linked).cells[2]![0]!.text).toBe('e');
  });

  it('(5) RESOLUTION FAILURES: broken, ambiguous, and born-unresolvable links never silently rebind', () => {
    const state = stateWith([makeTable()]);
    const link = mustCreate(state);
    const snap = sourceSnapshotOf([['a', 'b'], ['c', 'd'], ['e', 'f']]);

    // Table deleted → broken; the link is NOT deleted or retargeted.
    const orphaned = { ...stateWith([line('e9')]), dataLinks: [link] };
    expect(dataLinkIssues(orphaned, link).map((i) => i.kind)).toContain('broken');
    const evBroken = evaluateRefreshDataLink(orphaned, link, snap, { now: NOW2 });
    expect(evBroken.kind).toBe('refuse');
    if (evBroken.kind === 'refuse') expect(evBroken.issue.kind).toBe('broken');
    expect(orphaned.dataLinks).toHaveLength(1);

    // Duplicated cadIdentity → ambiguous; neither table is written.
    const dup = stateWith([makeTable(), makeTable({ id: 't2' })], { dataLinks: [link] });
    expect(dataLinkIssues(dup, link).map((i) => i.kind)).toContain('ambiguous');
    const evAmb = evaluateRefreshDataLink(dup, link, snap, { now: NOW2 });
    expect(evAmb.kind).toBe('refuse');
    if (evAmb.kind === 'refuse') expect(evAmb.issue.kind).toBe('ambiguous');

    // A cadIdentity-less table may be linked in-session, born unresolvable-on-reopen.
    const bare = makeTable();
    delete (bare as { cadIdentity?: string }).cadIdentity;
    const bareState = stateWith([bare]);
    const evBare = evaluateCreateDataLink(bareState, createSpec({ id: 'LB' }));
    expect(evBare.kind).toBe('create');
    if (evBare.kind !== 'create') return;
    expect(evBare.link.target.tableCadIdentity).toBeUndefined();
    expect(evBare.issues.map((i) => i.kind)).toContain('unresolvable-on-reopen');
    const bareLinked = { ...bareState, dataLinks: [evBare.link] };
    expect(dataLinkIssues(bareLinked, evBare.link).map((i) => i.kind)).toContain('unresolvable-on-reopen');
    // With no durable key the refresh cannot resolve it in-session either.
    const evBareRefresh = evaluateRefreshDataLink(bareLinked, evBare.link, snap, { now: NOW2 });
    expect(evBareRefresh.kind).toBe('refuse');
  });

  it('(6) CARRIER-COVERED CELLS: refresh writes OWNER cells only; a merge cut by the rectangle refuses', () => {
    const coveredCell: TableCell = { text: 'COVERED', raw: '40' };
    const merged = makeTable({
      rowHeights: [1, 1],
      cells: [
        [{ text: 'OLD', raw: '39', span: { rows: 1, cols: 2 } }, coveredCell],
        [{ text: 'x' }, { text: 'y' }],
      ],
    });
    const state = stateWith([merged]);
    const link = mustCreate(state, createSpec({ sourceRange: { firstRow: 0, firstCol: 0, rowCount: 2, colCount: 2 } }));
    // Three OWNER cells under the rectangle: (0,0), (1,0), (1,1).
    expect(link.lastRefresh?.cellFingerprints).toHaveLength(3);
    const linked = { ...state, dataLinks: [link] };
    const ev = evaluateRefreshDataLink(linked, link, sourceSnapshotOf([['NEW', 'IGNORED'], ['X2', 'Y2']]), { now: NOW2 });
    expect(ev.kind).toBe('proceed');
    if (ev.kind !== 'proceed') return;
    const t = tableOf(ev.next);
    expect(t.cells[0]![0]!.text).toBe('NEW');
    expect(t.cells[0]![0]!.raw).toBeUndefined();
    expect(t.cells[0]![0]!.span).toEqual({ rows: 1, cols: 2 });
    // The covered cell is never a write target: object, text and raw untouched.
    expect(t.cells[0]![1]).toBe(coveredCell);
    expect(t.cells[0]![1]!.text).toBe('COVERED');
    // The refreshed state round-trips through the base DXF path (INSERT +
    // JCAD_TABLE carrier) with the covered content preserved.
    const back = readDxf(writeDxf(ev.next));
    const bt = back.entities.find((e) => e.type === 'table') as TableEntity;
    expect(bt.cells[0]![0]!.text).toBe('NEW');
    expect(bt.cells[0]![1]!.text).toBe('COVERED');
    expect(bt.cells[0]![1]!.raw).toBe('40');

    // A rectangle CUTTING a merge refuses at creation …
    const cut = evaluateCreateDataLink(state, createSpec({ id: 'LC', sourceRange: { firstRow: 0, firstCol: 0, rowCount: 1, colCount: 1 }, firstRow: 0, firstCol: 0 }));
    expect(cut.kind).toBe('refuse');
    if (cut.kind === 'refuse') expect(cut.issue?.kind).toBe('merge-boundary');
    const cutAtCovered = evaluateCreateDataLink(state, createSpec({ id: 'LD', sourceRange: { firstRow: 0, firstCol: 0, rowCount: 1, colCount: 1 }, firstRow: 0, firstCol: 1 }));
    expect(cutAtCovered.kind).toBe('refuse');
    if (cutAtCovered.kind === 'refuse') expect(cutAtCovered.issue?.kind).toBe('merge-boundary');

    // … and at refresh, when an edit introduces a cut after creation.
    const plain = makeTable({ rowHeights: [1, 1], cells: [[{ text: 'p' }, { text: 'q' }], [{ text: 'r' }, { text: 's' }]] });
    const topLink = mustCreate(stateWith([plain]), createSpec({ id: 'LT', sourceRange: { firstRow: 0, firstCol: 0, rowCount: 1, colCount: 2 } }));
    const cutTable: TableEntity = {
      ...plain,
      cells: [[{ text: 'p', span: { rows: 2, cols: 1 } }, { text: 'q' }], [{ text: 'r' }, { text: 's' }]],
    };
    const cutState = { ...stateWith([cutTable]), dataLinks: [topLink] };
    const evCut = evaluateRefreshDataLink(cutState, topLink, sourceSnapshotOf([['P2', 'Q2']]), { now: NOW2 });
    expect(evCut.kind).toBe('refuse');
    if (evCut.kind === 'refuse') expect(evCut.issue.kind).toBe('merge-boundary');
  });

  it('(7) SURVIVAL + INERTNESS: links ride unrelated edits untouched; a link-less drawing is unchanged', () => {
    const state = stateWith([plainTable()]);
    const link = mustCreate(state);
    const doc = new Drawing({ ...state, dataLinks: [link], layouts: [layout1] });
    const linksRef = doc.snapshot.dataLinks;
    expect(doc.snapshot.dataLinks).toEqual([link]);

    doc.transact((s) => ({ ...s, entities: [...s.entities, line('e2')] }));
    expect(doc.snapshot.dataLinks).toBe(linksRef);
    doc.setHeader({ ltscale: 2 });
    expect(doc.snapshot.dataLinks).toBe(linksRef);
    doc.setSpace({ layout: 'Layout1' });
    expect(doc.snapshot.dataLinks).toBe(linksRef);
    doc.transact((s) => ({ ...s, entities: [...s.entities, line('p1')] }));
    expect(doc.snapshot.dataLinks).toBe(linksRef);
    expect(doc.snapshot.layouts?.[0]?.entities.map((e) => e.id)).toEqual(['p1']);

    // Park / restore: history snapshot + load keep the records identical.
    const parked = new Drawing();
    parked.load(doc.snapshot);
    parked.restoreHistory(doc.history());
    expect(parked.snapshot.dataLinks).toEqual([link]);
    // Load must not resurrect a previous document's links.
    parked.load(stateWith([line('only')]));
    expect(parked.snapshot.dataLinks).toBeUndefined();

    // Control: a link-less drawing through the same cycle stays link-less and
    // is otherwise identical to the linked drawing minus the sibling field.
    const control = new Drawing({ ...state, layouts: [layout1] });
    control.transact((s) => ({ ...s, entities: [...s.entities, line('e2')] }));
    control.setHeader({ ltscale: 2 });
    control.setSpace({ layout: 'Layout1' });
    control.transact((s) => ({ ...s, entities: [...s.entities, line('p1')] }));
    expect(control.snapshot.dataLinks).toBeUndefined();
    expect({ ...doc.snapshot, dataLinks: undefined }).toEqual(control.snapshot);
  });

  it('(8) SIGNATURE INTERPLAY (Q8): refresh and creation invalidate in the same operation; checks never do', () => {
    const state = stateWith([plainTable()]);
    const signedDoc = (): { doc: Drawing; record: PreservedSignatureRecord; link: DataLink } => {
      const captured = capturedTableState();
      const link = mustCreate(captured);
      const doc = new Drawing({ ...captured, dataLinks: [link] });
      const record = capturePreservedSignature({
        payload: new Uint8Array([0xde, 0xad]),
        contentDigest: drawingContentDigest(doc.snapshot),
        sourceFormat: 'DWG',
      });
      doc.load({ ...doc.snapshot, signatureRecord: record });
      return { doc, record, link };
    };

    // Refresh invalidates in the same operation; undo restores both.
    {
      const { doc, link } = signedDoc();
      expect(doc.snapshot.signatureRecord?.status).toBe('preserved-unverified');
      const ev = evaluateRefreshDataLink(doc.snapshot, link, sourceSnapshotOf([['a', 'B2'], ['c', 'D2'], ['E1', 'F2']]), { now: NOW2 });
      expect(ev.kind).toBe('proceed');
      if (ev.kind !== 'proceed') return;
      doc.transactDrawing(() => ev.next);
      expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
      expect(doc.undo()).toBe(true);
      expect(doc.snapshot.signatureRecord?.status).toBe('preserved-unverified');
      expect(tableOf(doc.snapshot).cells[0]![1]!.text).toBe('b');
    }
    // Link-record-only edits (creation) invalidate likewise — no special case.
    {
      const doc = new Drawing(state);
      const record = capturePreservedSignature({
        payload: new Uint8Array([0xbe, 0xef]),
        contentDigest: drawingContentDigest(doc.snapshot),
        sourceFormat: 'DWG',
      });
      doc.load({ ...doc.snapshot, signatureRecord: record });
      const created = evaluateCreateDataLink(doc.snapshot, createSpec({ id: 'L2' }));
      expect(created.kind).toBe('create');
      if (created.kind !== 'create') return;
      doc.transactDrawing((s) => ({ ...s, dataLinks: [created.link] }));
      expect(doc.snapshot.signatureRecord?.status).toBe('invalidated-by-edit');
    }
    // Already-current performs NO transaction and does NOT invalidate.
    {
      const { doc, link } = signedDoc();
      const before = doc.snapshot;
      const current = sourceSnapshotOf([['a', 'b'], ['c', 'd'], ['e', 'f']]);
      // Baseline was taken over the current cells, so this snapshot is current.
      const ev = evaluateRefreshDataLink(doc.snapshot, link, current, { now: NOW2 });
      expect(ev.kind).toBe('already-current');
      expect(doc.snapshot).toBe(before);
      expect(doc.snapshot.signatureRecord?.status).toBe('preserved-unverified');
    }
    // Staleness computation is read-only: it reports, never invalidates.
    {
      const { doc, link } = signedDoc();
      const before = doc.snapshot;
      const issues = dataLinkIssues(doc.snapshot, link, { digest: snapshotDigest([['zz', 'zz'], ['zz', 'zz'], ['zz', 'zz']]) });
      expect(issues.map((i) => i.kind)).toContain('stale');
      expect(doc.snapshot).toBe(before);
      expect(doc.snapshot.signatureRecord?.status).toBe('preserved-unverified');
    }
  });

  it('(8b) Q1 DIGEST DISPOSITION: dataLinks is EXCLUDED from the canonical digest; linked content is not', () => {
    const state = stateWith([makeTable()]);
    const link = mustCreate(state);
    const withLinks = { ...state, dataLinks: [link] };
    // A link-carrying state digests at all … and to the SAME digest as the
    // identical state without the sibling: the exclusion attests nothing
    // about the link records themselves.
    expect(drawingContentDigest(withLinks)).toBe(drawingContentDigest(state));
    const relinked = { ...state, dataLinks: [{ ...link, sourcePath: 'elsewhere/other.csv' }] };
    expect(drawingContentDigest(relinked)).toBe(drawingContentDigest(state));
    // The linked cell CONTENT is ordinary digested table content.
    const editedCells = {
      ...state,
      entities: [{
        ...makeTable(),
        cells: makeTable().cells.map((row, r) => row.map((cell, c) => (r === 0 && c === 0 ? { ...cell, text: 'CHANGED' } : cell))),
      }],
      dataLinks: [link],
    };
    expect(drawingContentDigest(editedCells)).not.toBe(drawingContentDigest(state));
  });

  it('(9) SEAL SCOPE: link records are seal-certified plain data; hostile values are refused, no exemption', () => {
    const state = stateWith([plainTable()]);
    const link = mustCreate(state);
    const doc = new Drawing({ ...state, dataLinks: [link] });
    const sealed = doc.snapshot.dataLinks![0]!;
    expect(Object.isFrozen(doc.snapshot.dataLinks)).toBe(true);
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.sourceRange)).toBe(true);
    expect(Object.isFrozen(sealed.lastRefresh)).toBe(true);
    expect(Object.isFrozen(sealed.lastRefresh!.cellFingerprints)).toBe(true);
    expect(() => {
      (sealed as { sourcePath: string }).sourcePath = 'evil.csv';
    }).toThrow(TypeError);
    expect(doc.snapshot.dataLinks![0]!.sourcePath).toBe('data/parts.csv');

    // Hostile states are refused by the validator on the Drawing path.
    const hostilePath = { ...link, sourcePath: new Uint8Array([1, 2]) as unknown as string };
    expect(() => new Drawing({ ...state, dataLinks: [hostilePath] })).toThrow();
    const hostileFn = { ...link, lastRefresh: { ...link.lastRefresh!, refreshedAt: (() => NOW1) as unknown as string } };
    expect(() => new Drawing({ ...state, dataLinks: [hostileFn] })).toThrow();
    // Validator specifics: duplicate ids, cap overflow, malformed digest,
    // unknown keys, non-finite numbers.
    expect(() => validateDataLinks({ ...state, dataLinks: [link, link] })).toThrow();
    expect(() => validateDataLinks({
      ...state,
      dataLinks: [{ ...link, sourceRange: { firstRow: 0, firstCol: 0, rowCount: 1000, colCount: 101 } }],
    })).toThrow();
    expect(() => validateDataLinks({
      ...state,
      dataLinks: [{ ...link, lastRefresh: { ...link.lastRefresh!, sourceDigest: 'not-hex' } }],
    })).toThrow();
    expect(() => validateDataLinks({
      ...state,
      dataLinks: [{ ...link, smuggled: true } as DataLink],
    })).toThrow();
    expect(() => validateDataLinks({
      ...state,
      dataLinks: [{ ...link, sourceRange: { ...link.sourceRange, firstRow: Number.NaN } }],
    })).toThrow();
    // A well-formed state validates clean.
    expect(() => validateDataLinks({ ...state, dataLinks: [link] })).not.toThrow();
    expect(() => validateDataLinks(state)).not.toThrow();
  });

  it('(R6) OVERLAP: a second link over the same cells is refused at creation; refresh reports a smuggled overlap', () => {
    const state = stateWith([makeTable()]);
    const link = mustCreate(state);
    const linked = { ...state, dataLinks: [link] };
    const overlap = evaluateCreateDataLink(linked, createSpec({ id: 'L2', firstRow: 2, firstCol: 0, sourceRange: { firstRow: 0, firstCol: 0, rowCount: 1, colCount: 2 } }));
    expect(overlap.kind).toBe('refuse');
    if (overlap.kind === 'refuse') expect(overlap.issue?.kind).toBe('overlap');
    // A disjoint rectangle on the same table is fine.
    const tall = makeTable({
      rowHeights: [1, 1, 1, 1],
      cells: [
        [{ text: 'a' }, { text: 'b' }],
        [{ text: 'c', raw: '39' }, { text: 'd' }],
        [{ text: 'e' }, { text: 'f' }],
        [{ text: 'g' }, { text: 'h' }],
      ],
    });
    const tallLink = mustCreate(stateWith([tall]), createSpec({ id: 'LT1' }));
    const disjoint = evaluateCreateDataLink(
      { ...stateWith([tall]), dataLinks: [tallLink] },
      createSpec({ id: 'LT2', firstRow: 3, firstCol: 0, sourceRange: { firstRow: 0, firstCol: 0, rowCount: 1, colCount: 2 } }),
    );
    expect(disjoint.kind).toBe('create');
    // A hand-smuggled overlapping pair makes refresh of either refuse.
    const smuggled: DataLink = {
      ...link,
      id: 'L9',
      sourceRange: { firstRow: 0, firstCol: 0, rowCount: 1, colCount: 2 },
      target: { tableCadIdentity: 'AB12', firstRow: 2, firstCol: 0 },
      lastRefresh: {
        sourceDigest: link.lastRefresh!.sourceDigest,
        refreshedAt: NOW1,
        gridRows: 3,
        gridCols: 2,
        cellFingerprints: link.lastRefresh!.cellFingerprints.slice(4),
      },
    };
    const both = { ...state, dataLinks: [link, smuggled] };
    expect(() => validateDataLinks(both)).not.toThrow();
    expect(dataLinkIssues(both, link).map((i) => i.kind)).toContain('overlap');
    const ev = evaluateRefreshDataLink(both, link, sourceSnapshotOf([['a', 'b'], ['c', 'd'], ['e', 'f']]), { now: NOW2 });
    expect(ev.kind).toBe('refuse');
    if (ev.kind === 'refuse') expect(ev.issue.kind).toBe('overlap');
  });
});
