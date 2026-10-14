import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Drawing, type DrawingState } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';
import { unusedLayers, unusedLinetypes } from '../src/tools/blocks';

function drawing(clipOn: boolean): DrawingState {
  const native = readDxf(readFileSync(new URL('./fixtures/interchange/r2018-viewport-polygon.dxf', import.meta.url), 'utf8'));
  const layout = native.layouts!.find((l) => l.name === 'Polygon')!;
  return {
    ...native,
    layers: [...native.layers, { name: 'CLIP_ONLY', color: 2, lineWeight: 0.7, plot: false, visible: true, locked: false, transparency: 102 },
      { name: 'UNUSED', color: 1, lineWeight: 0.25, visible: true, locked: false }],
    header: { ...new Drawing(native).header, linetypes: [
      { name: 'CUSTOM_CLIP', description: 'Retained clip dashes', pattern: [2, -1] },
      { name: 'UNUSED_LT', description: '', pattern: [1, -1] },
    ] },
    layouts: [{ ...layout, viewports: layout.viewports.map((v) => ({ ...v, clipOn, clipBoundary: {
      ...v.clipBoundary!, layer: 'CLIP_ONLY', linetype: 'CUSTOM_CLIP',
    } })) }],
  };
}

describe('retained viewport boundary resources', () => {
  it.each([true, false])('keeps clip-only resources through purge, undo and native DXF reopen (enabled=%s)', (clipOn) => {
    // Native import takes the outline out of paper entities: resource scans must follow the retained reference.
    const state = readDxf(writeDxf(drawing(clipOn)));
    expect(state.layouts![0]!.entities.some((e) => e.layer === 'CLIP_ONLY')).toBe(false);
    expect(unusedLayers(state)).toContain('UNUSED');
    expect(unusedLayers(state)).not.toContain('CLIP_ONLY');
    expect(unusedLinetypes(state)).toContain('UNUSED_LT');
    expect(unusedLinetypes(state)).not.toContain('CUSTOM_CLIP');
    const doc = new Drawing(state);
    doc.transactDrawing((s) => ({ ...s,
      layers: s.layers.filter((l) => !unusedLayers(s).includes(l.name)),
      header: { ...doc.header, linetypes: doc.header.linetypes.filter((l) => !unusedLinetypes(s).includes(l.name)) },
    }));
    expect(doc.dirty).toBe(true);
    expect(doc.layers.some((l) => l.name === 'UNUSED')).toBe(false);
    doc.undo(); expect(doc.layers.some((l) => l.name === 'UNUSED')).toBe(true);
    doc.redo();
    const reopened = readDxf(writeDxf(doc.snapshot));
    const boundary = reopened.layouts![0]!.viewports[0]!.clipBoundary!;
    expect(boundary).toMatchObject({ layer: 'CLIP_ONLY', linetype: 'CUSTOM_CLIP' });
    expect(reopened.layers.find((l) => l.name === 'CLIP_ONLY')).toMatchObject({ color: 2, lineWeight: 0.7, plot: false });
    expect(reopened.layers.find((l) => l.name === 'CLIP_ONLY')!.transparency).toBe(102);
    expect(reopened.header!.linetypes.find((l) => l.name === 'CUSTOM_CLIP')).toMatchObject({ pattern: [2, -1] });
    expect(reopened.layouts![0]!.viewports[0]!.clipOn !== false).toBe(clipOn);
  });

  it('exports an unloaded standard linetype referenced only by a retained boundary', () => {
    const state = drawing(false);
    const layout = state.layouts![0]!;
    const text = writeDxf({ ...state, header: { ...state.header!, linetypes: [] },
      layouts: [{ ...layout, viewports: layout.viewports.map((v) => ({ ...v, clipBoundary: { ...v.clipBoundary!, linetype: 'DASHED' } })) }],
    });
    // Standard definitions are intentionally omitted from the imported extra-linetype list.
    const record = text.split('0\r\nLTYPE\r\n').find((r) => r.includes('2\r\nDASHED\r\n'))!;
    expect(record).toContain('49\r\n0.5\r\n74\r\n0\r\n49\r\n-0.25');
    expect(readDxf(text).layouts![0]!.viewports[0]!.clipBoundary!.linetype).toBe('DASHED');
  });

  it('protects paper-entity linetypes on inactive layouts as well', () => {
    const state = drawing(true);
    const layout = state.layouts![0]!;
    const paper = { ...layout.viewports[0]!.clipBoundary!, id: 'paper', linetype: 'UNUSED_LT' };
    expect(unusedLinetypes({ ...state, layouts: [{ ...layout, entities: [paper] }] })).not.toContain('UNUSED_LT');
  });
});
