import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';
import { convertDwg, toImportPayload, type DwgImportPayload } from '../src/io/dwg';
import { textStylesOf } from '../src/io/encoding';
// @ts-expect-error plain JS helper shared with Electron main / CLI
import { payloadFromDatabase } from '../scripts/dwg-reader.mjs';

const dxf = (angularUnits: number, scale: number, style = 'SOURCE_NOTES') => [
  0, 'SECTION', 2, 'HEADER',
  9, '$AUNITS', 70, angularUnits,
  9, '$CELTSCALE', 40, scale,
  9, '$TEXTSTYLE', 7, style,
  0, 'ENDSEC',
  0, 'SECTION', 2, 'TABLES',
  0, 'TABLE', 2, 'STYLE', 70, 1,
  0, 'STYLE', 5, '41', 2, style, 70, 0, 40, 0, 41, 0.75, 50, 10, 71, 0, 3, 'romans.shx', 4, '',
  0, 'ENDTAB', 0, 'ENDSEC', 0, 'EOF',
].join('\n');

function editAndExport(state: ReturnType<typeof readDxf>): ReturnType<typeof readDxf> {
  const doc = new Drawing(state);
  doc.addEntities([{ id: 'added', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 3, y: 2 } }]);
  doc.setHeader({ ltscale: 2, units: { ...doc.header.units, luprec: 3 } });
  expect(doc.undo()).toBe(true);
  expect(doc.redo()).toBe(true);
  return readDxf(writeDxf(doc.snapshot));
}

describe('source current drawing settings', () => {
  it.each([0, 1, 2, 3, 4])('preserves AUNITS=%i, CELTSCALE and unused TEXTSTYLE through DXF edits', (aunits) => {
    const source = readDxf(dxf(aunits, 0.625));
    expect(source.header).toMatchObject({ units: { aunits }, celtscale: 0.625, textStyle: 'SOURCE_NOTES' });
    const back = editAndExport(source);
    expect(back.header).toMatchObject({ units: { aunits, luprec: 3 }, celtscale: 0.625, textStyle: 'SOURCE_NOTES', ltscale: 2 });
    expect(back.entities).toHaveLength(1);
    expect(textStylesOf(back).SOURCE_NOTES).toMatchObject({ font: 'romans.shx', widthFactor: 0.75, oblique: 10 });
  });

  it('writes a valid STYLE reference for a current style even without source metadata', () => {
    const doc = new Drawing();
    doc.setHeader({ textStyle: 'Current_測量', celtscale: 2.5, units: { ...doc.header.units, aunits: 4 } });
    const output = writeDxf(doc.snapshot);
    expect(output).toContain('$TEXTSTYLE\r\n7\r\nCurrent_\\U+6E2C\\U+91CF');
    expect(output).toContain('\r\n2\r\nCurrent_\\U+6E2C\\U+91CF\r\n');
    const back = readDxf(output);
    expect(back.header).toMatchObject({ textStyle: 'Current_測量', celtscale: 2.5, units: { aunits: 4 } });
    expect(textStylesOf(back)['Current_測量']?.name).toBe('Current_測量');
  });

  it.each([0, 1, 2, 3, 4])('preserves exposed DWG AUNITS=%i, CELTSCALE and TEXTSTYLE through DXF edits', (aunits) => {
    const payload: DwgImportPayload = {
      header: { AUNITS: aunits, CELTSCALE: 1.75, TEXTSTYLE: 'SOURCE_NOTES' },
      entities: [], layers: [], blocks: [],
      styles: [{ name: 'SOURCE_NOTES', handle: '41', font: 'romans.shx', widthFactor: 0.75, obliqueAngle: Math.PI / 18 }],
    };
    const source = convertDwg(payload).state;
    expect(source.header).toMatchObject({ units: { aunits }, celtscale: 1.75, textStyle: 'SOURCE_NOTES' });
    const back = editAndExport(source);
    expect(back.header).toMatchObject({ units: { aunits }, celtscale: 1.75, textStyle: 'SOURCE_NOTES' });
    expect(textStylesOf(back).SOURCE_NOTES).toMatchObject({ font: 'romans.shx', widthFactor: 0.75, oblique: 10 });
  });

  it('carries the exposed settings identically in desktop and browser DWG payloads', () => {
    const db = { header: { AUNITS: 3, CELTSCALE: 0.25, TEXTSTYLE: 'SOURCE_NOTES' }, entities: [], tables: {}, objects: {} };
    const desktop = payloadFromDatabase(db, 'R_2018');
    const browser = toImportPayload(db as unknown as Parameters<typeof toImportPayload>[0], 'R_2018');
    expect(browser).toEqual(desktop);
    expect(browser.header).toEqual(db.header);
    expect(editAndExport(convertDwg(browser).state).header).toMatchObject({ units: { aunits: 3 }, celtscale: 0.25, textStyle: 'SOURCE_NOTES' });
  });

  it('uses CAD defaults when older drawing states or readers omit the settings', () => {
    for (const state of [new Drawing().snapshot, convertDwg({ header: {}, entities: [], layers: [], blocks: [] }).state]) {
      expect(readDxf(writeDxf(state)).header).toMatchObject({ units: { aunits: 0 }, celtscale: 1, textStyle: 'Standard' });
    }
  });
});
