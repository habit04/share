import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readDxf, writeDxf } from '../src/io/dxf';
import { DEFAULT_HEADER, Drawing, type DrawingState } from '../src/core/document';
import type { Entity, LineEntity } from '../src/core/entities';
import { mergeDwgCadGraph } from '../src/io/cad-graph-dwg';
import { CadGraphError } from '../src/core/cad-graph';

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
