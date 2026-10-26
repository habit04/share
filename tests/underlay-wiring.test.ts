// P28 finish slice — section 1.4 stage-1 verification. The composition root
// lives in src/main.ts, which runs DOM bootstrap at import; per the repo
// idiom for main-process wiring (tests/image-loader.test.ts), these are
// source-shape assertions on the real file, plus a runtime check that the
// global the draw path reads is a function once the composition module is
// loaded in isolation is NOT possible — the scan is the pin.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const main = readFileSync('src/main.ts', 'utf8');

describe('composition-root underlay wiring (design 1.2/1.4)', () => {
  it('constructs the engine with DEFAULT deps (no injected canvas factory)', () => {
    expect(main).toContain('createPdfjsEngine()');
    expect(main).not.toContain('createPdfjsEngine({');
  });

  it('constructs the display service always (not conditional on a bridge method)', () => {
    const block = main.slice(main.indexOf('const underlays = createUnderlayDisplayService'));
    expect(main.indexOf('const underlays = createUnderlayDisplayService')).toBeGreaterThan(-1);
    expect(block.slice(0, 400)).toContain('bytesFor');
    expect(main).toContain('createPdfjsEngine');
    // The byte source selection is the only conditional: bridge-bound or null.
    expect(main).toContain('bridgeUnderlayBytes');
    expect(main).toContain('nullUnderlayBytes');
  });

  it('installs the seam the draw path reads, next to the imageLoader seam', () => {
    expect(main).toContain('renderSettings.underlaySource = (e) => underlays.source(e)');
    expect(main.indexOf('renderSettings.underlaySource')).toBeGreaterThan(main.indexOf('renderSettings.imageLoader'));
  });

  it('registers a dedicated file-change clear (not folded into any other handler)', () => {
    expect(main).toContain("editor.on('file', () => underlays.clear())");
  });

  it('the bridge type gains readUnderlay beside readImage, optional in both directions', () => {
    expect(main).toContain('readUnderlay?(file: string): Promise<Uint8Array | null>');
    expect(main).toContain('readImage?(file: string): Promise<string | null>');
  });

  it('wires the visible-region supply and the editor redraw', () => {
    expect(main).toContain('visibleRegionFor');
    expect(main).toContain('requestRedraw: () => editor.render()');
  });

  it('registers Reload Underlays on the section 3.6 invalidation surface', () => {
    expect(main).toContain("reg('RELOADUNDERLAYS'");
    expect(main).toContain('underlays.invalidate(def.id)');
  });
});

describe('content-consumer census (design 6.4)', () => {
  const read = (p: string) => readFileSync(p, 'utf8');
  it('every raster-content consumer is accounted for, with its source posture', () => {
    // Screen: the live global installed above, or a per-draw override.
    expect(read('src/render/draw.ts')).toContain('renderSettings.underlaySource');
    // Captured raster sheets: the captured resolver passed explicitly —
    // never the live global (the layouts.ts:209 bug, fixed).
    const layouts = read('src/render/layouts.ts');
    expect(layouts).toContain('underlaySource?: UnderlayContentSource');
    expect(layouts).toContain('underlaySource, underlayDefinitions: ctxInfo.underlays');
    // The layout sheet in editor/plotting.ts (the helper's bonus omission):
    // wired to the same captured resolver, not left on frame+label.
    const plotting = read('src/app/editor/plotting.ts');
    expect(plotting).toContain('captureUnderlayResolver');
    expect(plotting).toContain('underlaySource: sheetUnderlays.source');
    // Vector PDF: the walker's underlayImage hook over the display list.
    const walker = read('src/io/pdf-vector.ts');
    expect(walker).toContain('underlayImage');
    expect(walker).toContain('underlayDisplayList');
    // Both plot branches build the resolver from the CAPTURED state.
    const plotVector = read('src/app/plot-vector.ts');
    expect(plotVector).toContain('captureUnderlayResolver(state');
    expect(plotVector).toContain('captured.underlayBytes');
  });
});
