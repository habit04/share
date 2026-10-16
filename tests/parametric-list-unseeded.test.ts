/**
 * Priority 30 review round 2 (C07) — LIST honesty for UNSEEDED dynamic
 * references (authored normalized model; NOT native AutoCAD evidence).
 *
 * A reference with no stored instance state takes the documented
 * authored/unseeded expansion path: the viewport shows the authored
 * geometry and the definition defaults — including the default visibility
 * state — are not applied. LIST previously resolved those same defaults
 * and claimed 'Visibility: state …' + 'Evaluation: evaluated', asserting a
 * geometry state the viewport does not use. These tests pin the honest
 * presentation (defaults marked as defaults, evaluation reported as
 * unseeded/authored) and pin that seeded references — including a
 * seeded-but-empty value map — keep the exact evaluated presentation.
 */
import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import { explodeInsert, type BlockDef, type InsertEntity, type LineEntity } from '../src/core/entities';
import type { DynamicBlockDefinition } from '../src/core/parametric/definitions';
import { dynamicListLines, listEntity } from '../src/tools/inquiry';

const line = (id: string): LineEntity => ({ id, layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });

const widthParam = {
  kind: 'linear-distance', id: 'width', name: 'Width',
  basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 },
  defaultValue: 10, constraint: { kind: 'range', min: 5, max: 20 },
  grips: [{ role: 'value', movesWithValue: true }],
} as const;

/** Block whose default visibility state hides its only entity. */
const hiddenDefaultBlock = (): BlockDef => ({
  name: 'CHILD', basePoint: { x: 0, y: 0 }, entities: [line('line')], attributes: [],
  dynamic: {
    version: 1,
    parameters: [{
      kind: 'visibility', id: 'vis', name: 'Visibility', basePoint: { x: 0, y: 0 }, defaultState: 'Hidden',
      states: [{ name: 'Hidden', visible: [] }],
    }],
    actions: [],
  },
});

/** width + visibility + lookup (default row Narrow) — the SHELF shape. */
const shelfBlock = (): BlockDef => ({
  name: 'SHELF', basePoint: { x: 0, y: 0 }, entities: [line('L1'), line('L2')], attributes: [],
  dynamic: {
    version: 1,
    parameters: [
      widthParam,
      {
        kind: 'visibility', id: 'vis', name: 'Visibility', basePoint: { x: 0, y: 6 }, defaultState: 'Open',
        states: [
          { name: 'Open', visible: ['L1', 'L2'] },
          { name: 'Closed', visible: ['L1'] },
        ],
      },
      {
        kind: 'lookup', id: 'preset', name: 'Preset', basePoint: { x: 0, y: 7 },
        inputs: ['width'], defaultRow: 'Narrow',
        rows: [
          { name: 'Narrow', key: { width: { kind: 'distance', value: 8 } }, assignments: {} },
          { name: 'Wide', key: { width: { kind: 'distance', value: 18 } }, assignments: { vis: { kind: 'visibility', value: 'Closed' } } },
        ],
      },
    ],
    actions: [],
  } satisfies DynamicBlockDefinition,
});

const unseeded = (block: string): InsertEntity => ({
  id: 'U', layer: '0', color: 'ByLayer', type: 'insert', block,
  position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {},
});

const docWith = (...blocks: BlockDef[]): Drawing => {
  const d = new Drawing();
  for (const b of blocks) d.defineBlock(b);
  return d;
};

describe('LIST on unseeded dynamic references (C07)', () => {
  it('does not claim evaluation while expansion shows authored geometry the default state would hide', () => {
    const b = hiddenDefaultBlock();
    const doc = docWith(b);
    const ins = unseeded('CHILD');
    // The authored/unseeded path: the line IS displayed even though the
    // definition's default visibility state hides everything.
    expect(explodeInsert(ins, doc.lookupBlock).some((e) => e.type === 'line')).toBe(true);
    const out = dynamicListLines(ins, doc);
    expect(out.some((l) => /Evaluation:\s+evaluated$/.test(l))).toBe(false);
    expect(out.some((l) => l.includes('Evaluation: unseeded') && l.includes('authored geometry'))).toBe(true);
    expect(out.some((l) => l.includes('Visibility: default state "Hidden"') && l.includes('not applied'))).toBe(true);
    expect(out.some((l) => l.includes('Visibility: state "Hidden"'))).toBe(false);
    expect(out.some((l) => l.includes('[visibility] = "Hidden"  (definition default)'))).toBe(true);
  });

  it('marks every resolved row as a definition default and reports no applied lookup row', () => {
    const doc = docWith(shelfBlock());
    const out = dynamicListLines(unseeded('SHELF'), doc);
    const rows = out.filter((l) => l.includes('Parameter '));
    expect(rows.length).toBe(3);
    expect(rows.every((l) => l.includes('(definition default)'))).toBe(true);
    expect(out.some((l) => l.includes('Lookup row:'))).toBe(false);
    expect(out.some((l) => l.includes('(from lookup row'))).toBe(false);
    expect(out.some((l) => l.includes('Evaluation: unseeded'))).toBe(true);
  });

  it('a seeded-but-empty value map keeps the evaluated presentation', () => {
    const doc = docWith(shelfBlock());
    const seeded: InsertEntity = { ...unseeded('SHELF'), dynamic: { block: 'SHELF', values: {} } };
    const out = dynamicListLines(seeded, doc);
    expect(out.some((l) => /Evaluation:\s+evaluated$/.test(l))).toBe(true);
    expect(out.some((l) => l.includes('Visibility: state "Open"'))).toBe(true);
    expect(out.some((l) => l.includes('(definition default)'))).toBe(false);
    expect(out.some((l) => l.includes('Lookup row: "Narrow"'))).toBe(true);
  });

  it('a retained definition still reports REFUSED, never unseeded or evaluated', () => {
    const b = { ...shelfBlock(), dynamic: undefined, dynamicRetained: '{"v":99,"kind":"dynamic"}' };
    const doc = docWith(b);
    const out = dynamicListLines(unseeded('SHELF'), doc);
    expect(out.some((l) => l.includes('Evaluation: REFUSED (definition-retained):'))).toBe(true);
    expect(out.some((l) => l.includes('unseeded'))).toBe(false);
    expect(out.some((l) => /Evaluation:\s+evaluated$/.test(l))).toBe(false);
  });

  it('an ordinary static insert still has no Dynamic section at all', () => {
    const plain: BlockDef = { name: 'PLAIN', basePoint: { x: 0, y: 0 }, entities: [line('L1')], attributes: [] };
    const doc = docWith(plain);
    expect(dynamicListLines(unseeded('PLAIN'), doc)).toEqual([]);
    expect(listEntity(unseeded('PLAIN'), doc).some((l) => l.includes('Dynamic block'))).toBe(false);
  });
});
