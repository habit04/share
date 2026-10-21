import { describe, expect, it } from 'vitest';
import type { NativeFontMetrics, TextAppearance } from '../src/core/text-metrics';
import type { ShapeProductionData } from '../src/core/text-shaping-produce';
import { FontMetricsRegistry, createTextGeometryContext } from '../src/render/font-metrics';
import { createShapingHooks, type ShapeBridge } from '../src/app/shape-preparation';

/** A synthetic face covering Latin capitals + the Arabic block,
    authored for this test (rectangles, never a copied program). */
function font(): NativeFontMetrics {
  const glyphCount = 0x300;
  const cmap = Array<number>(65536).fill(0);
  cmap[0x41] = 1;
  cmap[0x42] = 2;
  cmap[0x67] = 3;
  for (let cp = 0x600; cp <= 0x6ff; cp += 1) cmap[cp] = (cp % 0x2ff) + 1;
  const glyphBounds = Array.from({ length: glyphCount }, () => [0, -200, 600, 800] as [number, number, number, number]);
  glyphBounds[1] = [0, 0, 600, 700];
  return {
    family: 'ShapeFace', subfamily: 'Regular', unitsPerEm: 1000, capitalHeight: 700, fsType: 0, winDescent: 200,
    bold: false, italic: false, fontBounds: [0, -200, 600, 800],
    advances: Array.from({ length: glyphCount }, () => 600),
    glyphBounds, glyphBoundsKnown: Array.from({ length: glyphCount }, () => true),
    cmap, groups: [],
  };
}

const APPEARANCE: TextAppearance = { kind: 'canvas', family: 'ShapeFace', bold: false, italic: false, widthFactor: 1, oblique: 0 };

const bridge: ShapeBridge = async (request) => {
  const { text, itemStart, itemEnd } = request.shape;
  const metrics = font();
  const glyphs: ShapeProductionData['glyphs'][number][] = [];
  let cursor = itemStart;
  for (const char of text.slice(itemStart, itemEnd)) {
    const cp = char.codePointAt(0)!;
    glyphs.push({
      glyph: metrics.cmap[cp] ?? 0,
      clusterStart: cursor - itemStart,
      clusterEnd: cursor - itemStart + char.length,
      xAdvance: 600, yAdvance: 0, xOffset: 0, yOffset: 0,
    });
    cursor += char.length;
  }
  return {
    shaped: { glyphs, unitsPerEm: 1000, faceGlyphCount: 0x300, programSha256: 'ab'.repeat(32), programBytes: 100_000 },
  };
};

function setup(withHooks: boolean) {
  const registry = new FontMetricsRegistry();
  registry.register(APPEARANCE as Extract<TextAppearance, { kind: 'canvas' }>, font());
  if (withHooks) {
    registry.setShapingFactory((init) => createShapingHooks({ bridge, ...init }));
  }
  const context = createTextGeometryContext({}, registry);
  return { registry, context };
}

describe('geometry shaping wiring (step 2C)', () => {
  it('reports the fallback when a shaped item is unprepared, and serves shaped measurement after preparation', async () => {
    const text = 'سلام';
    const unprepared = setup(true);
    const fallback = unprepared.context.measure(text, 10, APPEARANCE);
    expect(fallback.advance).toBeGreaterThan(0);
    expect([...unprepared.context.fontIssues!].some((issue) => issue.startsWith('shaping-missing'))).toBe(true);

    const prepared = setup(true);
    await prepared.context.prepareShaping!(text, APPEARANCE);
    const shaped = prepared.context.measure(text, 10, APPEARANCE);
    // 4 glyphs x 600 font units, scaled by height / capitalHeight.
    expect(shaped.advance).toBeCloseTo(2400 * 10 / 700, 10);
    expect([...prepared.context.fontIssues!].some((issue) => issue.startsWith('shaping-'))).toBe(false);
    // Ready shaped runs place as whole runs, not per-char cmap advances.
    expect(prepared.context.advances!(text, 10, APPEARANCE)).toBeNull();
    const state = prepared.context.shaped!(text, APPEARANCE, 0, 4);
    expect(state.state).toBe('ready');
  });

  it('keeps gate-admitted (direct) text byte-identical with hooks attached', () => {
    const hooked = setup(true);
    const plain = setup(false);
    const text = 'ABg';
    expect(hooked.context.measure(text, 10, APPEARANCE)).toEqual(plain.context.measure(text, 10, APPEARANCE));
    expect(hooked.context.advances!(text, 10, APPEARANCE)).toEqual(plain.context.advances!(text, 10, APPEARANCE));
    expect([...hooked.context.fontIssues!].some((issue) => issue.startsWith('shaping-'))).toBe(false);
  });

  it('without a factory, shaped() is missing and measurement is unchanged', () => {
    const plain = setup(false);
    expect(plain.context.shaped!('سلام', APPEARANCE, 0, 4).state).toBe('missing');
  });
});
