import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_HEADER, Drawing, type DrawingState } from '../src/core/document';
import { STANDARD_DIMSTYLE } from '../src/core/dimension';
import type { DimensionEntity, Entity, MTextEntity, TextEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
import { mergeDwgCadGraph } from '../src/io/cad-graph-dwg';
// @ts-expect-error plain JS reader shared with Electron/CLI, like tests/dwg.test.ts
import { readDwgPayload } from '../scripts/dwg-reader.mjs';

/** Reproduce the native DTO's temporary exact handle identity without borrowing XDATA. */
function dtoState(projected: DrawingState): DrawingState {
  const handles = new Map(projected.cadGraph!.nodes.flatMap(node => node.anchor?.kind === 'entity' && !node.anchor.part && node.sourceHandle ? [[node.anchor.id, node.sourceHandle] as const] : []));
  const entity = (value: Entity): Entity => ({ ...value, id: `native:${value.id}`, cadIdentity: handles.get(value.id)! });
  return { ...projected, cadGraph: undefined, entities: projected.entities.map(entity), blocks: Object.fromEntries(Object.entries(projected.blocks).map(([name, block]) => [name, { ...block, entities: block.entities.map(entity) }])), ...(projected.layouts ? { layouts: projected.layouts.map(layout => ({ ...layout, entities: layout.entities.map(entity) })) } : {}), header: { ...DEFAULT_HEADER } };
}

async function nativeFixture(name: string): Promise<DwgImportPayload> {
  const { payload } = await readDwgPayload(readFileSync(new URL(`./fixtures/interchange/${name}.dwg`, import.meta.url)));
  expect(payload.nativeMetadata).toMatchObject({ readError: 0, writeError: 0, complete: true });
  return payload as DwgImportPayload;
}

describe('checked DWG XDATA supplements preserve display semantics at exact source handles', () => {
  it.skipIf(process.platform !== 'win32')('keeps the real native AcCmTransparency layer opacity without replacing repaired RGB/book appearance', async () => {
    const payload = await nativeFixture('r2018-portable-appearance');
    const projected = readDxf(payload.nativeMetadata!.dxf);
    const source = projected.layers.find(layer => layer.name === 'RICH')!;
    expect(source.transparency).toBe(64);
    const node = projected.cadGraph!.nodes.find(node => node.type === 'LAYER' && node.anchor?.kind === 'table' && node.anchor.name === 'RICH')!;
    expect(node.groups).toContainEqual([1001, 'AcCmTransparency']);
    const { state } = convertDwg(payload);
    const layer = state.layers.find(value => value.name === 'RICH')!;
    expect(layer).toMatchObject({ transparency: 64, trueColor: 0x123456, colorName: 'Studio Book$Teal 雷' });
    expect(readDxf(writeDxf(state)).layers.find(value => value.name === 'RICH')).toMatchObject({ transparency: 64, trueColor: 0x123456, colorName: 'Studio Book$Teal 雷' });
  }, 60_000);

  it.skipIf(process.platform !== 'win32')('keeps actual JCAD_MTEXT_COLUMNS from the seven-mask DWG when native scalar column getters omit it', async () => {
    const payload = await nativeFixture('r2018-mtext-background');
    const projected = readDxf(payload.nativeMetadata!.dxf);
    const source = projected.entities.find((entity): entity is MTextEntity => entity.type === 'mtext' && entity.text === 'COLUMN ONE\nCOLUMN TWO')!;
    expect(source.columns).toEqual({ type: 1, count: 2, width: 6, gutter: 3, heights: [20, 20], autoHeight: false, reversed: false });
    const { state } = convertDwg(payload);
    const column = state.entities.find((entity): entity is MTextEntity => entity.type === 'mtext' && entity.text === source.text)!;
    expect(column.columns).toEqual(source.columns);
    expect(column.background).toMatchObject({ flags: 1, scale: 1.5, color: 2, transparency: 0 });
    expect((readDxf(writeDxf(state)).entities.find(entity => entity.type === 'mtext' && entity.text === source.text) as MTextEntity).columns).toEqual(source.columns);
  }, 60_000);

  it('applies only explicit ACAD DSTYLE overrides while retaining the DTO geometry, appearance and inherited style values', () => {
    const dimension: DimensionEntity = { id: 'dimension', type: 'dimension', layer: '0', color: 'ByLayer', kind: 'linear', p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, linePoint: { x: 5, y: 2 }, rotation: 0, style: { ...STANDARD_DIMSTYLE, textHeight: 3.5, arrowSize: 2.25, decimals: 3 } };
    const projected = readDxf(writeDxf(new Drawing({ entities: [dimension], header: { ...DEFAULT_HEADER, dimStyle: STANDARD_DIMSTYLE } }).snapshot));
    const source = projected.entities.find((entity): entity is DimensionEntity => entity.type === 'dimension')!;
    expect(source.style).toMatchObject({ textHeight: 3.5, arrowSize: 2.25, decimals: 3 });
    const node = projected.cadGraph!.nodes.find(value => value.type === 'DIMENSION')!;
    expect(node.groups).toContainEqual([1001, 'ACAD']);
    expect(node.groups).toContainEqual([1000, 'DSTYLE']);
    const dto = dtoState(projected);
    const base: DrawingState = { ...dto, entities: dto.entities.map(entity => entity.type === 'dimension' ? { ...entity, p1: { x: 100, y: 200 }, trueColor: 0xfedcba, transparency: 96, style: { ...STANDARD_DIMSTYLE, scale: 7 } } : entity) };
    const merged = mergeDwgCadGraph(base, projected, { entityTypes: new Map([[node.sourceHandle!, 'DIMENSION']]) });
    expect(merged.entities[0]).toMatchObject({ p1: { x: 100, y: 200 }, trueColor: 0xfedcba, transparency: 96, style: { textHeight: 3.5, arrowSize: 2.25, decimals: 3, scale: 7 } });
    expect((readDxf(writeDxf(merged)).entities[0] as DimensionEntity).style).toMatchObject({ textHeight: 3.5, arrowSize: 2.25, decimals: 3, scale: 7 });
  });

  it('retains enabled AcadAnnotative entity flags and annotation header controls without replacing trusted text placement', () => {
    const text: TextEntity = { id: 'annotation', type: 'text', layer: '0', color: 'ByLayer', position: { x: 1, y: 2 }, height: 2, text: 'Annotation', rotation: 0, align: 'left', annotative: true };
    const projected = readDxf(writeDxf(new Drawing({ entities: [text], header: { ...DEFAULT_HEADER, cannoscale: '1:4', annoAllVisible: false } }).snapshot));
    expect(projected.header).toMatchObject({ cannoscale: '1:4', annoAllVisible: false });
    const node = projected.cadGraph!.nodes.find(value => value.type === 'TEXT')!;
    expect(node.groups).toContainEqual([1001, 'AcadAnnotative']);
    const dto = dtoState(projected);
    const base: DrawingState = { ...dto, entities: dto.entities.map(entity => ({ ...entity, annotative: undefined, ...(entity.type === 'text' ? { position: { x: 100, y: 200 }, trueColor: 0xfedcba, transparency: 96 } : {}) })) };
    const merged = mergeDwgCadGraph(base, projected, { entityTypes: new Map([[node.sourceHandle!, 'TEXT']]) });
    expect(merged.entities[0]).toMatchObject({ annotative: true, position: { x: 100, y: 200 }, trueColor: 0xfedcba, transparency: 96 });
    expect(merged.header).toMatchObject({ cannoscale: '1:4', annoAllVisible: false });
    const reopened = readDxf(writeDxf(merged));
    expect(reopened.entities[0]?.annotative).toBe(true);
    expect(reopened.header).toMatchObject({ cannoscale: '1:4', annoAllVisible: false });
  });
});
