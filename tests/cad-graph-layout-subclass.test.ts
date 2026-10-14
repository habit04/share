import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Drawing, type DrawingState } from '../src/core/document';
import { CadGraphError, type CadGroup, type CadNode } from '../src/core/cad-graph';
import { defaultLayout, VIEWPORT_LAYER, type Layout } from '../src/core/layouts';
import { readDxf, writeDxf } from '../src/io/dxf';
import { tokenize } from '../src/io/dxf/groups';
import { LayoutController } from '../src/tools/layouts';
import type { Editor } from '../src/app/editor';

interface RecordData { type: string; groups: CadGroup[] }
function records(text: string): RecordData[] {
  const out: RecordData[] = [];
  for (const pair of tokenize(text)) {
    if (pair.code === 0) out.push({ type: pair.value.trim(), groups: [] });
    else out.at(-1)!.groups.push([pair.code, pair.value]);
  }
  return out;
}
const textOf = (source: readonly RecordData[]) => source.flatMap(record => [0, record.type, ...record.groups.flat()]).join('\r\n') + '\r\n';
const value = (record: { groups: readonly CadGroup[] }, code: number) => record.groups.find(pair => pair[0] === code)?.[1].trim();
function subclass(record: { groups: readonly CadGroup[] }, name: string): readonly CadGroup[] {
  const out: CadGroup[] = [];let depth = 0, active = false, found = false;
  for (const pair of record.groups) {
    if (pair[0] === 102) {
      if (active) out.push(pair);
      if (pair[1].trim().startsWith('{')) depth++;else if (pair[1].trim() === '}') depth--;
      continue;
    }
    if (depth) { if (active) out.push(pair);continue; }
    if (pair[0] === 1001) break;
    if (pair[0] === 100) { if (active) break;active = pair[1].trim() === name;found ||= active; }
    else if (active) out.push(pair);
  }
  expect(found, name).toBe(true);return out;
}
function setInSubclass(record: RecordData, name: string, code: number, raw: string): void {
  const start = record.groups.findIndex(pair => pair[0] === 100 && pair[1] === name);
  const end = record.groups.findIndex((pair, index) => index > start && (pair[0] === 100 || pair[0] === 1001));
  const at = record.groups.findIndex((pair, index) => index > start && (end < 0 || index < end) && pair[0] === code);
  if (at < 0) record.groups.splice(end < 0 ? record.groups.length : end, 0, [code, raw]);
  else record.groups[at] = [code, raw];
}
const node = (state: DrawingState, handle: string): CadNode => {
  const result = state.cadGraph!.nodes.find(item => item.sourceHandle === handle);
  expect(result, `retained handle ${handle}`).toBeDefined();
  return result!;
};

/** Authored native fields on the established writer's valid two-layout DXF structure. */
function authored() {
  const drawing = new Drawing({ entities: [{ id: 'model-line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 20, y: 10 } }] });
  const sheet: Layout = { ...defaultLayout('Native_A'), pristine: undefined, viewports: [{
    id: 'floating', center: { x: 5, y: 4 }, width: 8, height: 6, layer: VIEWPORT_LAYER.name, on: true,
    view: { center: { x: 20, y: 30 }, scale: 0.5, locked: true }, frozenLayers: ['0'],
  }] };
  const source = records(writeDxf({ ...drawing.snapshot, layers: [...drawing.layers, VIEWPORT_LAYER], layouts: [sheet, { ...defaultLayout('Native_B'), pristine: undefined }] }));
  const layout = source.find(record => record.type === 'LAYOUT' && value({ groups: subclass(record, 'AcDbLayout') }, 1) === 'Native_A')!;
  const owner = value({ groups: subclass(layout, 'AcDbLayout') }, 330)!;
  const overall = source.find(record => record.type === 'VIEWPORT' && value(record, 330) === owner && value(record, 69) === '1')!;
  const floating = source.find(record => record.type === 'VIEWPORT' && value(record, 330) === owner && value(record, 69) === '2')!;
  for (const [code, raw] of [[10, '-5.25'], [20, '2.5'], [11, '900.25'], [21, '800.5'],
    [12, '7.125'], [22, '8.25'], [32, '9.375'], [14, '-11.25'], [24, '-12.5'], [34, '-13.75'],
    [15, '311.25'], [25, '312.5'], [35, '313.75'], [146, '4.125'], [13, '1.25'], [23, '2.5'], [33, '3.75'],
    [16, '0.6'], [26, '0.8'], [36, '0'], [17, '-0.8'], [27, '0.6'], [37, '0'], [76, '7'], [70, '17']] as CadGroup[]) {
    setInSubclass(layout, 'AcDbLayout', code, raw);
  }
  setInSubclass(layout, 'AcDbLayout', 331, value(overall, 5)!);
  for (const [code, raw] of [[10, '7.75'], [20, '-2.25'], [30, '6.125'], [40, '113.5'], [41, '59.25'],
    [12, '-55.5'], [22, '77.25'], [16, '0.125'], [26, '0.25'], [36, '0.875'],
    [17, '17.125'], [27, '27.25'], [37, '37.5'], [42, '36.5'], [45, '100.125'], [51, '13.875'], [72, '987']] as CadGroup[]) {
    setInSubclass(overall, 'AcDbViewport', code, raw);
  }
  overall.groups.push([100, 'ThirdPartyPaperCamera'], [290, '1'], [1, 'opaque camera {"literal":"120"}'],
    [1001, 'PAPER_CAMERA_APP'], [1000, 'literal \\U+0041'], [1071, '2147483647']);
  return { source, layout, overall, floating, owner, layoutHandle: value(layout, 5)!, overallHandle: value(overall, 5)!, floatingHandle: value(floating, 5)! };
}

describe('retained LAYOUT subclasses and structural overall VIEWPORT identities', () => {
  it('retains the independently authored native minsert overall viewport and its LAYOUT331 target immediately', () => {
    const source = readDxf(readFileSync(new URL('./fixtures/interchange/r2018-minsert.dxf', import.meta.url), 'utf8'));
    const overall = node(source, '120'), layout = node(source, '104');
    expect(overall.anchor).toEqual({ kind: 'raw' });
    expect(layout.references!.find(ref => layout.groups[ref.groupIndex]![0] === 331)?.target).toBe(overall.id);
    expect(source.cadGraph!.generatedHandles?.some(hint => hint.handle === '120') ?? false).toBe(false);
    const one = writeDxf(source), back = readDxf(one);
    expect(node(back, '120').groups).toEqual(overall.groups);
    expect(value(node(back, '104'), 331)).toBe('120');
    expect(writeDxf(back)).toBe(one);
  });

  it('preserves exact unmodeled limits, extents, UCS and elevation separately from physical paper', () => {
    const fixture = authored(), source = readDxf(textOf(fixture.source));
    const original = subclass(node(source, fixture.layoutHandle), 'AcDbLayout');
    const originalPaper = source.layouts![0]!.paper;
    for (const state of [readDxf(writeDxf(source)), readDxf(writeDxf(readDxf(writeDxf(source))))]) {
      expect(subclass(node(state, fixture.layoutHandle), 'AcDbLayout')).toEqual(original);
      expect(state.layouts![0]!.paper).toEqual(originalPaper);
      expect(value(node(state, fixture.layoutHandle), 331)).toBe(fixture.overallHandle);
    }
  });

  it.each([false, true])('keeps opaque102 markers and fields exact through read, write and reopen (source-only subclass: %s)', sourceOnlySubclass => {
    const fixture = authored(), opaque: CadGroup[] = [[102, '{OPAQUE_LAYOUT'], [100, 'AcDbLayout'], [1001, 'OPAQUE_APPLICATION'],
      [1, 'Opaque_Not_The_Layout'], [330, fixture.owner], [10, '999.125'], [20, '-999.25'], [11, '111.75'], [21, '222.25'], [102, '}']];
    fixture.layout.groups.push(...opaque);
    if (sourceOnlySubclass) fixture.layout.groups.push([100, 'ThirdPartyLayout'], [470, 'kept']);
    const source = readDxf(textOf(fixture.source));
    expect(source.layouts!.map(layout => layout.name)).toEqual(['Native_A', 'Native_B']);
    expect(node(source, fixture.layoutHandle).anchor).toEqual({ kind: 'layout', name: 'Native_A' });
    const one = writeDxf(source), back = readDxf(one), retained = node(back, fixture.layoutHandle);
    const start = retained.groups.findIndex(pair => pair[0] === 102 && pair[1] === '{OPAQUE_LAYOUT');
    expect(start).toBeGreaterThanOrEqual(0);expect(retained.groups.slice(start, start + opaque.length)).toEqual(opaque);
    expect(value({ groups: subclass(retained, 'AcDbLayout') }, 1)).toBe('Native_A');
    expect(value({ groups: subclass(retained, 'AcDbLayout') }, 10)).toBe('-5.25');
    expect(value({ groups: subclass(retained, 'AcDbLayout') }, 330)).toBe(fixture.owner);
    if (sourceOnlySubclass) expect(subclass(retained, 'ThirdPartyLayout')).toEqual([[470, 'kept']]);
    expect(writeDxf(back)).toBe(one);
  });

  it('retains complete raw overall camera/properties without creating a selectable floating viewport', () => {
    const fixture = authored(), source = readDxf(textOf(fixture.source));
    const original = node(source, fixture.overallHandle);
    expect(original.anchor).toEqual({ kind: 'raw' });
    expect(source.layouts!.map(layout => layout.viewports.length)).toEqual([1, 0]);
    const one = writeDxf(source), back = readDxf(one);
    expect(node(back, fixture.overallHandle).groups).toEqual(original.groups);
    expect(records(one).filter(record => record.type === 'VIEWPORT' && value(record, 330) === fixture.owner && value(record, 69) === '1')).toHaveLength(1);
    expect(writeDxf(back)).toBe(one);
  });

  it('retains layout and camera metadata through a model edit, undo and redo', () => {
    const fixture = authored(), source = readDxf(textOf(fixture.source)), drawing = new Drawing(source);
    const expected = node(source, fixture.overallHandle).groups;
    drawing.addEntities([{ id: 'added-line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 9, y: 8 }, b: { x: 7, y: 6 } }]);
    const changed = writeDxf(drawing.snapshot);
    expect(node(readDxf(changed), fixture.overallHandle).groups).toEqual(expected);
    expect(drawing.undo()).toBe(true);
    expect(node(readDxf(writeDxf(drawing.snapshot)), fixture.overallHandle).groups).toEqual(expected);
    expect(drawing.redo()).toBe(true);
    expect(writeDxf(drawing.snapshot)).toBe(changed);
  });

  it('binds a real copied layout331 to that copied paper owner, never to the original overall viewport', () => {
    const fixture = authored(), drawing = new Drawing(readDxf(textOf(fixture.source)));
    // Real Drawing/controller and CAD clone intent; only the unused UI/log host is a double.
    const controller = new LayoutController({ doc: drawing, log() {} } as unknown as Editor);
    expect(controller.copyLayout('Native_A', 'Copied_A')).toBe('Copied_A');
    const changed = drawing.snapshot, one = writeDxf(changed), back = readDxf(one);
    const copied = back.cadGraph!.nodes.find(item => item.type === 'LAYOUT' && item.anchor?.kind === 'layout' && item.anchor.name === 'Copied_A')!;
    const paperOwner = value({ groups: subclass(copied, 'AcDbLayout') }, 330)!;
    const link = copied.references!.find(ref => copied.groups[ref.groupIndex]![0] === 331)!;
    const viewport = back.cadGraph!.nodes.find(item => item.id === link.target)!;
    expect(viewport.type).toBe('VIEWPORT');expect(value(viewport, 69)).toBe('1');
    const owner = viewport.references!.find(ref => ref.role === 'owner')!;
    expect(back.cadGraph!.nodes.find(item => item.id === owner.target)?.sourceHandle).toBe(paperOwner);
    expect(viewport.id).not.toBe(node(back, fixture.overallHandle).id);
    expect(paperOwner).not.toBe(fixture.owner);
    expect(writeDxf(back)).toBe(one);
    expect(drawing.undo()).toBe(true);expect(drawing.snapshot.layouts!.some(layout => layout.name === 'Copied_A')).toBe(false);
    expect(drawing.redo()).toBe(true);expect(drawing.snapshot).toBe(changed);
  });

  it('preserves a retained active floating viewport331 and its explicit copy mapping', () => {
    const fixture = authored();setInSubclass(fixture.layout, 'AcDbLayout', 331, fixture.floatingHandle);
    const drawing = new Drawing(readDxf(textOf(fixture.source))), controller = new LayoutController({ doc: drawing, log() {} } as unknown as Editor);
    const original = readDxf(writeDxf(drawing.snapshot));
    expect(value(node(original, fixture.layoutHandle), 331)).toBe(fixture.floatingHandle);
    expect(controller.copyLayout('Native_A', 'Copied_A')).toBe('Copied_A');
    const one = writeDxf(drawing.snapshot), back = readDxf(one);
    const copied = back.cadGraph!.nodes.find(item => item.type === 'LAYOUT' && item.anchor?.kind === 'layout' && item.anchor.name === 'Copied_A')!;
    const link = copied.references!.find(ref => copied.groups[ref.groupIndex]![0] === 331)!;
    const viewport = back.cadGraph!.nodes.find(item => item.id === link.target)!;
    expect(value(viewport, 69)).toBe('2');
    expect(viewport.anchor).toEqual({ kind: 'viewport', id: back.layouts!.find(layout => layout.name === 'Copied_A')!.viewports[0]!.id });
    expect(viewport.id).not.toBe(node(back, fixture.floatingHandle).id);
    expect(writeDxf(back)).toBe(one);
  });

  it('does not redirect a typed but unproven layout331 target to a generated overall slot', () => {
    const fixture = authored();setInSubclass(fixture.layout, 'AcDbLayout', 331, 'E8F0');
    const objects = fixture.source.findIndex(record => record.type === 'SECTION' && value(record, 2) === 'OBJECTS');
    const end = fixture.source.findIndex((record, index) => index > objects && record.type === 'ENDSEC');
    const root = fixture.source.find(record => record.type === 'DICTIONARY' && value(record, 330) === '0')!;
    fixture.source.splice(end, 0, { type: 'XRECORD', groups: [[5, 'E8F0'], [330, value(root, 5)!], [100, 'AcDbXrecord'], [280, '1'], [1, 'opaque original source']] });
    const drawing = new Drawing(readDxf(textOf(fixture.source))), controller = new LayoutController({ doc: drawing, log() {} } as unknown as Editor);
    expect(controller.copyLayout('Native_A', 'Copied_A')).toBe('Copied_A');
    const back = readDxf(writeDxf(drawing.snapshot));
    const copied = back.cadGraph!.nodes.find(item => item.type === 'LAYOUT' && item.anchor?.kind === 'layout' && item.anchor.name === 'Copied_A')!;
    const link = copied.references!.find(ref => copied.groups[ref.groupIndex]![0] === 331)!;
    expect(value(copied, 331)).toBe('E8F0');
    expect(back.cadGraph!.nodes.find(item => item.id === link.target)?.type).toBe('XRECORD');
  });

  it('keeps the existing hard paper-owner dependency refusal atomic for real layout deletion', () => {
    const fixture = authored(), drawing = new Drawing(readDxf(textOf(fixture.source)));
    const controller = new LayoutController({ doc: drawing, log() {} } as unknown as Editor), before = drawing.snapshot;
    expect(() => controller.deleteLayout('Native_A')).toThrow(/hard dependency/);
    expect(drawing.snapshot).toBe(before);expect(drawing.dirty).toBe(false);expect(drawing.canUndo()).toBe(false);
    expect(writeDxf(readDxf(writeDxf(before)))).toBe(writeDxf(before));
  });

  it('matches the common paper owner even when a distinct reactor330 precedes it', () => {
    const fixture = authored();
    fixture.overall.groups.splice(1, 0, [102, '{ACAD_REACTORS'], [330, fixture.layoutHandle], [102, '}']);
    const source = readDxf(textOf(fixture.source)), overall = node(source, fixture.overallHandle);
    const owner = overall.references!.find(ref => ref.role === 'owner')!, reactor = overall.references!.find(ref => ref.role === 'reactor')!;
    expect(node(source, fixture.owner).id).toBe(owner.target);
    expect(node(source, fixture.layoutHandle).id).toBe(reactor.target);
    expect(owner.target).not.toBe(reactor.target);
    const one = writeDxf(source), back = readDxf(one);
    expect(node(back, fixture.overallHandle).groups).toEqual(overall.groups);
    expect(records(one).filter(record => record.type === 'VIEWPORT' && value(record, 5) === fixture.overallHandle)).toHaveLength(1);
    expect(writeDxf(back)).toBe(one);
  });

  it('refuses two distinct overall viewport identities in one paper-owner slot', () => {
    const fixture = authored(), duplicate: RecordData = { type: 'VIEWPORT', groups: fixture.overall.groups.map(([code, raw]) => [code, code === 5 ? 'E800' : raw]) };
    const at = fixture.source.indexOf(fixture.overall);
    fixture.source.splice(at + 1, 0, duplicate);
    expect(() => writeDxf(readDxf(textOf(fixture.source)))).toThrow(/duplicate|ambiguous|overall/i);
  });

  it('continues to regenerate modeled floating geometry, lock and frozen layers independently', () => {
    const fixture = authored(), source = readDxf(textOf(fixture.source));
    const floating = source.layouts![0]!.viewports[0]!;
    expect(floating.view).toEqual({ center: { x: 20, y: 30 }, scale: 0.5, locked: true });
    expect(floating.frozenLayers).toEqual(['0']);
    const edited = { ...source, layouts: source.layouts!.map((layout, index) => index ? layout : { ...layout, viewports: [{ ...floating, center: { x: 6, y: 7 }, width: 4, on: false }] }) };
    const back = readDxf(writeDxf(edited));
    expect(back.layouts![0]!.viewports[0]).toMatchObject({ center: { x: 6, y: 7 }, width: 4, on: false, view: floating.view, frozenLayers: ['0'] });
    expect(node(back, fixture.overallHandle).groups).toEqual(node(source, fixture.overallHandle).groups);
    expect(node(back, fixture.floatingHandle).anchor?.kind).toBe('viewport');
  });

  it('does not resolve an unrelated missing soft pointer through generated handle hints', () => {
    const fixture = authored();fixture.overall.groups.push([1005, 'EFFE']);
    const source = readDxf(textOf(fixture.source)), overall = node(source, fixture.overallHandle);
    const soft = overall.references!.find(ref => overall.groups[ref.groupIndex]![0] === 1005)!;
    expect(soft).toMatchObject({ kind: 'soft-pointer', sourceHandle: 'EFFE' });expect(soft.target).toBeUndefined();
    const back = readDxf(writeDxf(source));
    expect(value(node(back, fixture.overallHandle), 1005)).toBe('0');
    expect(value(node(back, fixture.layoutHandle), 331)).toBe(fixture.overallHandle);
  });

  it('refuses an unresolved hard application reference without mutating the drawing', () => {
    const fixture = authored();fixture.overall.groups.splice(1, 0, [102, '{THIRD_PARTY'], [340, 'EFFD'], [102, '}']);
    const drawing = new Drawing(readDxf(textOf(fixture.source))), before = drawing.snapshot;
    expect(() => writeDxf(before)).toThrow(CadGraphError);
    expect(() => writeDxf(before)).toThrow(/hard reference.*not exposed|hard.*dependency/i);
    expect(drawing.snapshot).toBe(before);expect(drawing.dirty).toBe(false);expect(drawing.canUndo()).toBe(false);
  });
});
