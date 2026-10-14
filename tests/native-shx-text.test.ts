import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Drawing } from '../src/core/document';
import { translateEntity, type TextEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { textStylesOf } from '../src/io/encoding';

const fixture = readFileSync(new URL('./fixtures/interchange/r2018-shx-text.dxf', import.meta.url), 'utf8');
const texts = (state: ReturnType<typeof readDxf>) => state.entities.filter((e): e is TextEntity => e.type === 'text');
const signature = (e: TextEntity) => ({ text: e.text, style: e.style, align: e.align, justification: e.justification, position: e.position, first: e.firstAlignmentPoint, second: e.alignmentPoint, height: e.height, rotation: e.rotation, width: e.widthFactor, oblique: e.oblique });
function expectSavedRows(actual: TextEntity[], expected: ReturnType<typeof signature>[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((entity, i) => {
    const row = signature(entity), wanted = expected[i]!;
    expect([row.text, row.style, row.align, row.justification]).toEqual([wanted.text, wanted.style, wanted.align, wanted.justification]);
    // The existing DXF writer serializes these small coordinates to ten decimal places.
    // Compare half that quantum plus floating-point representation slack, not native ink tolerance.
    const number = (value: number | undefined, target: number | undefined) => {
      if (target === undefined) expect(value).toBeUndefined(); else expect(Math.abs(value! - target)).toBeLessThanOrEqual(5.01e-11);
    };
    for (const field of ['height', 'rotation', 'width', 'oblique'] as const) number(row[field], wanted[field]);
    for (const field of ['position', 'first', 'second'] as const) {
      if (!wanted[field]) expect(row[field]).toBeUndefined();
      else { number(row[field]?.x, wanted[field]!.x); number(row[field]?.y, wanted[field]!.y); }
    }
  });
}

describe('native normalized SHX TEXT fixture without installed font dependencies', () => {
  it('retains native omitted defaults independently of nondefault STYLE creation fields', () => {
    const state = readDxf(fixture), rows = texts(state), styles = textStylesOf(state);
    expect(rows).toHaveLength(20);
    for (let font = 0; font < 4; font++) {
      const custom = rows[font * 5 + 1]!;
      expect(custom).toMatchObject({ text: 'Ag', widthFactor: 1, oblique: 0 });
      expect(styles[custom.style!]!).toMatchObject({ widthFactor: 0.8, oblique: 10 });
    }
  });
  it('preserves native spaces, controls, fitting and alignment anchors through repeated exports', () => {
    let state = readDxf(fixture);
    const before = texts(state).map(signature), initialStyles = textStylesOf(state);
    const fittedWidths = [5, 5.121951219512195, 5.384615384615385, 5.121951219512196];
    for (let font = 0; font < 4; font++) {
      const rows = texts(state), middle = rows[font * 5 + 2]!, fitted = rows[font * 5 + 3]!;
      expect(rows[font * 5]!.text).toBe('%%c10 %%d %%p'); expect(middle.text).toBe(' A '); expect(fitted.text).toBe('A ');
      expect(middle.justification).toEqual({ horizontal: 4, vertical: 0 }); expect(middle.position.y).toBe(434); expect(middle.firstAlignmentPoint!.y).toBe(429);
      expect(fitted.widthFactor).toBeCloseTo(fittedWidths[font]!, 12); expect(fitted.height).toBe(10);
      expect(fitted.alignmentPoint!.x - fitted.position.x).toBe(100);
    }
    for (let round = 0; round < 3; round++) {
      state = readDxf(writeDxf(state)); expectSavedRows(texts(state), before); expect(textStylesOf(state)).toEqual(initialStyles);
    }
  });
  it('edits and undoes every anchor while font identity survives a fresh save/reopen', () => {
    const doc = new Drawing(readDxf(fixture)), original = doc.entities[2] as TextEntity;
    doc.replaceEntities([translateEntity(original, { x: 3, y: 4 })]); expect(doc.dirty).toBe(true);
    expect((doc.entity(original.id) as TextEntity).firstAlignmentPoint).toEqual({ x: original.firstAlignmentPoint!.x + 3, y: 433 });
    doc.undo(); expect(signature(doc.entity(original.id) as TextEntity)).toEqual(signature(original)); doc.redo();
    const expected = texts(doc.snapshot).map(signature), saved = writeDxf(doc.snapshot), reopened = readDxf(saved);
    expectSavedRows(texts(reopened), expected); expect(textStylesOf(reopened)).toEqual(textStylesOf(doc.snapshot));
    expect(saved).not.toContain('resourceId'); expect(saved).not.toContain('FontFile'); expect(new Drawing(reopened).dirty).toBe(false);
  });
});
