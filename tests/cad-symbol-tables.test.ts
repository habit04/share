import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';
import { isPlainStandard, STANDARD_TEXT_STYLE, textStylesOf } from '../src/io/encoding';

type Pair = [number, string];
interface Record { type: string; section: string; groups: Pair[] }
const fixture = (name: string) => readFileSync(new URL(`./fixtures/interchange/${name}.dxf`, import.meta.url), 'utf8');
const pairs = (input: string): Pair[] => {
  const lines = input.trimEnd().split(/\r\n|\n|\r/); const result: Pair[] = [];
  for (let index = 0; index < lines.length; index += 2) result.push([Number(lines[index]!.trim()), lines[index + 1]!]);
  return result;
};
const records = (input: string): Record[] => {
  const result: Record[] = [], all = pairs(input); let section = '', current: Record | undefined;
  for (let index = 0; index < all.length; index++) {
    const [code, value] = all[index]!;
    if (code === 0) {
      current = undefined;
      if (value.trim() === 'SECTION') section = all[++index]![1].trim();
      else if (value.trim() === 'ENDSEC') section = '';
      else { current = { type: value.trim(), section, groups: [] }; result.push(current); }
    } else current?.groups.push([code, value]);
  }
  return result;
};
const tableRecord = (input: string, type: string, name: string) => records(input).find(record => record.section === 'TABLES' && record.type === type && record.groups.some(([code, value]) => code === 2 && value.trim().toUpperCase() === name.toUpperCase()))!;
const value = (record: Record, code: number) => record.groups.find(([group]) => code === group)?.[1].trim();
const mutate = (input: string, type: string, name: string, code: number, value: number) => {
  const all = pairs(input); let start = -1;
  for (let index = 0; index < all.length; index++) {
    if (all[index]![0] === 0) start = all[index]![1].trim() === type ? index : -1;
    if (start >= 0 && all[index]![0] === 2 && all[index]![1].trim() === name) {
      let end = all.findIndex(([group], at) => at > start && group === 0); if (end < 0) end = all.length;
      const at = all.findIndex(([group], at) => at > start && at < end && group === code); expect(at).toBeGreaterThanOrEqual(0);
      all[at] = [code, String(value)]; return all.flat().join('\r\n') + '\r\n';
    }
  }
  throw new Error(`Fixture ${type} ${name} is missing.`);
};

describe('retained native symbol-table properties', () => {
  it('keeps real inch insertion units and all complete native active-VPORT camera properties', () => {
    const source = fixture('r2018-image-inches'), state = readDxf(source), output = writeDxf(state);
    for (const name of ['*Model_Space', '*Paper_Space']) expect(value(tableRecord(output, 'BLOCK_RECORD', name), 70)).toBe('1');
    const viewport = tableRecord(source, 'VPORT', '*Active'), actual = tableRecord(output, 'VPORT', '*Active');
    expect(viewport.groups.filter(([code]) => ![5, 330].includes(code))).toEqual(actual.groups.filter(([code]) => ![5, 330].includes(code)));
    expect(writeDxf(readDxf(output))).toBe(output);
  });
  it('keeps real 3D-ready native camera data independently of edited drawing limits', () => {
    const source = fixture('r2018-views-fields'), state = readDxf(source);
    const output = writeDxf({ ...state, header: { ...state.header!, limits: { min: { x: 100, y: 200 }, max: { x: 900, y: 800 } } } });
    const viewport = tableRecord(source, 'VPORT', '*Active'), actual = tableRecord(output, 'VPORT', '*Active');
    for (const code of [10, 20, 11, 21, 12, 22, 40, 41, 16, 26, 36, 17, 27, 37, 50, 51, 71, 72]) expect(value(actual, code)).toBe(value(viewport, code));
  });
  it.each([['APPID', 'ACAD', 70, 64], ['BLOCK_RECORD', '*Model_Space', 280, 0], ['BLOCK_RECORD', '*Model_Space', 281, 1], ['LTYPE', 'Continuous', 70, 64], ['DIMSTYLE', 'Standard', 70, 64]] as const)('retains %s %s group%s without an editor model override', (type, name, code, desired) => {
    const source = mutate(fixture('r2018-views-fields'), type, name, code, desired), output = writeDxf(readDxf(source));
    expect(value(tableRecord(output, type, name), code)).toBe(String(desired));
  });
  it('preserves source new-viewport/reference layer flags while live frozen/locked/xref edits take effect', () => {
    const source = mutate(fixture('r2018-views-fields'), 'LAYER', '0', 70, 66), drawing = new Drawing(readDxf(source));
    expect(value(tableRecord(writeDxf(drawing.snapshot), 'LAYER', '0'), 70)).toBe('66');
    drawing.transact(state => ({ ...state, layers: state.layers.map(layer => layer.name === '0' ? { ...layer, frozen: true, locked: true, xrefFlags: 48 } : layer) }));
    expect(value(tableRecord(writeDxf(drawing.snapshot), 'LAYER', '0'), 70)).toBe('119');
    drawing.undo(); expect(value(tableRecord(writeDxf(drawing.snapshot), 'LAYER', '0'), 70)).toBe('66');
  });
  it('keeps actual last text height independently of a current fixed-height style edit', () => {
    const source = readFileSync(new URL('./fixtures/interchange-reference.dxf', import.meta.url), 'utf8'), state = readDxf(source);
    const output = writeDxf(state); expect(value(tableRecord(output, 'STYLE', 'Standard'), 42)).toBe('2.5'); expect(value(tableRecord(output, 'STYLE', 'NOTES'), 42)).toBe('3.5');
    const styles = textStylesOf(state), changed = writeDxf({ ...state, meta: { ...state.meta, textStyles: { ...styles, NOTES: { ...styles.NOTES!, height: 8 } } } });
    expect(value(tableRecord(changed, 'STYLE', 'NOTES'), 40)).toBe('8'); expect(value(tableRecord(changed, 'STYLE', 'NOTES'), 42)).toBe('3.5');
  });
  it.each([[70, 4], [71, 2], [71, 4]] as const)('keeps nondefault Standard STYLE group%s in the semantic style map and output', (code, desired) => {
    const source = mutate(fixture('r2018-views-fields'), 'STYLE', 'Standard', code, desired), state = readDxf(source), style = Object.values(textStylesOf(state)).find(style => style.name === 'Standard')!;
    expect(style).toBeDefined(); expect(isPlainStandard(style)).toBe(false); expect(value(tableRecord(writeDxf(state), 'STYLE', 'Standard'), code)).toBe(String(desired));
    expect(isPlainStandard(STANDARD_TEXT_STYLE)).toBe(true);
  });
});
