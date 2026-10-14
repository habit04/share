import { describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { defaultLayout, paperFromSize, sheetSize } from '../src/core/layouts';
import type { CadGroup, CadNode } from '../src/core/cad-graph';
import { readDxf, writeDxf } from '../src/io/dxf';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
import { readNativeLayoutPlotSettings, retainNativeLayoutPaper } from '../src/io/dxf-layouts';
import { tokenize } from '../src/io/dxf/groups';
import { LayoutController } from '../src/tools/layouts';
import type { Editor } from '../src/app/editor';

const layoutNode = (state: DrawingState, name = 'Sheet') => state.cadGraph!.nodes.find(node => {
  if (node.type !== 'LAYOUT') return false;
  const marker = node.groups.findIndex(([code, value]) => code === 100 && value === 'AcDbLayout');
  return node.groups.slice(marker + 1).find(([code]) => code === 1)?.[1] === name;
})!;
const plotGroups = (node: CadNode) => {
  const at = node.groups.findIndex(([code, value]) => code === 100 && value === 'AcDbPlotSettings');
  const end = node.groups.findIndex(([code], index) => index > at && code === 100);
  return node.groups.slice(at + 1, end);
};
const group = (node: CadNode, code: number) => plotGroups(node).find(([candidate]) => candidate === code)?.[1];

/** Authored source DXF + DTO-shaped host double; these tests do not run a native DWG reader. */
function reference(fields: Record<number, string | number> = {}, paperCircle = false): string {
  const layout = { ...defaultLayout('Sheet'), pristine: undefined, entities: paperCircle ? [{ id: 'paper-circle', type: 'circle' as const, layer: '0', color: 'ByLayer' as const, center: { x: 2, y: 3 }, radius: 0.5 }] : [] };
  const raw = tokenize(writeDxf(new Drawing({ layouts: [layout] }).snapshot));
  const start = raw.findIndex(pair => pair.code === 0 && pair.value === 'LAYOUT');
  const ps = raw.findIndex((pair, index) => index > start && pair.code === 100 && pair.value === 'AcDbPlotSettings');
  const body = raw.findIndex((pair, index) => index > ps && pair.code === 100 && pair.value === 'AcDbLayout');
  for (const [code, value] of Object.entries(fields)) {
    const at = raw.findIndex((pair, index) => index > ps && index < body && pair.code === Number(code));
    if (at < 0) throw new Error(`Authored plot field ${code} missing.`);
    raw[at] = { code: Number(code), value: String(value) };
  }
  // Drawing limits are independent of the physical 11×17 paper.
  const end = raw.findIndex((pair, index) => index > body && pair.code === 0);
  for (const [code, value] of [[11, 12], [21, 9]] as const) {
    const at = raw.findIndex((pair, index) => index > body && index < end && pair.code === code);
    raw[at] = { code, value: String(value) };
  }
  return raw.flatMap(pair => [String(pair.code), pair.value]).join('\r\n') + '\r\n';
}

function dto(text: string): DwgImportPayload {
  const source = readDxf(text), nodes = source.cadGraph!.nodes;
  const tables = (kind: string) => nodes.filter(node => node.type === kind && node.anchor?.kind === 'table');
  const tableName = (node: CadNode) => node.anchor?.kind === 'table' ? node.anchor.name : '';
  const blocks = nodes.filter(node => node.type === 'BLOCK_RECORD').map(node => ({ name: node.groups.find(([code]) => code === 2)![1], handle: node.sourceHandle!, basePoint: { x: 0, y: 0, z: 0 }, description: '', entities: [] }));
  const layouts = nodes.filter(node => node.type === 'LAYOUT').map(node => {
    const at = node.groups.findIndex(([code, value]) => code === 100 && value === 'AcDbLayout');
    const body = node.groups.slice(at + 1);
    const get = (code: number) => body.find(([candidate]) => candidate === code)?.[1];
    return { name: get(1)!, handle: node.sourceHandle!, tabOrder: Number(get(71)), blockHandle: get(330)!, minLimit: { x: 0, y: 0 }, maxLimit: { x: 12, y: 9 } };
  });
  return {
    header: { INSUNITS: 1 }, entities: [], blocks, layouts,
    layers: tables('LAYER').map(node => ({ name: tableName(node), handle: node.sourceHandle!, colorIndex: 7, off: false, frozen: false, locked: false, lineweight: -3 })),
    styles: tables('STYLE').map(node => ({ name: tableName(node), handle: node.sourceHandle!, font: 'txt' })),
    linetypes: tables('LTYPE').map(node => ({ name: tableName(node), handle: node.sourceHandle!, pattern: [] })),
    nativeMetadata: { schemaVersion: 1, readError: 0, writeError: 0, complete: true, notes: [], objects: [], dxf: text },
  };
}

describe('native layout physical page setup', () => {
  it('hydrates physical paper through exact canonical layout and paper-owner handles, not drawing limits', () => {
    const payload = dto(reference({ 4: 'Device_Private_Media_11x17' }));
    payload.layouts = payload.layouts!.map(layout => ({ ...layout, handle: `000${layout.handle!.toLowerCase()}`, blockHandle: `000${layout.blockHandle.toLowerCase()}` }));
    payload.blocks = payload.blocks.map(block => ({ ...block, handle: `00${block.handle!.toLowerCase()}` }));
    const { state, report } = convertDwg(payload);
    expect(state.cadGraph).toBeDefined();
    expect(state.layouts![0]!.paper).toEqual({ id: 'tabloid', width: 11, height: 17, units: 'in', orientation: 'landscape' });
    expect(sheetSize(state.layouts![0]!)).toEqual({ width: 17, height: 11 });
    expect(report!.items.find(item => item.type === 'LAYOUT')).toMatchObject({ action: 'kept' });
  });

  it('does not borrow native page setup by a coincident layout name or a different paper owner', () => {
    for (const changes of [{ handle: 'ABCDEF' }, { blockHandle: 'ABCDEF' }]) {
      const payload = dto(reference());
      payload.layouts = payload.layouts!.map(layout => layout.name === 'Sheet' ? { ...layout, ...changes } : layout);
      const { state, report } = convertDwg(payload);
      expect(state.layouts![0]!.paper).toMatchObject({ id: 'custom', width: 9, height: 12 });
      expect(report!.items.find(item => item.type === 'LAYOUT')).toMatchObject({ action: 'unsupported' });
    }
  });

  it('keeps legacy DTO limits-based fallback when no certified native page setup is present', () => {
    const payload = dto(reference());
    delete payload.nativeMetadata;
    const { state, report } = convertDwg(payload);
    expect(state.layouts![0]!.paper).toMatchObject({ id: 'custom', width: 9, height: 12 });
    expect(report!.items.find(item => item.type === 'LAYOUT')!.reason).toContain('not exposed by the DWG reader');
  });

  it('uses the native plot origin with trusted DTO paper geometry instead of substituting projection geometry', () => {
    const text = reference({ 46: 19.05, 47: 44.45 }, true), payload = dto(text), source = readDxf(text);
    const circle = source.cadGraph!.nodes.find(node => node.type === 'CIRCLE')!;
    const paper = payload.blocks.find(block => block.name === '*Paper_Space')!;
    paper.entities = [{ type: 'CIRCLE', handle: circle.sourceHandle!, layer: '0', colorIndex: 256, center: { x: 9, y: 10, z: 0 }, radius: 0.75 }] as unknown as typeof paper.entities;
    const { state } = convertDwg(payload);
    expect(state.cadGraph).toBeDefined();
    expect(state.layouts![0]!.entities).toHaveLength(1);
    const entity = state.layouts![0]!.entities[0]!;
    expect(entity).toMatchObject({ type: 'circle', radius: 0.75 });
    if (entity.type !== 'circle') throw new Error('Trusted circle not imported.');
    expect(entity.center.x).toBeCloseTo(10, 12); expect(entity.center.y).toBeCloseTo(12, 12);
  });

  it.each([0, 1, 2, 3])('retains exact custom media, physical dimensions and native rotation%s until paper changes', rotation => {
    const text = reference({ 4: 'Custom_Device_Form_雷', 44: 292.1, 45: 419.1, 73: rotation });
    const source = readDxf(text), layout = source.layouts![0]!, node = layoutNode(source);
    const generated = layoutNode(readDxf(writeDxf(new Drawing({ layouts: [layout] }).snapshot)));
    const retained = retainNativeLayoutPaper(node.groups, generated.groups, layout);
    const result = { ...generated, groups: retained };
    for (const code of [4, 44, 45, 72, 73]) expect(group(result, code)).toBe(group(node, code));
    const changed = { ...layout, paper: paperFromSize(24, 18, 'in', 'landscape') };
    expect(retainNativeLayoutPaper(node.groups, generated.groups, changed)).toEqual(generated.groups);
    const turned = { ...layout, paper: { ...layout.paper, orientation: layout.paper.orientation === 'landscape' ? 'portrait' as const : 'landscape' as const } };
    expect(retainNativeLayoutPaper(node.groups, generated.groups, turned)).toEqual(generated.groups);
    const metric = { ...layout, paper: paperFromSize(292.1, 419.1, 'mm', layout.paper.orientation) };
    expect(retainNativeLayoutPaper(node.groups, generated.groups, metric)).toEqual(generated.groups);
  });

  it.each([0, 1, 2, 3])('preserves device media aliases through DXF save/reopen while explicit paper edits win, rotation%s', rotation => {
    const source = readDxf(reference({ 4: 'Printer_Form_Custom_11.50x16.50', 44: 292.1, 45: 419.1, 73: rotation }));
    const node = layoutNode(source), original = source.layouts![0]!.paper;
    const once = writeDxf(source), back = readDxf(once), retained = layoutNode(back);
    expect(back.layouts![0]!.paper).toEqual(original);
    for (const code of [4, 44, 45, 72, 73]) expect(group(retained, code)).toBe(group(node, code));
    expect(writeDxf(back)).toBe(once);
    const updated = { ...back, layouts: back.layouts!.map(layout => ({ ...layout, paper: paperFromSize(25.5, 18.75, 'in', 'landscape') })) };
    const editedText = writeDxf(updated), edited = readDxf(editedText), editedNode = layoutNode(edited);
    expect(edited.layouts![0]!.paper).toMatchObject({ id: 'custom', units: 'in', orientation: 'landscape' });
    expect(edited.layouts![0]!.paper.width).toBeCloseTo(18.75, 12);
    expect(edited.layouts![0]!.paper.height).toBeCloseTo(25.5, 12);
    expect(group(editedNode, 4)).toBe('USER_(18.75_x_25.50_Inches)');
    expect(Number(group(editedNode, 44))).toBeCloseTo(476.25, 10);
    expect(Number(group(editedNode, 45))).toBeCloseTo(647.7, 10);
    expect(Number(group(editedNode, 73))).toBe(1);
    expect(writeDxf(edited)).toBe(editedText);
  });

  it('preserves uneditable Model plot settings through repeated DXF saves', () => {
    const pairs = tokenize(reference());
    const models = pairs.flatMap((pair, index) => pair.code === 0 && pair.value === 'LAYOUT' ? [index] : []);
    const start = models[1]!;
    const at = pairs.findIndex((pair, index) => index > start && pair.code === 100 && pair.value === 'AcDbPlotSettings');
    const end = pairs.findIndex((pair, index) => index > at && pair.code === 100 && pair.value === 'AcDbLayout');
    for (const [code, value] of [[4, 'Uneditable_Model_Device_Media'], [44, '400'], [45, '600'], [73, '3'], [46, '12.34'], [7, 'Device_Custom_Styles.stb']] as const) {
      const index = pairs.findIndex((pair, index) => index > at && index < end && pair.code === code);
      pairs[index] = { code, value };
    }
    const source = readDxf(pairs.flatMap(pair => [String(pair.code), pair.value]).join('\r\n') + '\r\n');
    const node = layoutNode(source, 'Model'), text = writeDxf(source), back = readDxf(text);
    expect(plotGroups(layoutNode(back, 'Model'))).toEqual(plotGroups(node));
    expect(writeDxf(back)).toBe(text);
  });

  it('binds a copied sheet to its current anchor so an explicit paper edit cannot borrow the original sheet settings', () => {
    const doc = new Drawing(readDxf(reference({ 4: 'Device_Specific_Source_Media' })));
    // Real Drawing + LayoutController; only the unused UI/log host is a double.
    const controller = new LayoutController({ doc, log() {} } as unknown as Editor);
    expect(controller.copyLayout('Sheet', 'Copy')).toBe('Copy');
    const before = doc.snapshot;
    const copied = before.cadGraph!.nodes.find(node => node.type === 'LAYOUT' && node.anchor?.kind === 'layout' && node.anchor.name === 'Copy')!;
    expect(copied.sourceHandle).toBeUndefined();
    expect(copied.groups).toContainEqual([1, 'Sheet']);
    doc.transact(state => ({ ...state, layouts: state.layouts!.map(layout => layout.name === 'Copy' ? { ...layout, paper: paperFromSize(25.5, 18.75, 'in', 'landscape') } : layout) }));
    const edited = doc.snapshot, text = writeDxf(edited), back = readDxf(text);
    const copy = back.layouts!.find(layout => layout.name === 'Copy')!;
    expect(copy.paper).toMatchObject({ id: 'custom', units: 'in', orientation: 'landscape' });
    expect(copy.paper.width).toBeCloseTo(18.75, 12); expect(copy.paper.height).toBeCloseTo(25.5, 12);
    expect(group(layoutNode(back, 'Sheet'), 4)).toBe('Device_Specific_Source_Media');
    expect(group(layoutNode(back, 'Copy'), 4)).toBe('USER_(18.75_x_25.50_Inches)');
    expect(writeDxf(back)).toBe(text);
    expect(doc.undo()).toBe(true); expect(doc.snapshot).toBe(before);
    const restored = readDxf(writeDxf(doc.snapshot));
    expect(group(layoutNode(restored, 'Copy'), 4)).toBe('Device_Specific_Source_Media');
    expect(doc.redo()).toBe(true); expect(doc.snapshot).toBe(edited);
    expect(writeDxf(doc.snapshot)).toBe(text);
  });

  it('retains model-space plot settings and opaque nested application content without treating them as editable sheet defaults', () => {
    const source = readDxf(reference()), node = layoutNode(source, 'Model');
    const marker = node.groups.findIndex(([code, value]) => code === 100 && value === 'AcDbLayout');
    const opaque: CadGroup[] = [[102, '{PRIVATE'], [100, 'AcDbLayout'], [4, 'opaque media'], [102, '}']];
    const native = [...node.groups.slice(0, marker), ...opaque, ...node.groups.slice(marker)];
    const generated = node.groups.map(([code, value]): CadGroup => [code, code === 4 ? 'Default_New_Model_Media' : value]);
    const retained = retainNativeLayoutPaper(native, generated, 'model');
    expect(retained.slice(marker, marker + opaque.length)).toEqual(opaque);
    expect(retained).toContainEqual([4, group(node, 4)!]);
    expect(retained.some(([code, value]) => code === 4 && value === 'Default_New_Model_Media')).toBe(false);
  });

  it.each(['duplicate plot subclass', 'duplicate paper width', 'unsupported units', 'invalid rotation', 'opaque markers'])('refuses ambiguous or unsupported native paper input: %s', kind => {
    const source = readDxf(reference()), node = layoutNode(source), groups = [...node.groups];
    if (kind === 'duplicate plot subclass') groups.push([100, 'AcDbPlotSettings']);
    if (kind === 'duplicate paper width') groups.splice(groups.findIndex(([code, value]) => code === 100 && value === 'AcDbLayout'), 0, [44, '279.4']);
    if (kind === 'unsupported units' || kind === 'invalid rotation') {
      const code = kind === 'unsupported units' ? 72 : 73, at = groups.findIndex(([candidate]) => candidate === code);
      groups[at] = [code, kind === 'unsupported units' ? '2' : '4294967297'];
    }
    if (kind === 'opaque markers') {
      const at = groups.findIndex(([code, value]) => code === 100 && value === 'AcDbPlotSettings');
      groups[at] = [100, 'Unknown_Subclass'];
      groups.splice(at + 1, 0, [102, '{OPAQUE'], [100, 'AcDbPlotSettings'], [102, '}']);
    }
    expect(readNativeLayoutPlotSettings(groups, 'Sheet', 'in')).toBeUndefined();
    expect(retainNativeLayoutPaper(groups, node.groups, source.layouts![0]!)).toEqual(node.groups);
  });
});
