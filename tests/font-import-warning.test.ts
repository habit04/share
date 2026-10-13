import { describe, expect, it } from 'vitest';
import { readDxf } from '../src/io/dxf';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
import { importReportOf } from '../src/io/import-report';
import { textStylesOf } from '../src/io/encoding';
import { textRenderer } from '../src/render/hershey';

const styles = [
  { name: 'ARIAL', font: 'arial.ttf' },
  { name: 'ROMANS', font: 'romans.shx' },
  { name: 'Standard', font: 'txt.shx' },
];
const dxf = ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'STYLE', '70', '3',
  ...styles.flatMap(({ name, font }) => ['0', 'STYLE', '2', name, '70', '0', '40', '1', '41', '1', '3', font, '4', '']),
  '0', 'ENDTAB', '0', 'ENDSEC', '0', 'EOF'].join('\n');
const payload: DwgImportPayload = { header: {}, entities: [], layers: [], blocks: [],
  styles: styles.map((style) => ({ ...style, fixedTextHeight: 1 })) };

describe('font loss reports match the selected renderer', () => {
  it.each(['DXF', 'DWG'] as const)('%s distinguishes TrueType fallback from SHX substitution', (format) => {
    const state = format === 'DXF' ? readDxf(dxf) : convertDwg(payload).state;
    const warnings = importReportOf(state)!.items.filter((item) => item.type === 'STYLE');
    expect(warnings).toHaveLength(2);
    const trueType = warnings.find((item) => item.reason.includes('ARIAL'))!.reason;
    expect(trueType).toContain('installed TrueType/OpenType font families and fallbacks');
    expect(trueType).toContain('matching Windows font metrics or Canvas fallback metrics determine bounds and wrapping');
    expect(trueType).not.toContain('stroke font substitute');
    expect(warnings.find((item) => item.reason.includes('ROMANS'))!.reason).toContain('stroke font substitute');
    expect(textRenderer('ARIAL', textStylesOf(state)).kind).toBe('canvas');
    expect(textRenderer('ROMANS', textStylesOf(state)).kind).toBe('stroke');
    expect(textStylesOf(state).ARIAL!.font).toBe('arial.ttf');
  });
});
