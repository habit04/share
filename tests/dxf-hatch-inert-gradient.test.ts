import { describe, expect, it } from 'vitest';
import type { HatchEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';

type Pair = readonly [number, string | number];
// AutoCAD's ordinary HATCH tail, authored independently from JCad's writer.
const placeholder = (mode: number): Pair[] => [[450, 0], [451, 0], [460, 0], [461, 0], [452, mode], [462, 0], [453, 0], [470, '']];
const replace = (pairs: Pair[], code: number, value: string | number): Pair[] => pairs.map((pair) => pair[0] === code ? [code, value] : pair);
function hatch(tail: Pair[], pattern = false, handle = 'A1'): Pair[] {
  return [[0, 'HATCH'], [5, handle], [100, 'AcDbEntity'], [8, 'FILL'], [100, 'AcDbHatch'],
    [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1], [2, pattern ? 'ANSI31' : 'SOLID'], [70, pattern ? 0 : 1], [71, 0], [91, 2],
    [92, 3], [72, 0], [73, 1], [93, 4], [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 10], [10, 0], [20, 10], [97, 0],
    [92, 2], [72, 0], [73, 1], [93, 4], [10, 2], [20, 2], [10, 4], [20, 2], [10, 4], [20, 4], [10, 2], [20, 4], [97, 0], [75, 0], [76, 1],
    ...(pattern ? [[52, 30], [41, 2], [77, 0], [78, 0]] as Pair[] : []), [98, 0], ...tail];
}
function file(records: Pair[], blocks: Pair[] = []): string {
  return ([[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1032'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'BLOCKS'], ...blocks, [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], ...records, [0, 'ENDSEC'], [0, 'EOF']] as Pair[]).flat().join('\n');
}

describe('ordinary AutoCAD hatches with empty gradient descriptors', () => {
  for (const mode of [0, 1]) for (const pattern of [false, true]) {
    it(`opens and saves ${pattern ? 'patterned' : 'solid'} hatches with color mode ${mode} and their holes`, () => {
      const state = readDxf(file(hatch(placeholder(mode), pattern)));
      expect(state.entities).toHaveLength(1);
      const source = state.entities[0] as HatchEntity;
      expect(source).toMatchObject({ type: 'hatch', solid: !pattern, pattern: pattern ? 'ANSI31' : 'SOLID' });
      expect(source.gradient).toBeUndefined();
      expect(source.loops).toHaveLength(2);
      expect(importReportOf(state)?.items.filter((item) => item.type === 'HATCH') ?? []).toEqual([]);
      const saved = writeDxf(state);
      const reopened = readDxf(saved).entities[0] as HatchEntity;
      expect(reopened).toMatchObject({ type: 'hatch', solid: source.solid, pattern: source.pattern, loops: source.loops });
      expect(reopened.gradient).toBeUndefined();
      expect(saved).not.toMatch(/\r\n450\r\n/);
    });
  }

  it('recovers block hatches as well as top-level entities without suppressing unrelated import losses', () => {
    const block: Pair[] = [[0, 'BLOCK'], [2, 'SYMBOL'], [8, '0'], [70, 0], [10, 0], [20, 0], [30, 0],
      ...hatch(placeholder(1), false, 'B1'), [0, 'ENDBLK']];
    const state = readDxf(file([...hatch(placeholder(0)), [0, 'UNSUPPORTED_TEST_ENTITY'], [5, 'C1'], [8, '0']], block));
    expect(state.entities.filter((e) => e.type === 'hatch')).toHaveLength(1);
    expect(state.blocks.SYMBOL?.entities.filter((e) => e.type === 'hatch')).toHaveLength(1);
    expect(importReportOf(state)?.counts.HATCH).toBeUndefined();
    expect(importReportOf(state)?.items).toContainEqual(expect.objectContaining({ type: 'UNSUPPORTED_TEST_ENTITY', handle: 'C1' }));
  });

  it('preserves meaningful inactive gradient settings instead of treating every kind-zero descriptor as empty', () => {
    const tail: Pair[] = [[450, 0], [451, 0], [460, 0.25], [461, 0], [452, 1], [462, 0.7], [453, 2], [463, 0], [63, 5], [421, 255], [463, 1], [63, 7], [421, 0xffffff], [470, 'LINEAR']];
    const state = readDxf(file(hatch(tail)));
    const source = state.entities[0] as HatchEntity;
    expect(source.gradient).toMatchObject({ kind: 0, name: 'LINEAR', angle: 0.25, tint: 0.7, colors: [{ position: 0, color: 5, trueColor: 255 }, { position: 1, color: 7, trueColor: 0xffffff }] });
    expect((readDxf(writeDxf(state)).entities[0] as HatchEntity).gradient).toEqual(source.gradient);
  });

  it('keeps source-context errors for active blank gradients, nondefault blank descriptors and malformed tails', () => {
    const bad = [replace(placeholder(1), 450, 1), replace(placeholder(1), 451, 2), replace(placeholder(1), 460, 0.5),
      replace(placeholder(1), 462, 0.3), replace(placeholder(1), 452, 3), replace(placeholder(1), 453, 2),
      [...placeholder(1), [463, 0], [63, 1]] as Pair[], [...placeholder(1), [450, 0]] as Pair[],
      placeholder(1).filter(([code]) => code !== 451)];
    for (const tail of bad) {
      const state = readDxf(file(hatch(tail)));
      expect(state.entities, JSON.stringify(tail)).toEqual([]);
      expect(importReportOf(state)?.items).toContainEqual(expect.objectContaining({ type: 'HATCH', action: 'dropped', handle: 'A1', layer: 'FILL', where: 'model space', reason: expect.stringMatching(/invalid hatch data:.*gradient/) }));
    }
  });
});
