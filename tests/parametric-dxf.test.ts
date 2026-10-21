import { describe, it, expect } from 'vitest';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';
import { explodeInsert, type Entity, type InsertEntity, type LineEntity } from '../src/core/entities';
import type { DrawingState } from '../src/core/document';
import type { DynamicBlockDefinition, LinearDistanceParameter, StretchAction } from '../src/core/parametric/definitions';
import type { DynamicInstanceState } from '../src/core/parametric/instance';
import { evaluateDynamicBlock } from '../src/core/parametric/evaluate';
import { decodeDynamicDefinition, decodeDynamicInstance, encodeDynamicDefinition, encodeDynamicInstance } from '../src/io/dxf/dynamic-data';

// Priority 30.1 — the JCAD_DYNAMIC DXF carrier (definition on BLOCK, values on INSERT).
// The "door block" fixture mirrors tests/parametric-evaluate.test.ts (design §5).

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});

const doorEntities = (): LineEntity[] => [
  line('L1', 0, 0, 10, 0),
  line('L2', 10, 0, 10, 5),
  line('L3', 10, 5, 0, 5),
  line('L4', 0, 5, 0, 0),
];

const widthParam = (): LinearDistanceParameter => ({
  kind: 'linear-distance',
  id: 'width',
  name: 'Width',
  basePoint: { x: 0, y: 0 },
  direction: { x: 1, y: 0 },
  defaultValue: 10,
  constraint: { kind: 'range', min: 5, max: 20 },
  grips: [
    { role: 'base', movesWithValue: false },
    { role: 'value', movesWithValue: true },
  ],
});

const stretch = (): StretchAction => ({
  kind: 'stretch',
  id: 'S1',
  name: 'Stretch',
  parameterId: 'width',
  frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 6 } },
  selection: [
    { entityId: 'L2', points: { kind: 'frame' } },
    { entityId: 'L1', points: { kind: 'frame' } },
    { entityId: 'L3', points: { kind: 'frame' } },
    { entityId: 'TAG', points: { kind: 'frame' } },
  ],
});

const doorDefinition = (): DynamicBlockDefinition => ({ version: 1, parameters: [widthParam()], actions: [stretch()] });

const insert = (id: string, x: number, width: number, tag: string): InsertEntity => ({
  id,
  layer: '0',
  color: 'ByLayer',
  type: 'insert',
  block: 'DOOR',
  position: { x, y: 0 },
  rotation: 0,
  scale: 1,
  attributes: { TAG: tag },
  dynamic: { block: 'DOOR', values: { width: { kind: 'distance', value: width } } },
});

const doorState = (): DrawingState => ({
  entities: [insert('i1', 0, 14, 'A1'), insert('i2', 30, 7, 'A2')],
  layers: [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }],
  blocks: {
    DOOR: {
      name: 'DOOR',
      basePoint: { x: 0, y: 0 },
      entities: doorEntities(),
      attributes: [{ tag: 'TAG', prompt: 'Tag', default: 'D1', position: { x: 1, y: 1 }, height: 2, align: 'left' }],
      dynamic: doorDefinition(),
    },
  },
  currentLayer: '0',
});

/** Selection references of a definition, normalized to block-entity ordinals / attribute
 *  tags — the identity that survives a DXF round-trip (EntityBase.id does not). */
const normalizedSelections = (state: DrawingState, def: DynamicBlockDefinition): unknown =>
  def.actions.map((a) => (a.kind === 'stretch'
    ? {
        ...a,
        selection: a.selection.map((sel) => {
          const index = state.blocks['DOOR']!.entities.findIndex((e) => e.id === sel.entityId);
          return { entityId: index >= 0 ? `#${index}` : sel.entityId, points: sel.points };
        }),
      }
    : a));

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe('JCAD_DYNAMIC DXF carrier (30.1)', () => {
  it('(a) round-trips a definition and two instance value sets; evaluation differs per instance after reopen', () => {
    const state = doorState();
    const text = writeDxf(state);
    expect(occurrences(text, 'JCAD_DYNAMIC')).toBe(4); // APPID + BLOCK payload + 2 INSERT payloads

    const reopened = readDxf(text);
    const block = reopened.blocks['DOOR']!;
    expect(block.dynamicRetained).toBeUndefined();
    const def = block.dynamic!;
    expect(def).toBeDefined();
    expect(def.parameters).toEqual(doorDefinition().parameters);
    expect(normalizedSelections(reopened, def)).toEqual(normalizedSelections(state, doorDefinition()));

    const inserts = reopened.entities.filter((e): e is InsertEntity => e.type === 'insert');
    expect(inserts).toHaveLength(2);
    expect(inserts.map((i) => i.dynamic)).toEqual([
      { block: 'DOOR', values: { width: { kind: 'distance', value: 14 } } },
      { block: 'DOOR', values: { width: { kind: 'distance', value: 7 } } },
    ]);
    expect(inserts.map((i) => i.attributes)).toEqual([{ TAG: 'A1' }, { TAG: 'A2' }]);

    // Evaluated expansion (core evaluator over the reopened model) differs per instance:
    // the right-hand lines sit at the instance width in definition space.
    const lookup = (n: string) => reopened.blocks[n];
    const evaluated = inserts.map((ins) => evaluateDynamicBlock(def, block.entities, block.attributes, ins.dynamic));
    for (const result of evaluated) expect(result.ok).toBe(true);
    const rightEdge = (r: typeof evaluated[number]): number => {
      if (!r.ok) throw new Error('evaluation refused');
      return Math.max(...r.entities.map((e) => Math.max(...[e as LineEntity].flatMap((l) => [l.a.x, l.b.x]))));
    };
    expect(rightEdge(evaluated[0]!)).toBe(14);
    expect(rightEdge(evaluated[1]!)).toBe(7);
    // The static expansion source (explodeInsert) still expands the reopened inserts.
    for (const ins of inserts) expect(explodeInsert(ins, lookup).length).toBeGreaterThan(0);

    // Second round-trip through the cad-graph-carrying reopened state: the quiet-listed
    // app must be neither duplicated nor dropped by cad-graph post-processing.
    const text2 = writeDxf(reopened);
    expect(occurrences(text2, 'JCAD_DYNAMIC')).toBe(4);
    const reopened2 = readDxf(text2);
    expect(reopened2.blocks['DOOR']!.dynamic).toBeDefined();
    expect(reopened2.entities.filter((e): e is InsertEntity => e.type === 'insert').map((i) => i.dynamic)).toEqual(inserts.map((i) => i.dynamic));
  });

  it('(b) a fully static drawing writes no JCAD_DYNAMIC and no extra APPID', () => {
    const state: DrawingState = {
      entities: [line('s1', 0, 0, 5, 5), { id: 's2', layer: '0', color: 'ByLayer', type: 'insert', block: 'PLAIN', position: { x: 1, y: 1 }, rotation: 0, scale: 1, attributes: {} }],
      layers: [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }],
      blocks: {
        PLAIN: { name: 'PLAIN', basePoint: { x: 0, y: 0 }, entities: [line('p1', 0, 0, 2, 0)], attributes: [] },
      },
      currentLayer: '0',
    };
    const text = writeDxf(state);
    expect(text).not.toContain('JCAD_DYNAMIC');
    // Static output is a fixed point: writing the reopened static drawing is identical.
    expect(writeDxf(readDxf(text))).toBe(text);
  });

  it('(d) an opaque action/parameter definition round-trips with byte-identical payloads', () => {
    const opaquePayload = '{"rows":[[1,2],"üñï ⇧"]}';
    const definition: DynamicBlockDefinition = {
      version: 1,
      parameters: [
        widthParam(),
        { kind: 'opaque-parameter', id: 'mode', name: 'Mode', sourceKind: 'lookup', payload: opaquePayload },
      ],
      actions: [
        stretch(),
        { kind: 'opaque-action', id: 'A9', name: 'Lookup', parameterId: 'mode', sourceKind: 'lookup-table', payload: 'verbatim ⇧ payload' },
      ],
    };
    const state: DrawingState = {
      entities: [],
      layers: [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }],
      blocks: {
        DOOR: {
          name: 'DOOR',
          basePoint: { x: 0, y: 0 },
          entities: doorEntities(),
          attributes: [{ tag: 'TAG', prompt: 'Tag', default: 'D1', position: { x: 1, y: 1 }, height: 2, align: 'left' }],
          dynamic: definition,
        },
      },
      currentLayer: '0',
    };
    const reopened = readDxf(writeDxf(state));
    const def2 = reopened.blocks['DOOR']!.dynamic!;
    expect(def2).toBeDefined();
    expect(def2.parameters[1]).toEqual({ kind: 'opaque-parameter', id: 'mode', name: 'Mode', sourceKind: 'lookup', payload: opaquePayload });
    expect(def2.actions[1]).toEqual({ kind: 'opaque-action', id: 'A9', name: 'Lookup', parameterId: 'mode', sourceKind: 'lookup-table', payload: 'verbatim ⇧ payload' });
    // Canonical encoding is byte-identical before and after the round-trip.
    const entityIds = (s: DrawingState): string[] => s.blocks['DOOR']!.entities.map((e) => e.id);
    expect(encodeDynamicDefinition(def2, entityIds(reopened))).toBe(encodeDynamicDefinition(definition, entityIds(state)));
  });
});

// --- (c) malformed / newer-version payloads, hand-written DXF ----------------

const handDxf = (definitionPayload: string, instancePayload: string): string => [
  0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1015', 0, 'ENDSEC',
  0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, 1,
  0, 'LAYER', 100, 'AcDbSymbolTableRecord', 100, 'AcDbLayerTableRecord', 2, '0', 70, 0, 62, 7, 6, 'CONTINUOUS',
  0, 'ENDTAB', 0, 'ENDSEC',
  0, 'SECTION', 2, 'BLOCKS',
  0, 'BLOCK', 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockBegin', 2, 'DOOR', 70, 0, 10, 0, 20, 0,
  1001, 'JCAD_DYNAMIC', 1000, definitionPayload,
  0, 'LINE', 100, 'AcDbEntity', 8, '0', 100, 'AcDbLine', 10, 0, 20, 0, 11, 10, 21, 0,
  0, 'ENDBLK', 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockEnd',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'INSERT', 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockReference', 2, 'DOOR', 10, 3, 20, 4,
  1001, 'JCAD_DYNAMIC', 1000, instancePayload,
  0, 'ENDSEC', 0, 'EOF',
].join('\n');

describe('JCAD_DYNAMIC malformed payloads (30.1)', () => {
  it('(c) broken definition JSON and a version-99 instance payload are retained, reported, and re-emitted verbatim', () => {
    const broken = '{broken json';
    const future = '{"v":99,"kind":"instance","block":"DOOR","values":{}}';
    const state = readDxf(handDxf(broken, future));
    const block = state.blocks['DOOR']!;
    expect(block.dynamic).toBeUndefined();
    expect(block.dynamicRetained).toBe(broken);
    const inserts = state.entities.filter((e): e is InsertEntity => e.type === 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.dynamic).toBeUndefined();
    expect(inserts[0]!.dynamicRetained).toBe(future);
    // The block displays static: the insert expands to the authored line.
    const lookup = (n: string) => state.blocks[n];
    expect(explodeInsert(inserts[0]!, lookup).some((e: Entity) => e.type === 'line')).toBe(true);
    // Import report carries the simplified entries for both carriers.
    const items = importReportOf(state)?.items ?? [];
    expect(items.some((i) => i.action === 'simplified' && i.type === 'BLOCK' && i.reason.includes('JCAD_DYNAMIC'))).toBe(true);
    expect(items.some((i) => i.action === 'simplified' && i.type === 'INSERT' && i.reason.includes('JCAD_DYNAMIC'))).toBe(true);
    // Re-export re-emits both raw payloads verbatim.
    const out = writeDxf(state);
    expect(out).toContain(broken);
    expect(out).toContain(future);
    // And they are retained again on the next read (fixed point).
    const again = readDxf(out);
    expect(again.blocks['DOOR']!.dynamicRetained).toBe(broken);
    expect(again.entities.filter((e): e is InsertEntity => e.type === 'insert')[0]!.dynamicRetained).toBe(future);
  });

  it('(c) a version-99 definition payload is retained, not modeled', () => {
    const futureDef = '{"v":99,"kind":"definition","parameters":[],"actions":[]}';
    const state = readDxf(handDxf(futureDef, '{"v":1,"kind":"instance","block":"DOOR","values":{}}'));
    expect(state.blocks['DOOR']!.dynamic).toBeUndefined();
    expect(state.blocks['DOOR']!.dynamicRetained).toBe(futureDef);
    // Instance values without a modeled definition are retained too, never modeled.
    const ins = state.entities.filter((e): e is InsertEntity => e.type === 'insert')[0]!;
    expect(ins.dynamic).toBeUndefined();
    expect(ins.dynamicRetained).toContain('"kind":"instance"');
  });
});

describe('dynamic-data encode/decode (30.1)', () => {
  it('round-trips the canonical shapes and refuses newer versions', () => {
    const def = doorDefinition();
    const entityIds = ['L1', 'L2', 'L3', 'L4'];
    const encoded = encodeDynamicDefinition(def, entityIds);
    // Entity selections serialize by ordinal: L2 is entity index 1.
    expect(JSON.parse(encoded).actions[0].selection[0].entityId).toBe('#1');
    const decoded = decodeDynamicDefinition(encoded, { entityIdsInOrder: entityIds, attributeTags: new Set(['TAG']) });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.definition).toEqual(def);

    const instance: DynamicInstanceState = { block: 'DOOR', values: { width: { kind: 'distance', value: 12 } } };
    const decodedInstance = decodeDynamicInstance(encodeDynamicInstance(instance), def, 'DOOR');
    expect(decodedInstance.ok).toBe(true);
    if (decodedInstance.ok) expect(decodedInstance.state).toEqual(instance);

    expect(decodeDynamicDefinition('{"v":99,"kind":"definition","parameters":[],"actions":[]}').ok).toBe(false);
    expect(decodeDynamicDefinition('{nope').ok).toBe(false);
    // A value violating the parameter constraint is refused to retained, never clamped.
    const bad: DynamicInstanceState = { block: 'DOOR', values: { width: { kind: 'distance', value: 25 } } };
    expect(decodeDynamicInstance(encodeDynamicInstance(bad), def, 'DOOR').ok).toBe(false);
  });
});
