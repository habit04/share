import { describe, expect, it } from 'vitest';
import type { Layer } from '../src/core/entities';
import { plotEntityAppearance, plotObjectProperties, plotRgbCss } from '../src/render/plot-appearance';
import { readPlotStyleTable } from '../src/io/plot-styles';
import { plotStyleProgram, plotStyleText } from './helpers/plot-style-fixture';

const layers: readonly Layer[] = [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'RED', color: 1, visible: true, locked: false, lineWeight: 0.35 },
  { name: 'RGB', color: 1, trueColor: 0x123456, visible: true, locked: false, lineWeight: 0.5 }];
const entity = { layer: 'RED', color: 'ByLayer' as const };

describe('captured plot object appearance', () => {
  it('keeps effective ACI, paper foreground and colorLayer separate from lineweight layer', () => {
    expect(plotObjectProperties(entity, layers)).toEqual({ rgb: [1, 0, 0], aci: 1, lineweightMm: 0.35 });
    expect(plotObjectProperties({ ...entity, layer: '0', colorLayer: 'RED' }, layers)).toEqual({ rgb: [1, 0, 0], aci: 1, lineweightMm: 0.25 });
    expect(plotObjectProperties({ ...entity, color: 0 }, layers)).toEqual({ rgb: [0, 0, 0], aci: 7, lineweightMm: 0.35 });
  });
  it('does not invent ACI identity for explicit or inherited TrueColor', () => {
    for (const object of [{ ...entity, trueColor: 0xff0000 }, { ...entity, layer: 'RGB' }, { ...entity, colorLayer: 'RGB' }]) {
      expect(plotObjectProperties(object, layers)).not.toHaveProperty('aci');
    }
    expect(plotObjectProperties({ ...entity, color: 1, colorLayer: 'RGB' }, layers).aci).toBe(1);
  });
  it('resolves explicit, ByLayer and already resolved ByBlock lineweights', () => {
    expect(plotObjectProperties({ ...entity, lineWeight: 0 }, layers).lineweightMm).toBe(0);
    expect(plotObjectProperties({ ...entity, lineWeight: -1 }, layers, 2).lineweightMm).toBe(0.35);
    expect(plotObjectProperties({ ...entity, lineWeight: -2 }, layers, 0.9).lineweightMm).toBe(0.9);
    expect(plotObjectProperties({ ...entity, lineWeight: -2 }, layers).lineweightMm).toBe(0.25);
    expect(plotObjectProperties({ ...entity, lineWeight: -3 }, layers).lineweightMm).toBe(0.25);
  });
  it('applies the CTB slot without changing entities or source values and bypasses TrueColor', async () => {
    const table = await readPlotStyleTable(plotStyleProgram(plotStyleText({ weights: [0, 0.7], entries: { 0: { color_policy: '5', mode_color: String(0xc2000000 | 0), lineweight: '2', screen: '50' } } })));
    const original = { ...entity }, result = plotEntityAppearance(entity, layers, table, {});
    expect(result.rgb).toEqual([128 / 255, 128 / 255, 128 / 255]); expect(result.lineweightMm).toBe(0.7); expect(entity).toEqual(original);
    const bypass = plotEntityAppearance({ ...entity, trueColor: 0xff0000 }, layers, table, {});
    expect(bypass.rgb).toEqual([1, 0, 0]); expect(bypass.lineweightMm).toBe(0.35);
  });
  it('uses explicit named STB selection and honours disabled plot styles/lineweights', async () => {
    const table = await readPlotStyleTable(plotStyleProgram(plotStyleText({ kind: 'stb', entries: { 1: { color_policy: '5', mode_color: String(0xc2000000 | 0) } } }), 'stb'));
    expect(plotEntityAppearance(entity, layers, table, {}).rgb).toEqual([1, 0, 0]);
    expect(plotEntityAppearance(entity, layers, table, { namedStyle: 'Style_1' }).rgb).toEqual([0, 0, 0]);
    const disabled = plotEntityAppearance(entity, layers, table, { namedStyle: 'Style_1', usePlotStyles: false, lineweights: false });
    expect(disabled.rgb).toEqual([1, 0, 0]); expect(disabled.lineweightMm).toBe(0);
    expect(plotRgbCss([0.5, 0, 1])).toBe('#8000ff');
  });
});
