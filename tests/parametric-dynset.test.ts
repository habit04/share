/**
 * Priority 30.4 slice B — DYNSET generalized beyond the 30.1 distance-only
 * slice: angle (numeric, radians), flip (On/Off keyword), visibility
 * (state name, listed), lookup (row name, listed; Custom clears) — all
 * through generalized setDynamicParameter, one transact per accepted
 * edit, refusal logged with its code and no transact. The distance-only
 * contract stays covered by tests/parametric-dynamic-block.test.ts.
 * Authored normalized model; NOT native AutoCAD evidence.
 */
import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { BlockDef, InsertEntity, LineEntity } from '../src/core/entities';
import type { DynamicBlockDefinition } from '../src/core/parametric/definitions';
import { dynSetTool } from '../src/tools/parametric';
import { fakeContext, drive, type FakeContext } from './fake-context';

const line = (id: string): LineEntity => ({ id, layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });

const definition = (): DynamicBlockDefinition => ({
  version: 1,
  parameters: [
    {
      kind: 'linear-distance', id: 'width', name: 'Width',
      basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 },
      defaultValue: 10, constraint: { kind: 'range', min: 5, max: 20 },
      grips: [{ role: 'value', movesWithValue: true }],
    },
    {
      kind: 'angle', id: 'swing', name: 'Swing', basePoint: { x: 0, y: 0 },
      defaultValue: 0, constraint: { kind: 'range', min: -1, max: 1 },
      grips: [{ role: 'value', movesWithValue: true }],
    },
    { kind: 'flip', id: 'handed', name: 'Handed', basePoint: { x: 0, y: 0 }, defaultValue: false },
    {
      kind: 'visibility', id: 'vis', name: 'Visibility', basePoint: { x: 0, y: 6 }, defaultState: 'Closed',
      states: [{ name: 'Open', visible: ['L1', 'L2'] }, { name: 'Closed', visible: ['L1'] }],
    },
    {
      kind: 'lookup', id: 'preset', name: 'Preset', basePoint: { x: 0, y: 7 },
      inputs: ['width'], defaultRow: null,
      rows: [
        { name: 'Wide', key: { width: { kind: 'distance', value: 18 } }, assignments: {} },
        { name: 'Narrow', key: { width: { kind: 'distance', value: 6 } }, assignments: { swing: { kind: 'angle', value: 0.5 } } },
      ],
    },
  ],
  actions: [],
});

const dynBlock = (): BlockDef => ({
  name: 'DYNALL', basePoint: { x: 0, y: 0 }, entities: [line('L1'), line('L2')], attributes: [], dynamic: definition(),
});

const insert = (): InsertEntity => ({
  id: 'A', layer: '0', color: 'ByLayer', type: 'insert', block: 'DYNALL',
  position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {},
  dynamic: { block: 'DYNALL', values: {} },
});

const makeDoc = (): Drawing => new Drawing({ entities: [insert()], blocks: { DYNALL: dynBlock() }, currentLayer: '0' });
const stored = (doc: Drawing) => (doc.entities[0] as InsertEntity).dynamic?.values;

const run = (doc: Drawing, inputs: string[]): FakeContext => {
  const ctx = fakeContext(doc);
  ctx.selection = new Set(['A']);
  drive(dynSetTool(), ctx, inputs);
  return ctx;
};

describe('DYNSET generalized (30.4 slice B)', () => {
  it('angle: numeric edit in radians commits through one transact', () => {
    const doc = makeDoc();
    const ctx = run(doc, ['swing', '0.5']);
    expect(stored(doc)?.swing).toEqual({ kind: 'angle', value: 0.5 });
    expect(ctx.logs.some((l) => l.includes('Swing set to 0.5'))).toBe(true);
    expect(doc.undo()).toBe(true);
    expect(doc.canUndo()).toBe(false);
  });

  it('angle: an out-of-range value is refused with the code and does not transact', () => {
    const doc = makeDoc();
    const before = doc.snapshot;
    const ctx = run(doc, ['swing', '2']);
    expect(ctx.logs.some((l) => l.includes('DYNSET refused (value-out-of-range)'))).toBe(true);
    expect(doc.snapshot).toBe(before);
    expect(doc.canUndo()).toBe(false);
  });

  it('flip: the On/Off keyword toggles the boolean state', () => {
    const doc = makeDoc();
    const ctx = run(doc, ['handed', 'On']);
    expect(stored(doc)?.handed).toEqual({ kind: 'flip', value: true });
    expect(ctx.logs.some((l) => l.includes('Handed set to on'))).toBe(true);
    run(doc, ['handed', 'off']); // keyword matching is case-insensitive
    expect(stored(doc)?.handed).toEqual({ kind: 'flip', value: false });
  });

  it('visibility: states are listed and the named state commits', () => {
    const doc = makeDoc();
    const ctx = run(doc, ['vis', 'Open']);
    expect(stored(doc)?.vis).toEqual({ kind: 'visibility', value: 'Open' });
    expect(ctx.logs).toContain('  Open');
    expect(ctx.logs).toContain('  Closed');
    expect(ctx.logs.some((l) => l.includes('Visibility set to Open'))).toBe(true);
  });

  it('visibility: an unknown state is refused by name resolution, before any transact', () => {
    const doc = makeDoc();
    const before = doc.snapshot;
    const ctx = run(doc, ['vis', 'Sideways']);
    expect(ctx.logs.some((l) => l.includes('No visibility state "Sideways"'))).toBe(true);
    expect(doc.snapshot).toBe(before);
    expect(doc.canUndo()).toBe(false);
    // Canonical-name resolution: a differently-cased exact state still commits.
    run(doc, ['vis', 'open']);
    expect(stored(doc)?.vis).toEqual({ kind: 'visibility', value: 'Open' });
  });

  it('lookup: choosing a row stores the choice; editing a covered parameter clears it (§2.7)', () => {
    const doc = makeDoc();
    const ctx = run(doc, ['preset', 'Wide']);
    expect(stored(doc)?.preset).toEqual({ kind: 'lookup', value: 'Wide' });
    expect(ctx.logs).toContain('  Wide');
    expect(ctx.logs).toContain('  Custom (no row)');
    run(doc, ['width', '12']);
    expect(stored(doc)?.width).toEqual({ kind: 'distance', value: 12 });
    expect(stored(doc)?.preset).toEqual({ kind: 'lookup', value: null });
  });

  it('lookup: "Custom" clears a stored choice', () => {
    const doc = makeDoc();
    run(doc, ['preset', 'Narrow']);
    expect(stored(doc)?.preset).toEqual({ kind: 'lookup', value: 'Narrow' });
    const ctx = run(doc, ['preset', 'Custom']);
    expect(stored(doc)?.preset).toEqual({ kind: 'lookup', value: null });
    expect(ctx.logs.some((l) => l.includes('Preset set to Custom'))).toBe(true);
  });

  it('lookup: an unknown row is refused before any transact', () => {
    const doc = makeDoc();
    const before = doc.snapshot;
    const ctx = run(doc, ['preset', 'Huge']);
    expect(ctx.logs.some((l) => l.includes('No lookup row "Huge"'))).toBe(true);
    expect(doc.snapshot).toBe(before);
    expect(doc.canUndo()).toBe(false);
  });

  it('the parameter list shows every editable kind with its current value', () => {
    const doc = makeDoc();
    const ctx = run(doc, ['width', '12']);
    for (const line of ['width (Width) = 10', 'swing (Swing) = 0 rad', 'handed (Handed) = off', 'vis (Visibility) = Closed', 'preset (Preset) = Custom']) {
      expect(ctx.logs).toContain(line);
    }
  });
});
