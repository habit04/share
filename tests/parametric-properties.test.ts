/**
 * Priority 30.4 slice B — Properties palette Parameters section, tested
 * at the builder/setter split (tools/parametric-properties.ts), the same
 * level the 3D solids parameter rows are tested at
 * (tests/tools3d-properties-edit.test.ts): the palette itself is DOM-bound
 * and renders these rows verbatim. Authored normalized model; NOT native
 * AutoCAD evidence.
 */
import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { BlockDef, InsertEntity, LineEntity } from '../src/core/entities';
import type { DynamicBlockDefinition, LookupParameter } from '../src/core/parametric/definitions';
import { dynamicParameterRows, setDynamicParameterValue, type DynamicParameterHost } from '../src/tools/parametric-properties';

const line = (id: string): LineEntity => ({ id, layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });

const lookupParam = (over: Partial<LookupParameter> = {}): LookupParameter => ({
  kind: 'lookup', id: 'preset', name: 'Preset', basePoint: { x: 0, y: 7 },
  inputs: ['width'], defaultRow: null,
  rows: [
    { name: 'Wide', key: { width: { kind: 'distance', value: 18 } }, assignments: {} },
    { name: 'Narrow', key: { width: { kind: 'distance', value: 6 } }, assignments: { swing: { kind: 'angle', value: 0.5 } } },
  ],
  ...over,
});

const definition = (over: Partial<DynamicBlockDefinition> = {}): DynamicBlockDefinition => ({
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
      defaultValue: 0, constraint: { kind: 'unbounded' },
      grips: [{ role: 'value', movesWithValue: true }],
    },
    { kind: 'flip', id: 'handed', name: 'Handed', basePoint: { x: 0, y: 0 }, defaultValue: false },
    {
      kind: 'visibility', id: 'vis', name: 'Visibility', basePoint: { x: 0, y: 6 }, defaultState: 'Closed',
      states: [{ name: 'Open', visible: ['L1'] }, { name: 'Closed', visible: ['L2'] }],
    },
    lookupParam(),
  ],
  actions: [],
  ...over,
});

const block = (over: Partial<BlockDef> = {}): BlockDef => ({
  name: 'PROPS', basePoint: { x: 0, y: 0 }, entities: [line('L1'), line('L2')], attributes: [], dynamic: definition(), ...over,
});

const insert = (over: Partial<InsertEntity> = {}): InsertEntity => ({
  id: 'A', layer: '0', color: 'ByLayer', type: 'insert', block: 'PROPS',
  position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {},
  dynamic: { block: 'PROPS', values: {} },
  ...over,
});

describe('dynamicParameterRows', () => {
  it('one row per parameter with its effective (stored) value', () => {
    const ins = insert({
      dynamic: {
        block: 'PROPS',
        values: {
          width: { kind: 'distance', value: 14 },
          swing: { kind: 'angle', value: 0.25 },
          handed: { kind: 'flip', value: true },
          vis: { kind: 'visibility', value: 'Open' },
          preset: { kind: 'lookup', value: 'Wide' },
        },
      },
    });
    expect(dynamicParameterRows(block(), ins)).toEqual([
      { kind: 'distance', id: 'width', name: 'Width', value: 14 },
      { kind: 'angle', id: 'swing', name: 'Swing', value: 0.25 },
      { kind: 'flip', id: 'handed', name: 'Handed', value: true },
      { kind: 'visibility', id: 'vis', name: 'Visibility', value: 'Open', options: ['Open', 'Closed'] },
      { kind: 'lookup', id: 'preset', name: 'Preset', value: 'Wide', matchedOnly: false, options: ['Wide', 'Narrow'] },
    ]);
  });

  it('defaults fill in when nothing is stored', () => {
    const rows = dynamicParameterRows(block(), insert());
    expect(rows.map((r) => ('value' in r ? r.value : null))).toEqual([10, 0, false, 'Closed', null]);
    const lookup = rows.find((r) => r.kind === 'lookup');
    expect(lookup).toMatchObject({ value: null, matchedOnly: false }); // width 10 matches no row: Custom
  });

  it('lookup display: a stored choice wins; a default row applies; a value match is display-only; no match is Custom', () => {
    const matched = dynamicParameterRows(block(), insert({ dynamic: { block: 'PROPS', values: { width: { kind: 'distance', value: 18 } } } }))
      .find((r) => r.kind === 'lookup');
    expect(matched).toMatchObject({ value: 'Wide', matchedOnly: true });

    const withDefault = block({ dynamic: definition({ parameters: definition().parameters.map((p) => (p.kind === 'lookup' ? lookupParam({ defaultRow: 'Narrow' }) : p)) }) });
    const defaulted = dynamicParameterRows(withDefault, insert({ dynamic: { block: 'PROPS', values: { width: { kind: 'distance', value: 12 } } } }))
      .find((r) => r.kind === 'lookup');
    expect(defaulted).toMatchObject({ value: 'Narrow', matchedOnly: false });
  });

  it('retained payloads yield one explanatory note row; a static block yields none', () => {
    expect(dynamicParameterRows(block({ dynamicRetained: '{"version":2}' }), insert())).toEqual([
      { kind: 'note', id: '', name: 'Dynamic block', text: expect.stringContaining('retained as data') },
    ]);
    expect(dynamicParameterRows(block(), insert({ dynamic: undefined, dynamicRetained: '{"version":2}' }))).toEqual([
      { kind: 'note', id: '', name: 'Dynamic block', text: expect.stringContaining('retained as data') },
    ]);
    expect(dynamicParameterRows(block({ dynamic: undefined }), insert())).toEqual([]);
  });

  it('an opaque parameter is a note row, and invalid stored values add an explanatory note', () => {
    const withOpaque = block({
      dynamic: definition({ parameters: [...definition().parameters, { kind: 'opaque-parameter', id: 'future', name: 'Future', sourceKind: 'polar', payload: '{}' }] }),
    });
    const rows = dynamicParameterRows(withOpaque, insert());
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'note', id: 'future', text: expect.stringContaining('polar') });

    const invalid = dynamicParameterRows(block(), insert({ dynamic: { block: 'PROPS', values: { width: { kind: 'distance', value: 99 } } } }));
    expect(invalid[invalid.length - 1]).toMatchObject({ kind: 'note', name: 'Stored values', text: expect.stringContaining('value-out-of-range') });
    // Rows still render, from defaults, rather than crashing the palette.
    expect(invalid[0]).toMatchObject({ kind: 'distance', value: 10 });
  });
});

describe('setDynamicParameterValue — the palette setter', () => {
  const hostOf = (doc: Drawing): { host: DynamicParameterHost; logs: string[] } => {
    const logs: string[] = [];
    return { host: { doc, log: (t) => logs.push(t) }, logs };
  };
  const docOf = (ins: InsertEntity) => new Drawing({ entities: [ins], blocks: { PROPS: block() }, currentLayer: '0' });
  const stored = (doc: Drawing) => (doc.entities[0] as InsertEntity).dynamic?.values;

  it('an accepted edit is exactly one transact (one undo step)', () => {
    const doc = docOf(insert({ dynamic: { block: 'PROPS', values: { width: { kind: 'distance', value: 14 } } } }));
    const { host, logs } = hostOf(doc);
    expect(setDynamicParameterValue(host, 'A', 'width', 16)).toBe(true);
    expect(stored(doc)?.width).toEqual({ kind: 'distance', value: 16 });
    expect(logs).toEqual([]);
    expect(doc.undo()).toBe(true);
    expect(doc.canUndo()).toBe(false);
    expect(stored(doc)?.width).toEqual({ kind: 'distance', value: 14 });
  });

  it('a refused edit logs the code and changes nothing', () => {
    const doc = docOf(insert({ dynamic: { block: 'PROPS', values: { width: { kind: 'distance', value: 14 } } } }));
    const before = doc.snapshot;
    const { host, logs } = hostOf(doc);
    expect(setDynamicParameterValue(host, 'A', 'width', 25)).toBe(false);
    expect(logs.some((l) => l.includes('Parameter edit refused (value-out-of-range)'))).toBe(true);
    expect(doc.snapshot).toBe(before);
    expect(doc.canUndo()).toBe(false);
    expect(doc.dirty).toBe(false);
  });

  it('commits every kind through the shared path, including the §2.7 lookup-clearing rule', () => {
    const doc = docOf(insert());
    const { host } = hostOf(doc);
    expect(setDynamicParameterValue(host, 'A', 'preset', 'Wide')).toBe(true);
    expect(stored(doc)?.preset).toEqual({ kind: 'lookup', value: 'Wide' });
    expect(stored(doc)?.width).toBeUndefined(); // choosing a row stores only the choice; the row applies at evaluation
    // Directly editing a parameter the active row covers clears the stored choice.
    expect(setDynamicParameterValue(host, 'A', 'width', 12)).toBe(true);
    expect(stored(doc)?.preset).toEqual({ kind: 'lookup', value: null });
    expect(setDynamicParameterValue(host, 'A', 'handed', true)).toBe(true);
    expect(setDynamicParameterValue(host, 'A', 'vis', 'Open')).toBe(true);
    expect(setDynamicParameterValue(host, 'A', 'swing', 0.5)).toBe(true);
    expect(stored(doc)).toMatchObject({
      width: { kind: 'distance', value: 12 },
      handed: { kind: 'flip', value: true },
      vis: { kind: 'visibility', value: 'Open' },
      swing: { kind: 'angle', value: 0.5 },
    });
    // Choosing Custom (null) is a real commit too.
    expect(setDynamicParameterValue(host, 'A', 'preset', 'Narrow')).toBe(true);
    expect(setDynamicParameterValue(host, 'A', 'preset', null)).toBe(true);
    expect(stored(doc)?.preset).toEqual({ kind: 'lookup', value: null });
  });
});
