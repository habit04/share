import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Drawing, type DrawingState } from '../src/core/document';
import type { BlockDef, Entity, InsertEntity } from '../src/core/entities';
import { canonicalCadHandle, validateCadState, type CadNode } from '../src/core/cad-graph';
import { validateGeometryBudget } from '../src/core/geometry-budget';
import { GeometryBudgetError } from '../src/core/geometry-budget-error';
import { defaultLayout } from '../src/core/layouts';
import { readDxf, writeDxf } from '../src/io/dxf';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
import { recoverOversizedReferences } from '../src/io/import-recovery';
import { ImportReportBuilder, MAX_REPORT_ITEMS, importReportOf, rawEntitiesOf, withImportData, type ImportReportItem } from '../src/io/import-report';

const line = (id: string): Entity => ({ type: 'line', id, layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } });
const insert = (name: string, id: string): InsertEntity => ({ type: 'insert', id, layer: '0', color: 'ByLayer', block: name, position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {} });
const block = (name: string, entities: Entity[]): BlockDef => ({ name, entities, basePoint: { x: 0, y: 0 }, attributes: [] });
const heavyBlocks = (): Record<string, BlockDef> => ({
  LEAF: block('LEAF', Array.from({ length: 400 }, (_, i) => line(`leaf-${i}`))),
  HEAVY: block('HEAVY', Array.from({ length: 300 }, (_, i) => insert('LEAF', `child-${i}`))),
});
const beforeRecovery = (text: string): DrawingState => readDxf(text, { recordInventory: () => {} });
const rootOf = (state: DrawingState) => {
  const entity = state.entities.find(e => e.type === 'insert' && e.block === 'HEAVY')!;
  const node = state.cadGraph!.nodes.find(n => n.anchor?.kind === 'entity' && !n.anchor.part && n.anchor.id === entity.id)!;
  return { entity, node };
};

/** Real independent AutoCAD metadata plus a small synthetic expensive reference. */
function graphFixture(): DrawingState {
  const oracle = readDxf(readFileSync(new URL('./fixtures/interchange/r2018-views-fields.dxf', import.meta.url), 'utf8'));
  const layout = { ...defaultLayout('Recovery sheet'), entities: [line('paper-kept')] };
  const source: DrawingState = { ...oracle, blocks: { ...oracle.blocks, ...heavyBlocks() }, entities: [...oracle.entities, insert('HEAVY', 'bad')], layouts: [...oracle.layouts ?? [], layout] };
  return beforeRecovery(writeDxf(source));
}

function withOwnedRecords(source: DrawingState): DrawingState {
  const { entity, node } = rootOf(source);
  const dict: CadNode = { id: 'owned-dictionary', sourceHandle: 'F0010001', type: 'DICTIONARY', section: 'OBJECTS', anchor: { kind: 'raw' },
    groups: [[5, 'F0010001'], [330, node.sourceHandle!], [100, 'AcDbDictionary'], [281, '1'], [3, 'Private'], [350, 'F0010002']],
    references: [{ groupIndex: 1, kind: 'soft-pointer', role: 'owner', target: node.id }, { groupIndex: 5, kind: 'soft-owner', target: 'owned-record' }] };
  const record: CadNode = { id: 'owned-record', sourceHandle: 'F0010002', type: 'XRECORD', section: 'OBJECTS', anchor: { kind: 'raw' },
    groups: [[5, 'F0010002'], [330, 'F0010001'], [100, 'AcDbXrecord'], [280, '1'], [1, 'OWNED_PRIVATE_VALUE']],
    references: [{ groupIndex: 1, kind: 'soft-pointer', role: 'owner', target: dict.id }] };
  const raw: CadNode = { id: 'owned-region', sourceHandle: 'F0010003', type: 'REGION', section: 'ENTITIES', anchor: { kind: 'raw' },
    groups: [[5, 'F0010003'], [330, node.sourceHandle!], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbModelerGeometry'], [70, '1'], [1, 'OWNED_RAW_VALUE']],
    references: [{ groupIndex: 1, kind: 'soft-pointer', role: 'owner', target: node.id }] };
  const other: CadNode = { id: 'unrelated-body', sourceHandle: 'F0010004', type: 'BODY', section: 'ENTITIES', anchor: { kind: 'raw' },
    groups: [[5, 'F0010004'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbModelerGeometry'], [70, '1'], [1, 'UNRELATED_RAW_VALUE']] };
  const changed: DrawingState = { ...source, entities: source.entities.map(e => e === entity ? { ...e, cadIdentity: node.id } : e),
    cadGraph: { ...source.cadGraph!, nodes: source.cadGraph!.nodes.map((n): CadNode => n === node ? { ...node,
      groups: [...node.groups, [102, '{ACAD_XDICTIONARY'], [360, dict.sourceHandle!], [102, '}']],
      references: [...node.references ?? [], { groupIndex: node.groups.length + 1, kind: 'hard-owner', role: 'extension', target: dict.id }],
    } : n).concat([dict, record, raw, other]) } };
  return withImportData(changed, importReportOf(source) ?? null, [...rawEntitiesOf(source),
    { type: raw.type, handle: raw.sourceHandle, layer: '0', groups: [[8, '0'], [1, 'OWNED_RAW_VALUE']] },
    { type: other.type, handle: other.sourceHandle, layer: '0', groups: [[8, '0'], [1, 'UNRELATED_RAW_VALUE']] },
  ]);
}

describe('graph-aware partial import', () => {
  it('erases only the expensive reference and its owned metadata; Save As cannot resurrect it', () => {
    const source = withOwnedRecords(graphFixture()), { node: excluded } = rootOf(source);
    validateCadState(source);
    const report = new ImportReportBuilder();
    const opened = recoverOversizedReferences(source, item => report.add(item), text => report.note(text));
    validateCadState(opened); validateGeometryBudget(opened);
    expect(opened.cadGraph!.documentId).toBe(source.cadGraph!.documentId);
    expect(opened.cadGraph!.nodes.some(n => n.id === excluded.id || n.id.startsWith('owned-'))).toBe(false);
    expect(rawEntitiesOf(opened).map(raw => raw.type)).not.toContain('REGION');
    expect(rawEntitiesOf(opened).map(raw => raw.type)).toContain('BODY');
    expect(report.items.find(item => item.type === 'INSERT')).toMatchObject({ action: 'dropped', handle: excluded.sourceHandle });
    expect(report.items.find(item => item.type === 'REGION')).toMatchObject({ action: 'dropped', handle: 'F0010003' });
    expect(report.items.filter(item => item.action === 'dropped')).toHaveLength(4);
    expect(source.cadGraph!.nodes.some(n => n.id === excluded.id)).toBe(true);
    expect(rawEntitiesOf(source).map(raw => raw.type)).toContain('REGION');
    // Independently authored fields, dictionaries, styles, named views and paper
    // space survive the same native graph path used for an ordinary editor erase.
    const protectedNodes = source.cadGraph!.nodes.filter(n => ['FIELD', 'STYLE', 'DIMSTYLE', 'LAYOUT'].includes(n.type)
      || n.type === 'XRECORD' && n.groups.some(([code]) => code === 160));
    for (const node of protectedNodes) expect(opened.cadGraph!.nodes.find(n => n.id === node.id)?.groups).toEqual(node.groups);
    expect(opened.layouts!.find(layout => layout.name === 'Recovery sheet')!.entities).toHaveLength(1);
    const saved = writeDxf(opened), reopened = readDxf(saved);
    expect(saved).not.toContain('OWNED_PRIVATE_VALUE'); expect(saved).not.toContain('OWNED_RAW_VALUE');
    expect(saved).toContain('UNRELATED_RAW_VALUE');
    expect(reopened.entities.some(e => e.type === 'insert' && e.block === 'HEAVY')).toBe(false);
    expect(reopened.cadGraph!.nodes.some(n => n.sourceHandle === excluded.sourceHandle)).toBe(false);
    expect(reopened.cadGraph!.nodes.filter(n => n.type === 'FIELD')).toHaveLength(source.cadGraph!.nodes.filter(n => n.type === 'FIELD').length);
    expect(reopened.header!.views).toEqual(opened.header!.views);
    expect(reopened.cadGraph!.nodes.some(n => n.type === 'XRECORD' && n.groups.some(([code, value]) => code === 160 && value.trim() === '9007199254740993'))).toBe(true);
  });

  it('ordinary DXF Open uses recovery and retains unrelated metadata and layout records on reopen', () => {
    const source = graphFixture(), handle = rootOf(source).node.sourceHandle!;
    const opened = readDxf(writeDxf(source), { filePath: '/private/heavy.dxf' });
    expect(opened.entities.some(e => e.type === 'insert' && e.block === 'HEAVY')).toBe(false);
    expect(importReportOf(opened)?.items.find(item => item.type === 'INSERT' && item.action === 'dropped')).toMatchObject({ handle });
    const reopened = readDxf(writeDxf(opened));
    expect(reopened.cadGraph!.nodes.some(n => n.sourceHandle === handle)).toBe(false);
    expect(reopened.cadGraph!.nodes.filter(n => n.type === 'FIELD')).toHaveLength(opened.cadGraph!.nodes.filter(n => n.type === 'FIELD').length);
    expect(reopened.layouts!.find(layout => layout.name === 'Recovery sheet')!.entities).toHaveLength(1);
  });

  it('DXF parsing removes owned extension records and preserves the independently placed raw geometry', () => {
    const source = withOwnedRecords(graphFixture()), text = writeDxf(source);
    expect(text).toContain('OWNED_RAW_VALUE'); expect(text).toContain('UNRELATED_RAW_VALUE');
    const opened = readDxf(text, { filePath: '/private/owned-heavy.dxf' });
    expect(importReportOf(opened)?.items.find(item => item.type === 'XRECORD' && item.handle === 'F0010002')).toMatchObject({ action: 'dropped' });
    expect(importReportOf(opened)?.items.some(item => item.handle === 'F0010002' && item.action === 'kept')).toBe(false);
    expect(opened.cadGraph!.nodes.some(node => node.type === 'BODY')).toBe(true);
    const saved = writeDxf(opened);
    expect(saved).not.toContain('OWNED_PRIVATE_VALUE');
    expect(saved).toContain('UNRELATED_RAW_VALUE');
  });

  it('refuses a hard incoming dependency atomically and emits no successful-exclusion report', () => {
    const source = graphFixture(), { node } = rootOf(source);
    const watcher: CadNode = { id: 'hard-watcher', sourceHandle: 'F0010005', type: 'XRECORD', section: 'OBJECTS', anchor: { kind: 'raw' },
      groups: [[5, 'F0010005'], [100, 'AcDbXrecord'], [340, node.sourceHandle!]], references: [{ groupIndex: 2, kind: 'hard-pointer', target: node.id }] };
    const state = { ...source, cadGraph: { ...source.cadGraph!, nodes: [...source.cadGraph!.nodes, watcher] } };
    const report = new ImportReportBuilder();
    expect(() => recoverOversizedReferences(state, item => report.add(item), text => report.note(text))).toThrow(/cannot be excluded safely:.*XRECORD group 340.*hard dependency/);
    expect(report.items).toEqual([]); expect(report.notes).toEqual([]);
    expect(state.cadGraph.nodes).toContain(node); expect(state.cadGraph.nodes).toContain(watcher);
  });

  it('does not publish an earlier exclusion if a later reference has an unsafe dependency', () => {
    const source = graphFixture(), first = rootOf(source).entity;
    const other = { ...first, id: 'second-expensive-reference' };
    const { node } = rootOf(source);
    const watcher: CadNode = { id: 'watcher', type: 'XRECORD', section: 'OBJECTS', groups: [[340, node.sourceHandle!]], references: [{ groupIndex: 0, kind: 'hard-pointer', target: node.id }] };
    const state: DrawingState = { ...source, entities: [other, ...source.entities], cadGraph: { ...source.cadGraph!, nodes: [...source.cadGraph!.nodes, watcher] } };
    const report = new ImportReportBuilder();
    expect(() => recoverOversizedReferences(state, item => report.add(item), text => report.note(text))).toThrow(/cannot be excluded safely/);
    expect(report.items).toEqual([]); expect(report.notes).toEqual([]);
    expect(state.entities).toContain(other); expect(state.entities).toContain(first);
  });

  it('a cyclic expansion failure stays fatal instead of guessing which reference to erase', () => {
    const blocks = heavyBlocks();
    blocks.HEAVY = { ...blocks.HEAVY!, entities: [...blocks.HEAVY!.entities, insert('HEAVY', 'cycle')] };
    const state = { ...new Drawing().snapshot, blocks, entities: [insert('HEAVY', 'bad')] };
    const report = new ImportReportBuilder();
    expect(() => recoverOversizedReferences(state, item => report.add(item), text => report.note(text))).toThrow(GeometryBudgetError);
    expect(() => recoverOversizedReferences(state, item => report.add(item), text => report.note(text))).toThrow(/Cyclic block reference/);
    expect(report.items).toEqual([]);
  });

  it('exhausting the bounded recovery plan fails clearly without publishing any exclusions', () => {
    const state = { ...new Drawing().snapshot, blocks: heavyBlocks(), entities: Array.from({ length: 65 }, (_, i) => insert('HEAVY', `bad-${i}`)) };
    const report = new ImportReportBuilder();
    expect(() => recoverOversizedReferences(state, item => report.add(item), text => report.note(text))).toThrow(/more than 64 block-reference exclusions/);
    expect(report.items).toEqual([]); expect(report.notes).toEqual([]);
    expect(state.entities).toHaveLength(65);
  });

  it('changes an earlier kept record to dropped instead of claiming deleted source data remains retained', () => {
    const report = new ImportReportBuilder();
    report.add({ type: 'XRECORD', action: 'kept', handle: 'A0', reason: 'retained as raw source' });
    expect(report.dropItems(item => item.handle === 'A0', () => 'excluded with its owner')).toBe(1);
    expect(report.counts.XRECORD).toEqual({ dropped: 1 });
    expect(report.items[0]).toMatchObject({ action: 'dropped', reason: 'excluded with its owner' });
    expect(report.dropItems(item => item.handle === 'A0', () => 'excluded with its owner')).toBe(1);
    expect(report.counts.XRECORD).toEqual({ dropped: 1 });
  });
});

describe('complete native DWG projection recovery', () => {
  it('joins exact native identities first, then removes the reference without losing the checked graph', () => {
    const original: DrawingState = { ...new Drawing().snapshot, entities: [line('kept'), insert('HEAVY', 'bad')], blocks: heavyBlocks() };
    const dxf = writeDxf(original), objects: Array<{ handle: string; type: string; dxfType: string; supertype: 'entity' | 'object' }> = [];
    const projected = readDxf(dxf, { recordInventory: (handle, type) => objects.push({ handle, type, dxfType: type, supertype: type === 'LINE' || type === 'INSERT' ? 'entity' : 'object' }) });
    const byId = new Map(projected.cadGraph!.nodes.flatMap(n => n.anchor?.kind === 'entity' && !n.anchor.part ? [[n.anchor.id, n] as const] : []));
    const dto = (entity: Entity) => {
      const base = { handle: byId.get(entity.id)!.sourceHandle!, layer: entity.layer, colorIndex: 256 };
      if (entity.type === 'line') return { ...base, type: 'LINE', startPoint: entity.a, endPoint: entity.b };
      if (entity.type === 'insert') return { ...base, type: 'INSERT', name: entity.block, insertionPoint: entity.position, xScale: 1, yScale: 1, rotation: 0, attribs: [] };
      throw new Error('unexpected fixture entity');
    };
    const handleOf = (type: string, name: string) => projected.cadGraph!.nodes.find(n => n.type === type && n.anchor?.kind === 'table' && n.anchor.name === name)?.sourceHandle;
    const payload = { header: {}, entities: projected.entities.map(dto),
      layers: projected.layers.map(layer => ({ name: layer.name, handle: handleOf('LAYER', layer.name), colorIndex: 7, off: false, frozen: false, locked: false, lineweight: 0 })),
      blocks: Object.values(projected.blocks).map(def => ({ name: def.name, handle: handleOf('BLOCK_RECORD', def.name), basePoint: def.basePoint, description: '', entities: def.entities.map(dto) })),
      layouts: (projected.layouts ?? []).map((layout, i) => ({ name: layout.name, tabOrder: i + 1, blockHandle: '0',
        handle: projected.cadGraph!.nodes.find(n => n.anchor?.kind === 'layout' && n.anchor.name === layout.name)?.sourceHandle })),
      nativeMetadata: { schemaVersion: 1, dxf, objects, readError: 0, writeError: 0, complete: true, notes: [] },
    } as unknown as DwgImportPayload;
    const excludedHandle = rootOf(projected).node.sourceHandle!;
    const { state, report } = convertDwg(payload, '/private/heavy.dwg');
    expect(state.cadGraph?.sourceFormat).toBe('DWG'); validateCadState(state); validateGeometryBudget(state);
    expect(report?.items.some(item => item.type === 'CAD_METADATA' && item.action === 'unsupported')).toBe(false);
    expect(report?.items.find(item => item.type === 'INSERT' && item.action === 'dropped')).toMatchObject({ handle: excludedHandle });
    expect(state.cadGraph!.nodes.some(n => n.sourceHandle && canonicalCadHandle(n.sourceHandle) === excludedHandle)).toBe(false);
    expect(state.entities).toHaveLength(1);
    const reopened = readDxf(writeDxf(state));
    expect(reopened.entities).toHaveLength(1);
    expect(reopened.cadGraph!.nodes.some(n => n.sourceHandle === excludedHandle)).toBe(false);
  });
});

describe('exclusion accounting beyond the report detail cap', () => {
  const fill = (report: ImportReportBuilder) => {
    for (let index = 0; index < MAX_REPORT_ITEMS; index += 1) report.add({ type: 'NOTICE', action: 'unsupported', reason: `earlier remark ${index}` });
  };
  const sameSource = (left: ImportReportItem, right: ImportReportItem) => left.type === right.type && !!left.handle && !!right.handle
    && canonicalCadHandle(left.handle) === canonicalCadHandle(right.handle);
  const total = (report: ImportReportBuilder) => Object.values(report.counts).reduce((sum, actions) => sum + Object.values(actions).reduce((n, count) => n + count, 0), 0);

  it('reclassifies an erased owned raw record after 1,000 earlier remarks without counting it twice', () => {
    const source = withOwnedRecords(graphFixture()), report = new ImportReportBuilder();
    fill(report);
    report.add({ type: 'XRECORD', action: 'kept', handle: '000F0010002', reason: 'owned source data retained' });
    report.add({ type: 'XRECORD', action: 'kept', handle: 'F001000A', reason: 'unrelated source data retained' });
    const opened = recoverOversizedReferences(source, item => {
      const matched = item.action === 'dropped' && item.handle ? report.dropItems(old => sameSource(old, item), () => item.reason, item) : 0;
      if (!matched) report.add(item);
    }, text => report.note(text));
    expect(report.counts.XRECORD).toEqual({ kept: 1, dropped: 1 });
    expect(report.items.find(item => item.type === 'XRECORD' && item.handle === 'F0010002')).toMatchObject({ action: 'dropped' });
    expect(total(report)).toBe(MAX_REPORT_ITEMS + 5);
    expect(report.items.length + report.omitted).toBe(total(report));
    expect(report.items).toHaveLength(MAX_REPORT_ITEMS);
    expect(writeDxf(opened)).not.toContain('OWNED_PRIVATE_VALUE');
  });

  it('keeps multiple omitted action counts exact and repeated reclassification idempotent', () => {
    const report = new ImportReportBuilder(); fill(report);
    for (const action of ['kept', 'simplified', 'unsupported'] as const) report.add({ type: 'XRECORD', action, handle: 'a0', reason: 'earlier source remark' });
    const excluded: ImportReportItem = { type: 'XRECORD', action: 'dropped', handle: 'A0', reason: 'excluded with its owner', layer: '0' };
    expect(report.dropItems(old => sameSource(old, excluded), () => excluded.reason, excluded)).toBe(3);
    expect(report.counts.XRECORD).toEqual({ dropped: 3 });
    expect(report.items.filter(item => item.type === 'XRECORD' && item.action === 'dropped')).toHaveLength(1);
    expect(report.dropItems(old => sameSource(old, excluded), () => excluded.reason, excluded)).toBe(3);
    expect(report.counts.XRECORD).toEqual({ dropped: 3 });
    expect(total(report)).toBe(MAX_REPORT_ITEMS + 3);
    expect(report.items.length + report.omitted).toBe(total(report));
  });

  it('indexes a displaced detail so a subsequent exclusion still has exact counts', () => {
    const report = new ImportReportBuilder();
    for (let index = 1; index <= MAX_REPORT_ITEMS; index += 1) report.add({ type: 'XRECORD', action: 'kept', handle: index.toString(16), reason: 'retained record' });
    report.add({ type: 'INSERT', action: 'dropped', handle: 'A000', reason: 'oversized reference excluded' });
    const excluded: ImportReportItem = { type: 'XRECORD', action: 'dropped', handle: MAX_REPORT_ITEMS.toString(16).toUpperCase(), reason: 'owned record excluded' };
    expect(report.dropItems(old => sameSource(old, excluded), () => excluded.reason, excluded)).toBe(1);
    expect(report.counts.XRECORD).toEqual({ kept: MAX_REPORT_ITEMS - 1, dropped: 1 });
    expect(total(report)).toBe(MAX_REPORT_ITEMS + 1);
    expect(report.items.length + report.omitted).toBe(total(report));
    expect(report.items.find(item => item.handle === excluded.handle)).toMatchObject({ action: 'dropped' });
  });

  it('refuses an exhausted source-identity budget before changing counts, details, omissions or font totals', () => {
    const report = new ImportReportBuilder(2); fill(report);
    for (const handle of ['A0', 'A1']) report.add({ type: 'XRECORD', action: 'kept', handle, reason: 'retained source' });
    const before = JSON.stringify(report.build('DXF', '/private/source.dxf'));
    expect(() => report.add({ type: 'STYLE', action: 'unsupported', handle: 'A2', reason: 'font fallback' })).toThrow(/source-identity limit \(2\)/);
    expect(JSON.stringify(report.build('DXF', '/private/source.dxf'))).toBe(before);
    expect(report.fontSubstitutions).toBe(0);
  });
});
