/**
 * Priority 30.2c — array action acceptance (design
 * design-visibility-lookup-array.md §3 + §8 cases A1–A10).
 *
 * The count rule pinned here is JCad's own (design §3.3): the native count
 * rule is undocumented at field level (fixture question Q13) and nothing in
 * this file is native AutoCAD evidence.
 */
import { describe, it, expect } from 'vitest';
import { sealImmutableData } from '../src/core/immutable-data';
import {
  explodeInsert,
  type AttributeDef,
  type BlockDef,
  type Entity,
  type InsertEntity,
  type LineEntity,
} from '../src/core/entities';
import {
  validateDefinition,
  type ArrayAction,
  type DynamicBlockDefinition,
  type LinearDistanceParameter,
} from '../src/core/parametric/definitions';
import type { DynamicInstanceState } from '../src/core/parametric/instance';
import { evaluateDynamicBlock, DEFAULT_EVALUATION_LIMITS } from '../src/core/parametric/evaluate';
import { decodeDynamicDefinition, encodeDynamicDefinition } from '../src/io/dxf/dynamic-data';

// --- Fixture PANEL (design §8) ----------------------------------------------
// E1 a vertical line at x=0 (the arrayed source); E2 an unselected control at
// x=20. `span` (default 10, range [0,40]) drives array ARR: selection [E1],
// spacing 5 along span's direction (1,0).
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});

const panelEntities = (): Entity[] => [line('E1', 0, 0, 0, 5), line('E2', 20, 0, 20, 5)];
const PANEL_IDS = new Set(['E1', 'E2']);

const spanParam = (over: Partial<LinearDistanceParameter> = {}): LinearDistanceParameter => ({
  kind: 'linear-distance', id: 'span', name: 'Span',
  basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 },
  defaultValue: 10, constraint: { kind: 'range', min: 0, max: 40 },
  grips: [{ role: 'base', movesWithValue: false }, { role: 'value', movesWithValue: true }],
  ...over,
});

const arrAction = (over: Partial<ArrayAction> = {}): ArrayAction => ({
  kind: 'array', id: 'ARR', name: 'Array', parameterId: 'span',
  selection: [{ entityId: 'E1' }], spacing: 5,
  ...over,
});

const panelDefinition = (over: Partial<DynamicBlockDefinition> = {}): DynamicBlockDefinition => ({
  version: 1,
  parameters: [spanParam()],
  actions: [arrAction()],
  ...over,
});

const state = (values: DynamicInstanceState['values']): DynamicInstanceState => ({ block: 'PANEL', values });
const spanState = (v: number): DynamicInstanceState => state({ span: { kind: 'distance', value: v } });
const idsOf = (entities: readonly Entity[]): string[] => entities.map((e) => e.id);
const asLine = (e: Entity): LineEntity => e as LineEntity;
const familyOf = (entities: readonly Entity[]): Entity[] =>
  entities.filter((e) => e.id === 'E1' || e.id.startsWith('E1#ARR#'));

// --- Count rule + production (A1–A4) ----------------------------------------
describe('evaluateDynamicBlock — array action (30.2c)', () => {
  it('A1: at the default the copies sit after their source, at spacing offsets', () => {
    const base = panelEntities();
    const result = evaluateDynamicBlock(panelDefinition(), base, [], undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Copies are inserted immediately after E1; the control E2 keeps its place.
    expect(idsOf(result.entities)).toEqual(['E1', 'E1#ARR#1', 'E1#ARR#2', 'E2']);
    // Copy 0 is the source itself, returned by identity; E2 untouched, by identity.
    expect(result.entities[0]).toBe(base[0]);
    expect(result.entities[3]).toBe(base[1]);
    expect(asLine(result.entities[1]!).a).toEqual({ x: 5, y: 0 });
    expect(asLine(result.entities[1]!).b).toEqual({ x: 5, y: 5 });
    expect(asLine(result.entities[2]!).a).toEqual({ x: 10, y: 0 });
    expect(asLine(result.entities[2]!).b).toEqual({ x: 10, y: 5 });
    expect(result.appliedActions).toEqual(['ARR']);
  });

  it('A2: the count rule — endpoint inclusive at exact multiples (JCad §3.3 rule)', () => {
    // count = floor(v / spacing) + 1 on the exact quotient: 10 -> 3, 9.999 -> 2,
    // 15 -> 4, 0 -> 1 (copy 0 is always present).
    const cases: [number, number][] = [[10, 3], [9.999, 2], [15, 4], [0, 1]];
    for (const [v, count] of cases) {
      const result = evaluateDynamicBlock(panelDefinition(), panelEntities(), [], spanState(v));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(familyOf(result.entities).length).toBe(count);
    }
  });

  it('A3: a single copy is a no-op with the action-no-op diagnostic', () => {
    const base = panelEntities();
    const result = evaluateDynamicBlock(panelDefinition(), base, [], spanState(4));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(idsOf(result.entities)).toEqual(['E1', 'E2']);
    expect(result.entities[0]).toBe(base[0]);
    const diag = result.diagnostics.find((d) => d.code === 'action-no-op');
    expect(diag?.actionId).toBe('ARR');
    // The message states the count; it must not claim the parameter is at its
    // default (span 4 is off-default — design §3.5).
    expect(diag?.message).toContain('copy count of 1');
  });

  it('A4: the output limit refuses BEFORE any copy is created', () => {
    // span 40 at spacing 5 would give 9 copies of E1: 2 + 8 = 10 entities,
    // over the test-supplied limit of 5. The result is a refusal, never a
    // partial entity list.
    const limits = { ...DEFAULT_EVALUATION_LIMITS, maxOutputEntities: 5 };
    const result = evaluateDynamicBlock(panelDefinition(), panelEntities(), [], spanState(40), limits);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('work-limit-exceeded');
    expect(result.refusal.actionId).toBe('ARR');
  });

  it('derived ids are deterministic across two runs', () => {
    const a = evaluateDynamicBlock(panelDefinition(), panelEntities(), [], spanState(15));
    const b = evaluateDynamicBlock(panelDefinition(), panelEntities(), [], spanState(15));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(idsOf(a.entities)).toEqual(['E1', 'E1#ARR#1', 'E1#ARR#2', 'E1#ARR#3', 'E2']);
    expect(idsOf(b.entities)).toEqual(idsOf(a.entities));
  });

  it('two arrays on one source are additive, not multiplicative (design §3.4)', () => {
    // ARR (spacing 5) gives 3 copies of E1 at span 10; ARR2 (spacing 10)
    // arrays COPY 0's current geometry and adds 1 more: 3 + 2 - 1 = 4 family
    // members, not 3 * 2 = 6. ARR2's copy lands immediately after copy 0.
    const def = panelDefinition({
      actions: [arrAction(), arrAction({ id: 'ARR2', name: 'Array 2', spacing: 10 })],
    });
    const result = evaluateDynamicBlock(def, panelEntities(), [], undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const family = result.entities.filter((e) => e.id === 'E1' || e.id.startsWith('E1#'));
    expect(idsOf(family)).toEqual(['E1', 'E1#ARR2#1', 'E1#ARR#1', 'E1#ARR#2']);
    expect(asLine(family[1]!).a).toEqual({ x: 10, y: 0 });
  });
});

// --- Pipeline order (A5) ------------------------------------------------------
describe('array — pipeline order with stretch (A5)', () => {
  // Stretch S1 (driven by `shift`, delta +3 in x at value 3) covers E1 whole.
  // span's value grip sits at (10,0), outside S1's frame, so no grip edge is
  // derived; stretch<->array order is authoring order (design §3.4).
  const shiftParam: LinearDistanceParameter = {
    kind: 'linear-distance', id: 'shift', name: 'Shift',
    basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 },
    defaultValue: 0, constraint: { kind: 'range', min: 0, max: 20 },
    grips: [{ role: 'base', movesWithValue: false }, { role: 'value', movesWithValue: true }],
  };
  const stretch = {
    kind: 'stretch', id: 'S1', name: 'Stretch', parameterId: 'shift',
    frame: { kind: 'rectangle', min: { x: -1, y: -1 }, max: { x: 1, y: 6 } },
    selection: [{ entityId: 'E1', points: { kind: 'frame' } }],
  } as const;
  const instance = state({
    span: { kind: 'distance', value: 10 },
    shift: { kind: 'distance', value: 3 },
  });

  it('A5a: stretch authored BEFORE the array — copies inherit the stretched geometry', () => {
    const def = panelDefinition({ parameters: [spanParam(), shiftParam], actions: [stretch, arrAction()] });
    const result = evaluateDynamicBlock(def, panelEntities(), [], instance);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedActions).toEqual(['S1', 'ARR']);
    // E1 was moved whole to x=3 first; copies array from that position.
    expect(idsOf(result.entities)).toEqual(['E1', 'E1#ARR#1', 'E1#ARR#2', 'E2']);
    expect(asLine(result.entities[0]!).a).toEqual({ x: 3, y: 0 });
    expect(asLine(result.entities[1]!).a).toEqual({ x: 8, y: 0 });
    expect(asLine(result.entities[2]!).a).toEqual({ x: 13, y: 0 });
  });

  it('A5b: array authored BEFORE the stretch — the stretch moves copy 0 only', () => {
    const def = panelDefinition({ parameters: [spanParam(), shiftParam], actions: [arrAction(), stretch] });
    const result = evaluateDynamicBlock(def, panelEntities(), [], instance);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedActions).toEqual(['ARR', 'S1']);
    // Copies were made from the unstretched source and keep their array
    // positions; the stretch resolves E1 by base id and moves copy 0 only.
    expect(idsOf(result.entities)).toEqual(['E1', 'E1#ARR#1', 'E1#ARR#2', 'E2']);
    expect(asLine(result.entities[0]!).a).toEqual({ x: 3, y: 0 });
    expect(asLine(result.entities[1]!).a).toEqual({ x: 5, y: 0 });
    expect(asLine(result.entities[2]!).a).toEqual({ x: 10, y: 0 });
  });
});

// --- Members, attributes, validation (A6–A8) ---------------------------------
describe('array — members and refusals (A6–A8)', () => {
  const memberInsert = (over: Partial<InsertEntity> = {}): InsertEntity => ({
    id: 'IN1', layer: '0', color: 'ByLayer', type: 'insert', block: 'SUB',
    position: { x: 2, y: 2 }, rotation: 0, scale: 1, attributes: {},
    ...over,
  });

  it('A6: a nested insert member is copied as an insert; every copy expands', () => {
    const entities: Entity[] = [memberInsert(), line('E2', 20, 0, 20, 5)];
    const def = panelDefinition({ actions: [arrAction({ selection: [{ entityId: 'IN1' }] })] });
    const result = evaluateDynamicBlock(def, entities, [], undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(idsOf(result.entities)).toEqual(['IN1', 'IN1#ARR#1', 'IN1#ARR#2', 'E2']);
    const copies = result.entities.slice(0, 3) as InsertEntity[];
    expect(copies.map((c) => c.position)).toEqual([{ x: 2, y: 2 }, { x: 7, y: 2 }, { x: 12, y: 2 }]);
    // All three copies expand against the static SUB block.
    const sub: BlockDef = { name: 'SUB', basePoint: { x: 0, y: 0 }, entities: [line('SL', 0, 0, 1, 0)], attributes: [] };
    const blocks = { SUB: sub };
    const lookup = (n: string) => blocks[n as keyof typeof blocks];
    for (const [i, copy] of copies.entries()) {
      const expanded = explodeInsert(copy, lookup);
      expect(expanded).toHaveLength(1);
      expect(asLine(expanded[0]!).a).toEqual({ x: 2 + i * 5, y: 2 });
    }
  });

  it('A6b: copies of a dynamic member share its instance state by reference', () => {
    const memberState: DynamicInstanceState = { block: 'SUB', values: { width: { kind: 'distance', value: 9 } } };
    const entities: Entity[] = [memberInsert({ dynamic: memberState }), line('E2', 20, 0, 20, 5)];
    const def = panelDefinition({ actions: [arrAction({ selection: [{ entityId: 'IN1' }] })] });
    const result = evaluateDynamicBlock(def, entities, [], undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Each copy is expanded and evaluated independently at expansion time,
    // with the same values — the state object itself is shared, as MINSERT
    // cells share it (design §3.4).
    for (const e of result.entities.slice(0, 3)) {
      expect((e as InsertEntity).dynamic).toBe(memberState);
    }
  });

  it('A7: an attribute definition in the array selection refuses at evaluation', () => {
    const attrs: AttributeDef[] = [
      { tag: 'NOTE', prompt: 'Note', default: '', position: { x: 1, y: 1 }, height: 2, align: 'left' },
    ];
    const def = panelDefinition({ actions: [arrAction({ selection: [{ entityId: 'NOTE' }] })] });
    // Validation CANNOT catch this: ids and tags share one identity space,
    // so 'NOTE' is a perfectly good selection ref statically (design §3.4).
    expect(validateDefinition(def, new Set(['E1', 'E2', 'NOTE']))).toEqual([]);
    const result = evaluateDynamicBlock(def, panelEntities(), attrs, undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('unsupported-selection');
    expect(result.refusal.actionId).toBe('ARR');
  });

  it('A8: malformed arrays are refused at validation with their §3.6 codes', () => {
    const codesOf = (def: DynamicBlockDefinition, ids: ReadonlySet<string> = PANEL_IDS) =>
      validateDefinition(def, ids).map((i) => i.code);
    expect(codesOf(panelDefinition({ actions: [arrAction({ spacing: 0 })] }))).toContain('invalid-action-geometry');
    expect(codesOf(panelDefinition({ actions: [arrAction({ spacing: -5 })] }))).toContain('invalid-action-geometry');
    expect(codesOf(panelDefinition({ actions: [arrAction({ spacing: Number.NaN })] }))).toContain('invalid-action-geometry');
    // Driven by an angle parameter: the pairing table refuses it.
    const angleParam = {
      kind: 'angle', id: 'swing', name: 'Swing', basePoint: { x: 0, y: 0 },
      defaultValue: 0, constraint: { kind: 'unbounded' },
      grips: [{ role: 'base', movesWithValue: false }],
    } as const;
    const byAngle = panelDefinition({
      parameters: [spanParam(), angleParam],
      actions: [arrAction({ parameterId: 'swing' })],
    });
    expect(codesOf(byAngle)).toContain('parameter-kind-mismatch');
    // Selection naming a missing entity.
    expect(codesOf(panelDefinition({ actions: [arrAction({ selection: [{ entityId: 'GONE' }] })] })))
      .toContain('unknown-entity-ref');
    // A base id containing '#' in a definition WITH an array action.
    const hashEntities: Entity[] = [line('E#1', 0, 0, 0, 5), line('E2', 20, 0, 20, 5)];
    const hashDef = panelDefinition({ actions: [arrAction({ selection: [{ entityId: 'E#1' }] })] });
    expect(codesOf(hashDef, new Set(['E#1', 'E2']))).toContain('reserved-entity-id');
    const refused = evaluateDynamicBlock(hashDef, hashEntities, [], undefined);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe('invalid-definition');
    // The same '#' id is unrestricted in a definition with NO array action.
    const noArray = panelDefinition({
      actions: [{
        kind: 'move', id: 'M1', name: 'Move', parameterId: 'span', selection: [{ entityId: 'E#1' }],
      }],
    });
    expect(codesOf(noArray, new Set(['E#1', 'E2']))).not.toContain('reserved-entity-id');
  });
});

// --- Interactions (A9, lookup) -------------------------------------------------
describe('array — interactions', () => {
  it('A9: the visibility filter drops array products by SOURCE id', () => {
    const def = panelDefinition({
      parameters: [
        spanParam(),
        {
          kind: 'visibility', id: 'vis', name: 'Visibility', basePoint: { x: 0, y: 6 },
          defaultState: 'Dense',
          states: [
            { name: 'Dense', visible: ['E1', 'E2'] },
            { name: 'Sparse', visible: ['E2'] },
          ],
        },
      ],
    });
    // Sparse hides E1: the source AND all its copies are dropped (the copies'
    // derived ids are in no visible set — provenance decides, design §3.4).
    const sparse = evaluateDynamicBlock(def, panelEntities(), [], state({
      vis: { kind: 'visibility', value: 'Sparse' },
      span: { kind: 'distance', value: 10 },
    }));
    expect(sparse.ok).toBe(true);
    if (!sparse.ok) return;
    expect(idsOf(sparse.entities)).toEqual(['E2']);
    // Dense shows E1: all three copies appear.
    const dense = evaluateDynamicBlock(def, panelEntities(), [], state({
      vis: { kind: 'visibility', value: 'Dense' },
      span: { kind: 'distance', value: 10 },
    }));
    expect(dense.ok).toBe(true);
    if (!dense.ok) return;
    expect(idsOf(dense.entities)).toEqual(['E1', 'E1#ARR#1', 'E1#ARR#2', 'E2']);
  });

  it('arrays read finalEffective: a lookup row drives the count', () => {
    const def = panelDefinition({
      parameters: [
        spanParam(),
        {
          kind: 'lookup', id: 'preset', name: 'Preset', basePoint: { x: 0, y: 6 },
          inputs: ['span'], defaultRow: null,
          rows: [{ name: 'Wide', key: { span: { kind: 'distance', value: 20 } }, assignments: {} }],
        },
      ],
    });
    const result = evaluateDynamicBlock(def, panelEntities(), [], state({
      preset: { kind: 'lookup', value: 'Wide' },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The row sets span to 20 -> floor(20/5)+1 = 5 family members.
    expect(familyOf(result.entities)).toHaveLength(5);
    expect(result.diagnostics.some((d) => d.code === 'lookup-applied')).toBe(true);
  });
});

// --- Determinism (A10) ---------------------------------------------------------
describe('array — determinism (A10)', () => {
  it('A10: sealed inputs evaluate twice to deep-equal results; bases unmutated', () => {
    const def = sealImmutableData(panelDefinition());
    const base = sealImmutableData(panelEntities());
    const instance = sealImmutableData(spanState(15));
    const a = evaluateDynamicBlock(def, base, [], instance);
    const b = evaluateDynamicBlock(def, base, [], instance);
    expect(a.ok && b.ok).toBe(true);
    expect(a).toEqual(b);
    if (!a.ok) return;
    expect(idsOf(a.entities)).toEqual(['E1', 'E1#ARR#1', 'E1#ARR#2', 'E1#ARR#3', 'E2']);
    expect(base).toEqual(panelEntities());
  });
});

// --- Serialization (design §6.2: v1 additive) ----------------------------------
describe('array — JCAD_DYNAMIC serialization', () => {
  it('round-trips through the canonical payload; selections encode as ordinals', () => {
    const def = panelDefinition();
    const encoded = encodeDynamicDefinition(def, ['E1', 'E2']);
    expect(encoded).toContain('"kind":"array"');
    expect(encoded).toContain('"entityId":"#0"');
    expect(encoded).toContain('"spacing":5');
    const decoded = decodeDynamicDefinition(encoded, { entityIdsInOrder: ['E1', 'E2'] });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.definition).toEqual(def);
  });

  it('an unknown action kind retains the whole payload verbatim (older-build pattern)', () => {
    // This is exactly how a pre-30.2c build treats an 'array' member: its
    // structural decode fails on the unknown kind and the payload is
    // retained whole, never half-modeled (§6.1). Demonstrated with the
    // next unknown kind in place of 'array'.
    const encoded = encodeDynamicDefinition(panelDefinition(), ['E1', 'E2'])
      .replace('"kind":"array"', '"kind":"polar-array"');
    const decoded = decodeDynamicDefinition(encoded, { entityIdsInOrder: ['E1', 'E2'] });
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.retained).toBe(encoded);
  });

  it('a malformed array member (non-numeric spacing) retains the whole payload', () => {
    const encoded = encodeDynamicDefinition(panelDefinition(), ['E1', 'E2'])
      .replace('"spacing":5', '"spacing":"5"');
    const decoded = decodeDynamicDefinition(encoded, { entityIdsInOrder: ['E1', 'E2'] });
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.retained).toBe(encoded);
  });
});
