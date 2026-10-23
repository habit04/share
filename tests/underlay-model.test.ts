import { describe, it, expect } from 'vitest';
import {
  UnderlayCorrespondenceError,
  underlayBounds,
  underlayCorners,
  underlayDisplayList,
  underlayIsOn,
  validateUnderlayDefinitions,
  validateUnderlayPair,
  validateUnderlayPlacement,
  type UnderlayDefinition,
  type UnderlayPlacement,
} from '../src/core/underlay';

// P28 slice 1: retained underlay model. A placement is a reference, never content:
// it points at a definition (the referenced file) and carries placement/display
// state only. These tests pin the model math and the display/plot op list that a
// later, separately admitted integration feeds to Canvas and the plot pipeline.

const pdfDef: UnderlayDefinition = {
  id: 'def-1',
  handle: '2E',
  kind: 'pdf',
  sourcePath: 'C:\\refs\\floor plan.pdf',
  page: '1',
  extent: { width: 200, height: 100 },
  retainedGroups: [],
};

const base: UnderlayPlacement = {
  id: 'u1',
  handle: '2F',
  kind: 'pdf',
  definitionHandle: '2E',
  layer: 'PDF',
  position: { x: 10, y: 20 },
  scaleX: 2,
  scaleY: 2,
  rotation: 0,
  flags: 2, // underlay on
  retainedGroups: [],
};

describe('underlay model validation', () => {
  it('accepts a well-formed placement', () => {
    expect(validateUnderlayPlacement(base)).toEqual([]);
  });

  it('refuses non-finite or zero-scale placements (atomic validation, all problems listed)', () => {
    const bad: UnderlayPlacement = { ...base, position: { x: Number.NaN, y: 0 }, scaleX: 0, scaleY: Number.POSITIVE_INFINITY, rotation: Number.NaN };
    const problems = validateUnderlayPlacement(bad);
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.join(' ')).toMatch(/position/);
    expect(problems.join(' ')).toMatch(/scale/);
  });

  it('refuses a placement with no definition reference (a reference must stay a reference)', () => {
    expect(validateUnderlayPlacement({ ...base, definitionHandle: '  ' }).join(' ')).toMatch(/definition/);
  });

  it('refuses out-of-range contrast / fade and a degenerate clip boundary', () => {
    const problems = validateUnderlayPlacement({ ...base, contrast: 101, fade: -1, clipBoundary: [{ x: 0, y: 0 }] });
    expect(problems.join(' ')).toMatch(/contrast/);
    expect(problems.join(' ')).toMatch(/fade/);
    expect(problems.join(' ')).toMatch(/clip/);
  });
});

describe('underlay geometry', () => {
  it('corners apply scale, then rotation, then insertion', () => {
    const corners = underlayCorners(base, pdfDef);
    expect(corners).toEqual([
      { x: 10, y: 20 },
      { x: 410, y: 20 },
      { x: 410, y: 220 },
      { x: 10, y: 220 },
    ]);
    const rotated = underlayCorners({ ...base, rotation: Math.PI / 2 }, pdfDef);
    expect(rotated[1]!.x).toBeCloseTo(10);
    expect(rotated[1]!.y).toBeCloseTo(420);
    expect(rotated[2]!.x).toBeCloseTo(-190);
    expect(rotated[2]!.y).toBeCloseTo(420);
  });

  it('bounds cover the rotated frame; unknown page extent falls back to the unit frame', () => {
    expect(underlayBounds(base, pdfDef)).toEqual({ minX: 10, minY: 20, maxX: 410, maxY: 220 });
    const noExtent: UnderlayDefinition = { ...pdfDef, extent: undefined };
    expect(underlayBounds(base, noExtent)).toEqual({ minX: 10, minY: 20, maxX: 12, maxY: 22 });
  });

  it('mirrored (negative) scales still produce ordered bounds', () => {
    expect(underlayBounds({ ...base, scaleX: -2 }, pdfDef)).toEqual({ minX: -390, minY: 20, maxX: 10, maxY: 220 });
  });
});

describe('underlay display / plot op list (initial PDF slice)', () => {
  it('an underlay that is off produces no display or plot ops', () => {
    expect(underlayIsOn({ ...base, flags: 0 })).toBe(false);
    expect(underlayDisplayList({ ...base, flags: 0 }, pdfDef)).toEqual([]);
  });

  it('without decoded content it draws frame + cross + label, like IMAGE without a bitmap', () => {
    const ops = underlayDisplayList(base, pdfDef);
    expect(ops.map((o) => o.op)).toEqual(['frame', 'cross', 'label']);
    const label = ops.find((o) => o.op === 'label');
    expect(label && label.op === 'label' ? label.text : '').toBe('floor plan.pdf — page 1');
  });

  it('with decoded content it emits an image op over the frame (content stays behind the adapter)', () => {
    const ops = underlayDisplayList(base, pdfDef, { width: 200, height: 100 });
    expect(ops.map((o) => o.op)).toEqual(['image', 'frame']);
    const image = ops[0];
    expect(image && image.op === 'image' ? image.sourcePath : '').toBe('C:\\refs\\floor plan.pdf');
    expect(image && image.op === 'image' ? image.page : '').toBe('1');
  });

  it('clipping on + a boundary adds a clip-frame op transformed into world space', () => {
    const clipped: UnderlayPlacement = { ...base, flags: 2 | 1, clipBoundary: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }] };
    const ops = underlayDisplayList(clipped, pdfDef);
    const clip = ops.find((o) => o.op === 'clip-frame');
    expect(clip).toBeDefined();
    expect(clip && clip.op === 'clip-frame' ? clip.points[2] : null).toEqual({ x: 110, y: 120 });
    // Clipping flag without a boundary must not invent one.
    expect(underlayDisplayList({ ...base, flags: 2 | 1 }, pdfDef).some((o) => o.op === 'clip-frame')).toBe(false);
  });

  it('label falls back to the stored path when there is no page name', () => {
    const ops = underlayDisplayList(base, { ...pdfDef, page: undefined, sourcePath: 'refs/sheet.dwf' });
    const label = ops.find((o) => o.op === 'label');
    expect(label && label.op === 'label' ? label.text : '').toBe('sheet.dwf');
  });
});

describe('underlay pair correspondence (acceptance F-B)', () => {
  const wrongDef: UnderlayDefinition = { ...pdfDef, id: 'def-2', handle: 'BBBB', sourcePath: 'WRONG-FILE.pdf' };

  it('a corresponding pair validates clean; handles compare case-insensitively', () => {
    expect(validateUnderlayPair(base, pdfDef)).toEqual([]);
    expect(validateUnderlayPair(base, { ...pdfDef, handle: '2e' })).toEqual([]);
  });

  it('a mismatched pair is a named problem, never a silent pairing', () => {
    const problems = validateUnderlayPair(base, wrongDef);
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(/2E/);
    expect(problems[0]).toMatch(/BBBB/);
    // A definition carrying no handle cannot be the referenced one.
    expect(validateUnderlayPair(base, { ...pdfDef, handle: undefined }).length).toBe(1);
  });

  it('the display list refuses a mismatched pair: no ops, with or without content (acceptance C3.2)', () => {
    expect(underlayDisplayList(base, wrongDef)).toEqual([]);
    expect(underlayDisplayList(base, wrongDef, { width: 10, height: 10 })).toEqual([]);
  });

  it('corners and bounds refuse a mismatched pair with a typed error', () => {
    expect(() => underlayCorners(base, wrongDef)).toThrow(UnderlayCorrespondenceError);
    expect(() => underlayBounds(base, wrongDef)).toThrow(/BBBB/);
    expect(() => underlayCorners(base, { ...pdfDef, handle: undefined })).toThrow(UnderlayCorrespondenceError);
  });

  it('duplicate definition handles / ids are assembly problems to report, never an overwrite', () => {
    const a: UnderlayDefinition = { id: 'underlaydef:AA', handle: 'AA', kind: 'pdf', sourcePath: 'one.pdf', retainedGroups: [] };
    const b: UnderlayDefinition = { id: 'underlaydef:AA', handle: 'AA', kind: 'pdf', sourcePath: 'two.pdf', retainedGroups: [] };
    const problems = validateUnderlayDefinitions([a, b]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toMatch(/AA/);
    // Same id under different handles collides in an id-keyed assembly too.
    const c: UnderlayDefinition = { ...a, handle: 'BB' };
    expect(validateUnderlayDefinitions([a, c]).length).toBeGreaterThan(0);
    // Distinct definitions are clean.
    const d: UnderlayDefinition = { id: 'underlaydef:CC', handle: 'CC', kind: 'pdf', sourcePath: 'three.pdf', retainedGroups: [] };
    expect(validateUnderlayDefinitions([a, d])).toEqual([]);
    expect(validateUnderlayDefinitions([a])).toEqual([]);
  });
});
