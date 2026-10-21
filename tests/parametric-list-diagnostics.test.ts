/**
 * Priority 30 review §3 — dynamic LIST output + visible evaluation-refusal
 * diagnostics (authored normalized model; NOT native AutoCAD evidence).
 *
 * LIST (tools/inquiry.ts listEntity) appends a Dynamic section for dynamic
 * block references: parameter rows with the LOOKUP-RESOLVED effective
 * values (the R11 resolution geometry/grips/Properties share), the
 * visibility state, and the evaluation status — 'evaluated', or the refusal
 * code + message with the authored-geometry fallback stated, because
 * expansion itself presents that fallback silently. Ordinary inserts keep
 * byte-identical LIST output (pinned below).
 *
 * The diagnostics surface is core/entities.ts dynamicEvaluationNotices —
 * the queryable per-drawing report — wired into the editor's after-open
 * log via app/editor/documents.ts showImportReport (the import-report
 * surface; IMPORTREPORT routes through it too). A refusing reference is
 * named there with its code when the drawing opens; an evaluating one
 * produces no output.
 */
import { describe, it, expect } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import {
  dynamicEvaluationNotices,
  type BlockDef,
  type InsertEntity,
  type LineEntity,
} from '../src/core/entities';
import type { DynamicBlockDefinition } from '../src/core/parametric/definitions';
import { listEntity } from '../src/tools/inquiry';
import { showImportReport } from '../src/app/editor/documents';
import type { Editor } from '../src/app/editor/editor';

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});

const rect = (): LineEntity[] => [
  line('L1', 0, 0, 10, 0),
  line('L2', 10, 0, 10, 4),
  line('L3', 10, 4, 0, 4),
  line('L4', 0, 4, 0, 0),
];

const stretchAll = {
  kind: 'stretch', id: 'S1', name: 'Stretch', parameterId: 'width',
  frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 5 } },
  selection: ['L1', 'L2', 'L3', 'L4'].map((entityId) => ({ entityId, points: { kind: 'frame' as const } })),
} as const;

const widthParam = {
  kind: 'linear-distance', id: 'width', name: 'Width',
  basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 },
  defaultValue: 10, constraint: { kind: 'range', min: 5, max: 20 },
  grips: [{ role: 'base', movesWithValue: false }, { role: 'value', movesWithValue: true }],
} as const;

/** PANEL: width only (the 30.1 fixture shape). */
const panelDef = (): DynamicBlockDefinition => ({ version: 1, parameters: [widthParam], actions: [stretchAll] });
const panelBlock = (over: Partial<BlockDef> = {}): BlockDef => ({
  name: 'PANEL', basePoint: { x: 0, y: 0 }, entities: rect(), attributes: [], dynamic: panelDef(), ...over,
});

/** SHELF: width + visibility + a lookup whose rows set both. */
const shelfDef = (): DynamicBlockDefinition => ({
  version: 1,
  parameters: [
    widthParam,
    {
      kind: 'visibility', id: 'vis', name: 'Visibility', basePoint: { x: 0, y: 6 }, defaultState: 'Open',
      states: [
        { name: 'Open', visible: ['L1', 'L2', 'L3', 'L4'] },
        { name: 'Closed', visible: ['L1', 'L3', 'L4'] },
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
  actions: [stretchAll],
});
const shelfBlock = (): BlockDef => ({
  name: 'SHELF', basePoint: { x: 0, y: 0 }, entities: rect(), attributes: [], dynamic: shelfDef(),
});

const insert = (over: Partial<InsertEntity> = {}): InsertEntity => ({
  id: 'A', layer: '0', color: 'ByLayer', type: 'insert', block: 'PANEL',
  position: { x: 100, y: 100 }, rotation: 0, scale: 1, attributes: {},
  dynamic: { block: 'PANEL', values: { width: { kind: 'distance', value: 14 } } },
  ...over,
});

const docWith = (...blocks: BlockDef[]): Drawing => {
  const d = new Drawing();
  for (const b of blocks) d.defineBlock(b);
  return d;
};

const dynamicLines = (e: InsertEntity, d: Drawing): string[] => listEntity(e, d).filter((l) => l.includes('Dynamic') || l.includes('Parameter') || l.includes('Evaluation') || l.includes('Visibility') || l.includes('Lookup'));

describe('LIST dynamic section', () => {
  it('reports resolved values and evaluated status for an evaluating insert', () => {
    const d = docWith(panelBlock());
    const out = listEntity(insert(), d);
    expect(out.some((l) => l.includes('Dynamic block: "PANEL"'))).toBe(true);
    expect(out.some((l) => l.includes('width (Width) [linear-distance] = 14.0000'))).toBe(true);
    expect(out.some((l) => l.includes('Evaluation: evaluated'))).toBe(true);
    expect(out.some((l) => l.includes('REFUSED'))).toBe(false);
  });

  it('shows the lookup-resolved value, not the shadowed stored value (R11)', () => {
    const d = docWith(shelfBlock());
    // Stored width 12 is shadowed by the chosen row Wide (key width 18,
    // assignment vis=Closed): LIST must show geometry's values.
    const b = insert({
      id: 'B', block: 'SHELF',
      dynamic: {
        block: 'SHELF',
        values: {
          width: { kind: 'distance', value: 12 },
          preset: { kind: 'lookup', value: 'Wide' },
        },
      },
    });
    const out = listEntity(b, d);
    expect(out.some((l) => l.includes('width (Width) [linear-distance] = 18.0000') && l.includes('(from lookup row "Wide")'))).toBe(true);
    expect(out.some((l) => l.includes('width (Width) [linear-distance] = 12.0000'))).toBe(false);
    expect(out.some((l) => l.includes('preset (Preset) [lookup] = "Wide"'))).toBe(true);
    expect(out.some((l) => l.includes('Lookup row: "Wide"'))).toBe(true);
    expect(out.some((l) => l.includes('vis (Visibility) [visibility] = "Closed"') && l.includes('(from lookup row "Wide")'))).toBe(true);
    expect(out.some((l) => l.includes('Visibility: state "Closed" (parameter vis)'))).toBe(true);
    expect(out.some((l) => l.includes('Evaluation: evaluated'))).toBe(true);
  });

  it('names the default row when no choice is stored, and Custom when the row is cleared', () => {
    const d = docWith(shelfBlock());
    const a = insert({ id: 'A2', block: 'SHELF', dynamic: { block: 'SHELF', values: {} } });
    const outA = listEntity(a, d);
    expect(outA.some((l) => l.includes('width (Width) [linear-distance] = 8.0000') && l.includes('(from lookup row "Narrow")'))).toBe(true);
    expect(outA.some((l) => l.includes('Lookup row: "Narrow"'))).toBe(true);
    expect(outA.some((l) => l.includes('Visibility: state "Open" (parameter vis)'))).toBe(true);

    // A direct edit cleared the row choice (stored null): direct values rule.
    const c = insert({
      id: 'C', block: 'SHELF',
      dynamic: { block: 'SHELF', values: { preset: { kind: 'lookup', value: null }, width: { kind: 'distance', value: 12 } } },
    });
    const outC = listEntity(c, d);
    expect(outC.some((l) => l.includes('preset (Preset) [lookup] = Custom (no row)'))).toBe(true);
    expect(outC.some((l) => l.includes('width (Width) [linear-distance] = 12.0000') && !l.includes('from lookup row'))).toBe(true);
    expect(outC.some((l) => l.includes('Lookup row:'))).toBe(false);
  });

  it('shows the refusal code and the authored-geometry fallback for a refusing insert', () => {
    const d = docWith(panelBlock());
    const bad = insert({ id: 'BAD', dynamic: { block: 'PANEL', values: { width: { kind: 'distance', value: 25 } } } });
    const out = listEntity(bad, d);
    expect(out.some((l) => l.includes('Evaluation: REFUSED (invalid-instance):'))).toBe(true);
    expect(out.some((l) => l.includes('Displayed geometry is the authored geometry of block "PANEL"'))).toBe(true);
    expect(out.some((l) => l.includes('Evaluation: evaluated'))).toBe(false);
  });

  it('reports retained payloads as retained, never as evaluated', () => {
    const dRetained = docWith(panelBlock({ dynamic: undefined, dynamicRetained: '{"v":99,"kind":"dynamic"}' }));
    const outDef = listEntity(insert({ id: 'R1', dynamic: undefined }), dRetained);
    expect(outDef.some((l) => l.includes('Evaluation: REFUSED (definition-retained):'))).toBe(true);

    const dModeled = docWith(panelBlock());
    const outIns = listEntity(insert({ id: 'R2', dynamic: undefined, dynamicRetained: '{"v":99}' }), dModeled);
    expect(outIns.some((l) => l.includes('Evaluation: REFUSED (instance-retained):'))).toBe(true);
    expect(outIns.some((l) => l.includes('Evaluation: evaluated'))).toBe(false);
  });

  it('leaves LIST output for ordinary inserts byte-identical (no dynamic section)', () => {
    const plain: BlockDef = { name: 'PLAIN', basePoint: { x: 0, y: 0 }, entities: rect(), attributes: [] };
    const d = docWith(plain);
    const e = insert({ id: 'S', block: 'PLAIN', dynamic: undefined, attributes: { TAG1: 'X' } });
    const out = listEntity(e, d);
    expect(out.some((l) => l.includes('Dynamic'))).toBe(false);
    expect(dynamicLines(e, d)).toEqual([]);
    // The exact pre-dynamic line set: header (3) + block/point/scales/rotation
    // (5) + one ATTRIB + bounding box.
    expect(out).toHaveLength(10);
    expect(out[3]).toContain('Block name: "PLAIN"');
    expect(out.some((l) => l.includes('ATTRIB  TAG1 = "X"'))).toBe(true);
  });
});

describe('dynamicEvaluationNotices (per-drawing diagnostic)', () => {
  it('lists refusing references with their codes; evaluating and static references are absent', () => {
    const blocks: Record<string, BlockDef> = {
      PANEL: panelBlock(),
      SHELF: shelfBlock(),
      PLAIN: { name: 'PLAIN', basePoint: { x: 0, y: 0 }, entities: rect(), attributes: [] },
    };
    const entities: InsertEntity[] = [
      insert(), // evaluates (width 14)
      insert({ id: 'BAD', dynamic: { block: 'PANEL', values: { width: { kind: 'distance', value: 25 } } } }),
      insert({ id: 'S', block: 'PLAIN', dynamic: undefined }),
      insert({ id: 'R2', dynamic: undefined, dynamicRetained: '{"v":99}' }),
    ];
    const notices = dynamicEvaluationNotices(blocks, entities);
    expect(notices.map((n) => [n.insertId, n.code])).toEqual([
      ['BAD', 'invalid-instance'],
      ['R2', 'instance-retained'],
    ]);
    expect(notices[0]!.message).toContain('width');
    expect(notices.every((n) => n.block === 'PANEL')).toBe(true);
  });

  it('is empty for a drawing whose dynamic references all evaluate', () => {
    const blocks: Record<string, BlockDef> = { PANEL: panelBlock(), SHELF: shelfBlock() };
    expect(dynamicEvaluationNotices(blocks, [insert(), insert({ id: 'B', block: 'SHELF', dynamic: { block: 'SHELF', values: {} } })])).toEqual([]);
    expect(dynamicEvaluationNotices(blocks, [])).toEqual([]);
  });
});

describe('editor open-time wiring (showImportReport)', () => {
  const stateWith = (entities: InsertEntity[], blocks: Record<string, BlockDef>): DrawingState => ({
    entities, layers: [], blocks, currentLayer: '0',
  });
  const stubEditor = (lines: string[]): Editor =>
    ({ log: (l: string) => lines.push(l), hooks: {} }) as unknown as Editor;

  it('logs the refusing reference with its code when the drawing is shown after open', () => {
    const lines: string[] = [];
    const state = stateWith(
      [insert({ id: 'BAD', dynamic: { block: 'PANEL', values: { width: { kind: 'distance', value: 25 } } } })],
      { PANEL: panelBlock() },
    );
    showImportReport(stubEditor(lines), false, state, 'test.dxf');
    expect(lines.some((l) => l.includes('could not be evaluated'))).toBe(true);
    expect(lines.some((l) => l.includes('"PANEL" (handle BAD): REFUSED (invalid-instance):'))).toBe(true);
  });

  it('logs nothing for a drawing whose dynamic references evaluate', () => {
    const lines: string[] = [];
    showImportReport(stubEditor(lines), false, stateWith([insert()], { PANEL: panelBlock() }), 'test.dxf');
    expect(lines).toEqual([]);
  });
});
