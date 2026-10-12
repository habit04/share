import { describe, expect, it } from 'vitest';
import { readDxf, writeDxf } from '../src/io/dxf';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
import { explodeInsert, translateEntity, rotateEntity, scaleEntityBy, mirrorEntityAcross, type InsertEntity, type TextEntity } from '../src/core/entities';
import { resolveAlpha } from '../src/core/appearance';
import { resolveColor } from '../src/render/draw';
import { drawingContext, plotPages, renderPdfPages } from '../src/io/pdf-vector';

// Native ATTDEF/ATTRIB records authored independently of JCad's writer. These exercise
// the combined TEXT-placement and CAD-appearance feature, including an attribute override.
const native = [
  0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1024', 0, 'ENDSEC',
  0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, 1,
  0, 'LAYER', 100, 'AcDbSymbolTableRecord', 100, 'AcDbLayerTableRecord', 2, 'HOST', 70, 0, 62, 3, 6, 'CONTINUOUS', 1001, 'AcCmTransparency', 1071, 33554560,
  0, 'ENDTAB', 0, 'ENDSEC',
  0, 'SECTION', 2, 'BLOCKS', 0, 'BLOCK', 2, 'A', 70, 2, 10, 0, 20, 0,
  0, 'ATTDEF', 100, 'AcDbEntity', 8, '0', 62, 0, 440, 16777216, 100, 'AcDbText', 10, 1, 20, 2, 40, 1, 1, 'DEFAULT', 100, 'AcDbAttributeDefinition', 2, 'INHERIT', 3, 'Prompt', 70, 0,
  0, 'ATTDEF', 100, 'AcDbEntity', 8, 'HOST', 62, 2, 420, 1193046, 430, 'Book$Definition 雷', 440, 33554632, 100, 'AcDbText', 10, 1, 20, 4, 40, 1, 1, 'DEFAULT', 100, 'AcDbAttributeDefinition', 2, 'DIRECT', 3, 'Prompt', 70, 0,
  0, 'ATTDEF', 100, 'AcDbEntity', 8, '0', 62, 3, 420, 1122867, 430, 'Book$Constant Δ', 440, 33554560, 100, 'AcDbText', 10, 1, 20, 6, 40, 1, 1, 'CONSTANT', 100, 'AcDbAttributeDefinition', 2, 'CONSTANT', 3, 'Prompt', 70, 2,
  0, 'ENDBLK', 0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'INSERT', 100, 'AcDbEntity', 8, 'HOST', 62, 1, 420, 11259375, 430, 'Book$Reference', 440, 33554528, 100, 'AcDbBlockReference', 66, 1, 2, 'A', 10, 10, 20, 20, 41, 2, 42, 2,
  0, 'ATTRIB', 100, 'AcDbEntity', 8, '0', 62, 0, 440, 16777216, 100, 'AcDbText', 10, 12, 20, 24, 40, 2, 1, 'PARENT', 100, 'AcDbAttribute', 2, 'INHERIT', 70, 0,
  0, 'ATTRIB', 100, 'AcDbEntity', 8, 'HOST', 62, 4, 420, 6636321, 430, 'Book$Override Ω', 440, 33554432, 100, 'AcDbText', 10, 12, 20, 28, 40, 2, 1, 'OVERRIDE', 100, 'AcDbAttribute', 2, 'DIRECT', 70, 0,
  0, 'SEQEND', 0, 'ENDSEC', 0, 'EOF',
].join('\n');
const sample = () => readDxf(native);
const placementsOf = (ins: InsertEntity) => (ins as unknown as { attributePlacements: Record<string, Record<string, unknown>> }).attributePlacements;

describe('combined native attribute appearance and placement', () => {
  it('keeps ATTDEF appearance and each native ATTRIB override independently on DXF reimport', () => {
    for (const state of [sample(), readDxf(writeDxf(sample()))]) {
      expect(state.blocks.A?.attributes[1]).toMatchObject({ trueColor: 0x123456, colorName: 'Book$Definition 雷', transparency: 200 });
      expect(state.blocks.A?.attributes[2]).toMatchObject({ trueColor: 0x112233, colorName: 'Book$Constant Δ', transparency: 128 });
      const ins = state.entities[0] as InsertEntity;
      expect(placementsOf(ins).INHERIT).toMatchObject({ color: 0, transparency: 'ByBlock' });
      expect(placementsOf(ins).DIRECT).toMatchObject({ trueColor: 0x654321, colorName: 'Book$Override Ω', transparency: 0 });
    }
    expect(writeDxf(sample())).toContain('AC1024');
  });

  it('promotes the DXF version when only an attribute carries transparency or a named identity', () => {
    const attributeOnly = native.replace('\n1001\nAcCmTransparency\n1071\n33554560', '').replace('\n440\n33554528', '').replace('\n430\nBook$Reference', '');
    expect(writeDxf(readDxf(attributeOnly))).toContain('AC1024');
    const namesOnly = attributeOnly.replace(/\n440\n\d+/g, '');
    expect(writeDxf(readDxf(namesOnly))).toContain('AC1018');
  });

  it('uses parent alpha only for ByBlock attributes and keeps explicit/constant appearance through transforms', () => {
    const state = sample(), ins = state.entities[0] as InsertEntity;
    const variants = [ins, translateEntity(ins, { x: 5, y: 7 }), rotateEntity(ins, { x: 0, y: 0 }, 0.4), scaleEntityBy(ins, { x: 0, y: 0 }, 2), mirrorEntityAcross(ins, { x: 0, y: 0 }, { x: 1, y: 0 })] as InsertEntity[];
    for (const ref of variants) {
      const texts = explodeInsert(ref, (n) => state.blocks[n]).filter((e): e is TextEntity => e.type === 'text');
      expect(texts.map((e) => Math.round(resolveAlpha(e, state.layers) * 255))).toEqual([96, 0, 128]);
      expect(texts.map((e) => resolveColor(e, state.layers))).toEqual(['#abcdef', '#654321', '#112233']);
      expect(texts.map((e) => e.colorName)).toEqual(['Book$Reference', 'Book$Override Ω', 'Book$Constant Δ']);
    }
  });

  it('emits the resolved attribute alpha in the vector PDF content', () => {
    const state = sample(), lookup = (n: string) => state.blocks[n];
    const pages = plotPages(state, lookup, 'model', { paper: 'letter', orientation: 'landscape', scale: 'fit', margin: 0.25 });
    const rendered = renderPdfPages(pages, drawingContext(state, lookup), { mode: 'color', lineweights: true, usePlotStyles: true });
    expect(rendered[0]?.content.match(/\/A\d+ gs/g)).toEqual(['/A96 gs', '/A0 gs', '/A128 gs']);
  });

  it('preserves the same appearance when exposed by DWG ATTDEF/ATTRIB fields', () => {
    const text = { text: 'DEFAULT', startPoint: { x: 1, y: 2 }, textHeight: 1, rotation: 0, halign: 0, valign: 0 };
    const payload = {
      header: {}, layers: [],
      blocks: [{ name: 'A', basePoint: { x: 0, y: 0 }, entities: [{ type: 'ATTDEF', layer: '0', colorIndex: 2, color: 0x123456, colorName: 'Book$Definition', transparencyType: 3, transparency: 200, tag: 'TAG', text }] }],
      entities: [{ type: 'INSERT', layer: '0', name: 'A', insertionPoint: { x: 0, y: 0 }, xScale: 1, yScale: 1, colorIndex: 1, color: 0xabcdef, colorName: 'Book$Reference', transparencyType: 3, transparency: 96, attribs: [{ type: 'ATTRIB', layer: '0', colorIndex: 0, transparencyType: 1, transparency: 0, tag: 'TAG', text: { ...text, text: 'PARENT' } }] }],
    } as unknown as DwgImportPayload;
    const state = convertDwg(payload).state;
    expect(state.blocks.A?.attributes[0]).toMatchObject({ trueColor: 0x123456, colorName: 'Book$Definition', transparency: 200 });
    const ins = state.entities[0] as InsertEntity;
    expect(placementsOf(ins).TAG).toMatchObject({ color: 0, transparency: 'ByBlock' });
    const visible = explodeInsert(ins, (n) => state.blocks[n])[0]!;
    expect(visible).toMatchObject({ trueColor: 0xabcdef, colorName: 'Book$Reference', transparency: 96 });
  });
});
