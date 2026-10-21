/**
 * Priority 30.2e — the alignment definition field (design
 * design-visibility-lookup-array.md §4 + §8 cases AL1–AL3).
 *
 * Alignment is placement-time data, categorically not an evaluation
 * feature (§4.1): it has no action, no instance value, and passes the
 * inert-member test — for every instance value set it cannot change the
 * evaluated entities, the evaluated attribute definitions, or any other
 * member's behavior. It is therefore modeled as an optional FIELD on the
 * definition (not a parameter), consumed by the 30.4 insert tool; the
 * evaluator does not read it. These tests pin the indifference (AL1),
 * the validation clause (AL2), and the serialization shape with its
 * documented downgrade (AL3 + §6.1/§6.2: an older build ignores the
 * top-level key on decode and drops it on re-save).
 * Authored normalized model; NOT native AutoCAD evidence.
 */
import { describe, it, expect } from 'vitest';
import type { AttributeDef, Entity, LineEntity } from '../src/core/entities';
import {
  validateDefinition,
  type AlignmentSpec,
  type DynamicBlockDefinition,
  type LinearDistanceParameter,
  type StretchAction,
} from '../src/core/parametric/definitions';
import type { DynamicInstanceState } from '../src/core/parametric/instance';
import { evaluateDynamicBlock } from '../src/core/parametric/evaluate';
import {
  decodeDynamicDefinition,
  encodeDynamicDefinition,
} from '../src/io/dxf/dynamic-data';

// --- The door fixture (30.1 design §5), with an alignment variant -------------
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});

const doorEntities = (): Entity[] => [
  line('L1', 0, 0, 10, 0),
  line('L2', 10, 0, 10, 5),
  line('L3', 10, 5, 0, 5),
  line('L4', 0, 5, 0, 0),
];
const doorAttributes = (): AttributeDef[] => [
  { tag: 'TAG', prompt: 'Tag', default: 'D1', position: { x: 1, y: 1 }, height: 2, align: 'left' },
];
const DOOR_IDS = ['L1', 'L2', 'L3', 'L4'];
const DOOR_ID_SET = new Set([...DOOR_IDS, 'TAG']);

const widthParam = (): LinearDistanceParameter => ({
  kind: 'linear-distance', id: 'width', name: 'Width',
  basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 },
  defaultValue: 10, constraint: { kind: 'range', min: 5, max: 20 },
  grips: [
    { role: 'base', movesWithValue: false },
    { role: 'value', movesWithValue: true },
  ],
});
const doorStretch = (): StretchAction => ({
  kind: 'stretch', id: 'S1', name: 'Stretch', parameterId: 'width',
  frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 6 } },
  selection: [
    { entityId: 'L2', points: { kind: 'frame' } },
    { entityId: 'L1', points: { kind: 'frame' } },
    { entityId: 'L3', points: { kind: 'frame' } },
  ],
});

const alignmentSpec = (over: Partial<AlignmentSpec> = {}): AlignmentSpec => ({
  basePoint: { x: 0, y: 0 },
  direction: { x: 0, y: 1 },
  mode: 'perpendicular',
  ...over,
});

const doorDefinition = (alignment?: AlignmentSpec): DynamicBlockDefinition => ({
  version: 1,
  parameters: [widthParam()],
  actions: [doorStretch()],
  ...(alignment !== undefined ? { alignment } : {}),
});

const state = (values: DynamicInstanceState['values']): DynamicInstanceState => ({ block: 'DOOR', values });
const atWidth = (value: number): DynamicInstanceState => state({ width: { kind: 'distance', value } });

// --- AL1: evaluator indifference ------------------------------------------------
describe('alignment — AL1: the evaluator is indifferent to the field', () => {
  it('results are deep-equal with and without alignment, both modes, several value sets', () => {
    for (const mode of ['perpendicular', 'tangent'] as const) {
      const plain = doorDefinition();
      const aligned = doorDefinition(alignmentSpec({ mode }));
      for (const instance of [undefined, atWidth(10), atWidth(14), atWidth(7)]) {
        const a = evaluateDynamicBlock(plain, doorEntities(), doorAttributes(), instance);
        const b = evaluateDynamicBlock(aligned, doorEntities(), doorAttributes(), instance);
        expect(b).toEqual(a);
        expect(a.ok).toBe(true);
      }
    }
  });

  it('refusals are identical too: the field never changes a refusal', () => {
    const plain = doorDefinition();
    const aligned = doorDefinition(alignmentSpec());
    // An invalid instance value refuses the same way either way.
    const a = evaluateDynamicBlock(plain, doorEntities(), doorAttributes(), atWidth(25));
    const b = evaluateDynamicBlock(aligned, doorEntities(), doorAttributes(), atWidth(25));
    expect(b).toEqual(a);
    expect(a.ok).toBe(false);
    // Even an INVALID alignment spec refuses identically (as invalid-definition
    // via validation) whether the evaluator would otherwise succeed — the
    // refusal is validation's, and alignment adds no refusal of its own in
    // evaluation beyond carrying the same issue.
    const badAligned = doorDefinition(alignmentSpec({ direction: { x: 0, y: 0 } }));
    const refused = evaluateDynamicBlock(badAligned, doorEntities(), doorAttributes(), atWidth(14));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe('invalid-definition');
      expect(refused.refusal.definitionIssues?.map((i) => i.code)).toContain('invalid-direction');
    }
  });
});

// --- AL2: validation --------------------------------------------------------------
describe('alignment — AL2: validation of the spec geometry', () => {
  const codesOf = (def: DynamicBlockDefinition): string[] =>
    validateDefinition(def, DOOR_ID_SET).map((i) => i.code);

  it('a valid spec (both modes) validates clean', () => {
    expect(codesOf(doorDefinition(alignmentSpec()))).toEqual([]);
    expect(codesOf(doorDefinition(alignmentSpec({ mode: 'tangent', direction: { x: 1, y: 1 } })))).toEqual([]);
    expect(codesOf(doorDefinition())).toEqual([]);
  });

  it("a zero direction is 'invalid-direction'", () => {
    expect(codesOf(doorDefinition(alignmentSpec({ direction: { x: 0, y: 0 } })))).toContain('invalid-direction');
  });

  it("a non-finite direction is 'invalid-direction'", () => {
    expect(codesOf(doorDefinition(alignmentSpec({ direction: { x: Number.NaN, y: 1 } })))).toContain('invalid-direction');
    expect(codesOf(doorDefinition(alignmentSpec({ direction: { x: 1, y: Number.POSITIVE_INFINITY } })))).toContain('invalid-direction');
  });

  it("a non-finite base point is 'invalid-base-point'", () => {
    expect(codesOf(doorDefinition(alignmentSpec({ basePoint: { x: Number.NaN, y: 0 } })))).toContain('invalid-base-point');
    expect(codesOf(doorDefinition(alignmentSpec({ basePoint: { x: 0, y: Number.NEGATIVE_INFINITY } })))).toContain('invalid-base-point');
  });
});

// --- AL3: serialization shape + the §6.2 downgrade --------------------------------
describe('alignment — AL3: top-level "alignment" key, round-trip, downgrade', () => {
  const aligned = (): DynamicBlockDefinition => doorDefinition(alignmentSpec({ mode: 'tangent' }));

  it('the payload carries a top-level "alignment" object; parameters are unchanged', () => {
    const withKey = JSON.parse(encodeDynamicDefinition(aligned(), DOOR_IDS)) as Record<string, unknown>;
    const without = JSON.parse(encodeDynamicDefinition(doorDefinition(), DOOR_IDS)) as Record<string, unknown>;
    expect(withKey.alignment).toEqual({
      basePoint: { x: 0, y: 0 },
      direction: { x: 0, y: 1 },
      mode: 'tangent',
    });
    expect(withKey.parameters).toEqual(without.parameters);
    expect(withKey.actions).toEqual(without.actions);
    expect('alignment' in without).toBe(false);
  });

  it('decoding restores the field exactly (round-trip is deep-equal)', () => {
    const def = aligned();
    const decoded = decodeDynamicDefinition(encodeDynamicDefinition(def, DOOR_IDS), {
      entityIdsInOrder: DOOR_IDS,
      attributeTags: new Set(['TAG']),
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.definition).toEqual(def);
  });

  it('decoding the same payload with the key removed yields the same definition minus alignment', () => {
    const parsed = JSON.parse(encodeDynamicDefinition(aligned(), DOOR_IDS)) as Record<string, unknown>;
    delete parsed.alignment;
    const decoded = decodeDynamicDefinition(JSON.stringify(parsed), {
      entityIdsInOrder: DOOR_IDS,
      attributeTags: new Set(['TAG']),
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.definition).toEqual(doorDefinition());
      expect(decoded.definition.alignment).toBeUndefined();
    }
  });

  it('§6.1 downgrade mechanism: an unknown top-level key is ignored by decode and absent after re-encode', () => {
    // This is exactly how an older build treats the "alignment" key (and how
    // this build treats any future top-level key): decode succeeds on the
    // modeled fields alone, and the encoder — writing only modeled fields —
    // drops the key on re-save.
    const parsed = JSON.parse(encodeDynamicDefinition(doorDefinition(), DOOR_IDS)) as Record<string, unknown>;
    parsed.futureTopLevelKey = { anything: [1, 2, 3] };
    const decoded = decodeDynamicDefinition(JSON.stringify(parsed), {
      entityIdsInOrder: DOOR_IDS,
      attributeTags: new Set(['TAG']),
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.definition).toEqual(doorDefinition());
    const reEncoded = JSON.parse(encodeDynamicDefinition(decoded.definition, DOOR_IDS)) as Record<string, unknown>;
    expect('futureTopLevelKey' in reEncoded).toBe(false);
  });

  it('a malformed alignment value retains the whole payload (never half-modeled)', () => {
    const parsed = JSON.parse(encodeDynamicDefinition(aligned(), DOOR_IDS)) as Record<string, unknown>;
    parsed.alignment = { basePoint: { x: 0, y: 0 }, direction: { x: 0, y: 1 }, mode: 'diagonal' };
    const raw = JSON.stringify(parsed);
    const decoded = decodeDynamicDefinition(raw, {
      entityIdsInOrder: DOOR_IDS,
      attributeTags: new Set(['TAG']),
    });
    expect(decoded).toEqual({ ok: false, retained: raw });
  });

  it('a structurally decodable but invalid spec (zero direction) is retained when a base is supplied', () => {
    const parsed = JSON.parse(encodeDynamicDefinition(aligned(), DOOR_IDS)) as Record<string, unknown>;
    parsed.alignment = { basePoint: { x: 0, y: 0 }, direction: { x: 0, y: 0 }, mode: 'perpendicular' };
    const decoded = decodeDynamicDefinition(JSON.stringify(parsed), {
      entityIdsInOrder: DOOR_IDS,
      attributeTags: new Set(['TAG']),
    });
    expect(decoded.ok).toBe(false);
  });
});
