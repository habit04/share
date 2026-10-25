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
    const block = main.slice(main.indexOf('createUnderlayDisplayService'));
    expect(main.indexOf('createUnderlayDisplayService')).toBeGreaterThan(-1);
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
});
