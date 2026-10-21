import { describe, expect, it } from 'vitest';
import { placedText, textJustification, textPlacementProblem, type TextPlacement } from '../src/core/text-placement';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';

/**
 * DXF TEXT horizontal mode 4 (Middle) centres the text on its anchor in BOTH axes.
 * Vertical mode 2 (middle) restates that same centring, and AutoCAD-compatible writers
 * (including the CAD that produced real Chinese switchgear drawings) emit the pair (4, 2)
 * for middle-centred text: 81 records of one customer drawing were dropped as "invalid
 * TEXT justification modes" before the pair was accepted. Vertical 1/3 still contradict
 * Middle and stay invalid, as does any vertical mode beside Aligned (3) / Fit (5).
 */
const placement = (horizontal: number, vertical: number): TextPlacement => ({
  position: { x: 10, y: 20 },
  height: 2,
  align: 'left',
  justification: textJustification(horizontal, vertical),
});

describe('TEXT justification mode combinations', () => {
  it.each([
    [0, 0], [0, 2], [1, 2], [1, 3], [2, 1], [4, 0], [4, 2],
  ])('accepts horizontal %i with vertical %i', (h, v) => {
    expect(textPlacementProblem(placement(h, v))).toBeNull();
  });

  it.each([
    [4, 1], [4, 3], [3, 1], [3, 2], [5, 2], [6, 0], [1, 4],
  ])('rejects horizontal %i with vertical %i', (h, v) => {
    expect(textPlacementProblem(placement(h, v))).toBe('invalid TEXT justification modes');
  });

  it('rejects non-integer modes', () => {
    expect(textPlacementProblem(placement(1.5, 0))).toBe('invalid TEXT justification modes');
    expect(textPlacementProblem(placement(0, 2.5))).toBe('invalid TEXT justification modes');
    expect(textPlacementProblem(placement(Number.NaN, 0))).toBe('invalid TEXT justification modes');
  });

  it('places Middle text identically whether vertical is 0 or 2', () => {
    const measure = (text: string, height: number) => text.length * height;
    const base = {
      position: { x: 10, y: 20 },
      firstAlignmentPoint: { x: 1, y: 2 },
      alignmentPoint: { x: 10, y: 20 },
      height: 2,
      rotation: 0.3,
      align: 'center' as const,
      text: '系统图',
    };
    const fromZero = placedText({ ...base, justification: textJustification(4, 0) }, measure);
    const fromMiddle = placedText({ ...base, justification: textJustification(4, 2) }, measure);
    expect(fromMiddle).toEqual(fromZero);
    // Middle semantics pinned down: centred alignment, anchor dropped by half the height.
    expect(fromMiddle.align).toBe('center');
    expect(fromMiddle.position.x).toBeCloseTo(10 + Math.sin(0.3) * 1);
    expect(fromMiddle.position.y).toBeCloseTo(20 - Math.cos(0.3) * 1);
  });
});

describe('DWG conversion of Middle-justified TEXT', () => {
  const payload = {
    header: {},
    layers: [],
    blocks: [],
    entities: [
      { type: 'TEXT', handle: 'MID42', layer: '0', startPoint: { x: 99, y: 99 }, endPoint: { x: 50, y: 60 }, text: '系统图', textHeight: 2, rotation: 0, halign: 4, valign: 2, xScale: 1, obliqueAngle: 0 },
      { type: 'TEXT', handle: 'BAD41', layer: '0', startPoint: { x: 5, y: 5 }, endPoint: { x: 0, y: 0 }, text: 'BAD', textHeight: 2, rotation: 0, halign: 4, valign: 1, xScale: 1, obliqueAngle: 0 },
      { type: 'TEXT', handle: 'PLAIN', layer: '0', startPoint: { x: 1, y: 1 }, endPoint: { x: 0, y: 0 }, text: 'PLAIN', textHeight: 2, rotation: 0, halign: 0, valign: 0, xScale: 1, obliqueAngle: 0 },
    ],
  } as unknown as DwgImportPayload;

  it('retains the (4, 2) record with string and justification intact', () => {
    const { state } = convertDwg(payload);
    const kept = state.entities.find((e) => e.type === 'text' && e.text === '系统图');
    expect(kept?.type).toBe('text');
    if (kept?.type !== 'text') return;
    expect(kept.justification).toEqual({ horizontal: 4, vertical: 2 });
    expect(kept.align).toBe('center');
    expect(kept.position).toEqual({ x: 50, y: 60 });
    expect(kept.alignmentPoint).toEqual({ x: 50, y: 60 });
    expect(kept.firstAlignmentPoint).toEqual({ x: 99, y: 99 });
  });

  it('still drops the contradictory (4, 1) record with a report item', () => {
    const { state, report } = convertDwg(payload);
    expect(state.entities.some((e) => e.type === 'text' && e.text === 'BAD')).toBe(false);
    const drops = (report?.items ?? []).filter((i) => i.type === 'TEXT' && i.action === 'dropped');
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ handle: 'BAD41' });
    expect(drops[0]!.reason).toContain('invalid TEXT justification modes');
  });

  it('retains a default (0, 0) record without a justification (regression)', () => {
    const { state } = convertDwg(payload);
    const plain = state.entities.find((e) => e.type === 'text' && e.text === 'PLAIN');
    expect(plain?.type).toBe('text');
    if (plain?.type !== 'text') return;
    expect(plain.justification).toBeUndefined();
    expect(plain.align).toBe('left');
  });
});
