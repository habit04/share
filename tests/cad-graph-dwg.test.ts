import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readDxf, writeDxf } from '../src/io/dxf';
import { DEFAULT_HEADER, Drawing, type DrawingState } from '../src/core/document';
import type { Entity, LineEntity } from '../src/core/entities';
import { mergeDwgCadGraph } from '../src/io/cad-graph-dwg';
import { CadGraphError } from '../src/core/cad-graph';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
// @ts-expect-error plain JS reader shared with Electron/CLI, like tests/dwg.test.ts
import { readDwgPayload } from '../scripts/dwg-reader.mjs';

const fixture = readFileSync(new URL('./fixtures/interchange/r2018-views-fields.dxf', import.meta.url), 'utf8');
const source = () => readDxf(fixture, { filePath: 'C:/Drawings/source.dwg' });
function baseState(projected: DrawingState): DrawingState {
  const nodes = new Map(projected.cadGraph!.nodes.filter(node => node.anchor?.kind === 'entity' && !node.anchor.part).map(node => [node.anchor!.kind === 'entity' ? node.anchor!.id : '', node]));
  const convert = (entity: Entity): Entity => ({ ...entity, id: `dto:${entity.id}`, cadIdentity: nodes.get(entity.id)!.sourceHandle! });
  return { ...projected, cadGraph: undefined, entities: projected.entities.map(convert), blocks: Object.fromEntries(Object.entries(projected.blocks).map(([name, block]) => [name, { ...block, entities: block.entities.map(convert) }])), ...(projected.layouts ? { layouts: projected.layouts.map(layout => ({ ...layout, entities: layout.entities.map(convert) })) } : {}), header: { ...DEFAULT_HEADER, views: [] } };
}
describe('native DWG metadata joins the established geometry/appearance DTO', () => {
  it('joins exact64-bit identities without replacing trustworthy geometry, alpha, color names or source display text', () => {
    const projected = source(), original = baseState(projected), first = original.entities.find(entity => entity.type === 'line') as LineEntity;
    const base: DrawingState = { ...original, entities: original.entities.map(entity => entity === first ? { ...first, a: { x: 123, y: 456 }, trueColor: 0xfedcba, colorName: 'Studio Book$Pearl 雷', transparency: 96 } : entity.type === 'mtext' ? { ...entity, text: 'Trusted cache 雷' } : entity) };
    const merged = mergeDwgCadGraph(base, projected);
    expect(merged.entities.find(entity => entity.id === first.id)).toMatchObject({ a: { x: 123, y: 456 }, trueColor: 0xfedcba, colorName: 'Studio Book$Pearl 雷', transparency: 96 });
    expect(merged.entities.find(entity => entity.type === 'mtext')).toMatchObject({ text: 'Drawing: source', field: { native: true, value: 'Drawing: source' } });
    expect(merged.header!.views).toHaveLength(3); expect(merged.layers).toBe(base.layers); expect(merged.cadGraph!.sourceFormat).toBe('DWG');
    const line = merged.entities.find(entity => entity.id === first.id)!;
    const node = merged.cadGraph!.nodes.find(node => node.id === line.cadIdentity)!;
    expect(node.anchor).toEqual({ kind: 'entity', id: line.id }); expect(node.baselineEntity).toBe(line);
    const reopened = readDxf(writeDxf(merged)); expect(reopened.entities.find(entity => entity.type === 'line' && entity.a.x === 123)).toMatchObject({ trueColor: 0xfedcba, colorName: 'Studio Book$Pearl 雷', transparency: 96 });
  });
  it('keeps the trusted DTO cache for unsupported object-property evaluators', () => {
    const original = source(), projected: DrawingState = { ...original, entities: original.entities.map(entity => entity.type === 'mtext' ? { ...entity, text: 'Wrong projection cache', field: { native: true, code: '%<\\AcObjProp Object(%<\\_ObjId \\_ObjIdx 0>%).Length>%', value: 'Wrong projection cache' } } : entity) };
    const base = baseState(original); const repaired = { ...base, entities: base.entities.map(entity => entity.type === 'mtext' ? { ...entity, text: 'Trusted length cache 雷' } : entity) };
    expect(mergeDwgCadGraph(repaired, projected).entities.find(entity => entity.type === 'mtext')).toMatchObject({ text: 'Trusted length cache 雷', field: { native: true, value: 'Trusted length cache 雷' } });
  });
  it('repairs table semantic names only through exactsourcehandles while preserving raw application payloads', () => {
    const projected = source(), base = baseState(projected), layer = projected.cadGraph!.nodes.find(node => node.type === 'LAYER')!;
    const name = 'Trusted layer 雷';
    const corrected: DrawingState = { ...base, layers: base.layers.map((item, index) => index ? item : { ...item, name }) };
    const merged = mergeDwgCadGraph(corrected, projected, { tableHandles: new Map([[layer.sourceHandle!, { table: 'LAYER', name }]]) });
    const rebound = merged.cadGraph!.nodes.find(node => node.id === layer.id)!;
    expect(rebound.anchor).toEqual({ kind: 'table', table: 'LAYER', name }); expect(rebound.groups.find(([code]) => code === 2)).toEqual([2, name]);
    expect(merged.cadGraph!.nodes.find(node => node.type === 'XRECORD' && node.groups.some(([code]) => code === 160))!.groups.find(([code]) => code === 160)![1].trim()).toBe('9007199254740993');
  });
  it.each([[0, false], [4, false], [115, false], [84, true]] as const)('joins native layer flags%s and trusted off%s without importing projection appearance', (flags, off) => {
    const original = source(), nativeLayer = original.cadGraph!.nodes.find(node => node.type === 'LAYER')!;
    const anchor = nativeLayer.anchor!, name = anchor.kind === 'table' ? anchor.name : '';
    const projected: DrawingState = { ...original, cadGraph: { ...original.cadGraph!, nodes: original.cadGraph!.nodes.map(node => node === nativeLayer ? { ...node, groups: node.groups.map(([code, value]) => [code, code === 70 ? String(flags) : code === 62 ? '-1' : value] as const) } : node) } };
    const dto = baseState(projected), base: DrawingState = { ...dto, layers: dto.layers.map(layer => layer.name === name ? { ...layer, frozen: true, locked: true, xrefFlags: 48, visible: false, color: 7, trueColor: 0x123456, colorName: 'Trusted Book$Teal 雷', transparency: 96 } : layer) };
    const handle = `000${nativeLayer.sourceHandle!.toLowerCase()}`;
    const merged = mergeDwgCadGraph(base, projected, { tableHandles: new Map([[handle, { table: 'LAYER', name }]]), layerOff: new Map([[handle, off]]) });
    const layer = merged.layers.find(value => value.name === name)!;
    expect(layer).toMatchObject({ visible: !off && !(flags & 1), locked: !!(flags & 4), color: 7, trueColor: 0x123456, colorName: 'Trusted Book$Teal 雷', transparency: 96 });
    expect(layer.frozen).toBe(flags & 1 ? true : undefined); expect(layer.xrefFlags).toBe(flags & 48 || undefined);
    const back = readDxf(writeDxf(merged)), retained = back.cadGraph!.nodes.find(node => node.sourceHandle === nativeLayer.sourceHandle)!;
    expect(Number(retained.groups.find(([code]) => code === 70)![1])).toBe(flags);
    expect(back.layers.find(value => value.name === name)).toMatchObject({ visible: layer.visible, locked: layer.locked, trueColor: 0x123456, colorName: 'Trusted Book$Teal 雷', transparency: 96 });
  });
  it.skipIf(process.platform !== 'win32')('restores actual AutoCAD layer0 flags through convertDwg instead of exporting the facade plot bit as xref16', async () => {
    const { payload: raw } = await readDwgPayload(readFileSync(new URL('./fixtures/interchange/r2018-views-fields.dwg', import.meta.url)));
    const payload = raw as DwgImportPayload;
    expect(payload.nativeMetadata).toMatchObject({ readError: 0, writeError: 0, complete: true });
    const native = readDxf(payload.nativeMetadata!.dxf), layer = native.cadGraph!.nodes.find(node => node.type === 'LAYER' && node.sourceHandle === '10A')!;
    expect(Number(layer.groups.find(([code]) => code === 70)![1])).toBe(0);
    const trusted = payload.layers.find(value => value.handle?.toUpperCase() === '10A')!;
    expect(trusted.name).toBe('0'); expect(trusted.off).toBe(false);
    const changed: DwgImportPayload = { ...payload, layers: payload.layers.map(value => value === trusted ? { ...value, standardFlag: 16, frozen: true, locked: true } : value) };
    const { state } = convertDwg(changed);
    expect(state.cadGraph).toBeDefined();
    const actual = state.layers.find(value => value.name === '0')!;
    expect(actual).toMatchObject({ visible: true, locked: false }); expect(actual.frozen).toBeUndefined(); expect(actual.xrefFlags).toBeUndefined();
    const saved = readDxf(writeDxf(state)).cadGraph!.nodes.find(node => node.type === 'LAYER' && node.sourceHandle === '10A')!;
    expect(Number(saved.groups.find(([code]) => code === 70)![1])).toBe(0);
  }, 60_000);
  it('refuses metadata whose source entity is absent from the trusted DTO, without returning hidden editable geometry', () => {
    const projected = source(), base = { ...baseState(projected), entities: [] };
    expect(() => mergeDwgCadGraph(base, projected)).toThrow(CadGraphError);
    expect(() => mergeDwgCadGraph(base, projected)).toThrow(/cannot be joined to a trusted DWG entity/);
  });
  it('rejects duplicate exact handles even if DTO IDs differ', () => {
    const projected = source(), base = baseState(projected), first = base.entities[0]!;
    expect(() => mergeDwgCadGraph({ ...base, entities: [...base.entities, { ...first, id: 'duplicate' }] }, projected)).toThrow(/share source handle/);
  });
  it('refuses wrong entity/table/layout classes at otherwise valid exact handles', () => {
    const projected = source(), base = baseState(projected), line = projected.cadGraph!.nodes.find(node => node.type === 'LINE')!;
    expect(() => mergeDwgCadGraph(base, projected, { entityTypes: new Map([[line.sourceHandle!, 'CIRCLE']]) })).toThrow(/DTO type CIRCLE.*metadata type LINE/);
    expect(() => mergeDwgCadGraph(base, projected, { tableHandles: new Map([[line.sourceHandle!, { table: 'LAYER', name: 'wrong' }]]) })).toThrow(/DTO table LAYER.*metadata type LINE/);
    expect(() => mergeDwgCadGraph(base, projected, { layoutHandles: new Map([[line.sourceHandle!, 'wrong']]) })).toThrow(/incompatible native metadata type LINE/);
  });
  it('prunes an unmapped plain projection entity while refusing any hard metadata dependents', () => {
    const bare = readDxf(writeDxf(new Drawing({ entities: [{ id: 'a', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }] }).snapshot)), base = { ...baseState(bare), entities: [] };
    const merged = mergeDwgCadGraph(base, bare); expect(merged.entities).toEqual([]); expect(merged.cadGraph!.nodes.some(node => node.anchor?.kind === 'entity')).toBe(false);
  });
});
