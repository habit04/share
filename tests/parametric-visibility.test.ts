/**
 * Priority 30.2a — visibility parameter acceptance (design
 * docs/DYNAMIC-BLOCKS-CONSTRAINTS.md slice 30.2a; semantics in
 * design-visibility-lookup-array.md §1 + §8 cases V1–V9).
 *
 * Visibility is a post-pass filter: actions run over the full authored set,
 * then the effective state's visible set selects what the result contains.
 * Authored normalized model; NOT native AutoCAD evidence.
 */
import { describe, it, expect } from 'vitest';
import { sealImmutableData } from '../src/core/immutable-data';
import type { DrawingState } from '../src/core/document';
import {
  expandInsert,
  explodeInsert,
  type AttributeDef,
  type BlockDef,
  type CircleEntity,
  type Entity,
  type InsertEntity,
  type LineEntity,
  type TextEntity,
} from '../src/core/entities';
import {
  validateDefinition,
  type DynamicBlockDefinition,
  type VisibilityParameter,
} from '../src/core/parametric/definitions';
import { validateInstanceValues, type DynamicInstanceState } from '../src/core/parametric/instance';
import { evaluateDynamicBlock, evaluationKey } from '../src/core/parametric/evaluate';
import { setDynamicParameter } from '../src/core/parametric/apply';
import {
  decodeDynamicDefinition,
  decodeDynamicInstance,
  encodeDynamicDefinition,
  encodeDynamicInstance,
} from '../src/io/dxf/dynamic-data';

// --- Fixture CAB (design §8) -------------------------------------------------
// L1 bottom, L2 right, L3 top of an open 10x5 rectangle; C1 a circle inside;
// NOTE an attribute definition. `width` (default 10, range [5,20]) drives
// stretch S1 (frame crosses the right edge) over L2 and L3. Visibility `vis`:
// default 'Closed' shows [L1, L3]; 'Open' shows [L1, L2, C1, NOTE].
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});
const circle = (id: string, cx: number, cy: number, r: number): CircleEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'circle', center: { x: cx, y: cy }, radius: r,
});

const cabEntities = (): Entity[] => [
  line('L1', 0, 0, 10, 0),
  line('L2', 10, 0, 10, 5),
  line('L3', 0, 5, 10, 5),
  circle('C1', 5, 2.5, 1),
];
const cabAttributes = (): AttributeDef[] => [
  { tag: 'NOTE', prompt: 'Note', default: '', position: { x: 1, y: 1 }, height: 2, align: 'left' },
];
const CAB_IDS = new Set(['L1', 'L2', 'L3', 'C1', 'NOTE']);

const visParam = (over: Partial<VisibilityParameter> = {}): VisibilityParameter => ({
  kind: 'visibility',
  id: 'vis',
  name: 'Visibility',
  basePoint: { x: 0, y: 6 },
  defaultState: 'Closed',
  states: [
    { name: 'Open', visible: ['L1', 'L2', 'C1', 'NOTE'] },
    { name: 'Closed', visible: ['L1', 'L3'] },
  ],
  ...over,
});

const cabDefinition = (over: Partial<DynamicBlockDefinition> = {}): DynamicBlockDefinition => ({
  version: 1,
  parameters: [
    {
      kind: 'linear-distance', id: 'width', name: 'Width',
      basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 },
      defaultValue: 10, constraint: { kind: 'range', min: 5, max: 20 },
      grips: [{ role: 'base', movesWithValue: false }, { role: 'value', movesWithValue: true }],
    },
    visParam(),
  ],
  actions: [{
    kind: 'stretch', id: 'S1', name: 'Stretch', parameterId: 'width',
    frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 6 } },
    selection: [
      { entityId: 'L2', points: { kind: 'frame' } },
      { entityId: 'L3', points: { kind: 'frame' } },
    ],
  }],
  ...over,
});

const state = (values: DynamicInstanceState['values']): DynamicInstanceState => ({ block: 'CAB', values });
const asLine = (e: Entity): LineEntity => e as LineEntity;
const idsOf = (entities: readonly Entity[]): string[] => entities.map((e) => e.id);

// --- Evaluation semantics (V1–V3, V8, V9) -----------------------------------
describe('evaluateDynamicBlock — visibility post-pass filter (30.2a)', () => {
  it('V1: the named state selects exactly its visible set, in base order', () => {
    const result = evaluateDynamicBlock(cabDefinition(), cabEntities(), cabAttributes(), state({ vis: { kind: 'visibility', value: 'Open' } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(idsOf(result.entities)).toEqual(['L1', 'L2', 'C1']);
    expect(result.attributes.map((a) => a.tag)).toEqual(['NOTE']);
  });

  it('V2: with no values the DEFAULT state filters — even at parameter defaults', () => {
    // The restated identity invariant (§1.4(c)): a fully-default instance of a
    // visibility block evaluates to the default state's visible subset, NOT
    // the full authored list.
    const result = evaluateDynamicBlock(cabDefinition(), cabEntities(), cabAttributes(), undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(idsOf(result.entities)).toEqual(['L1', 'L3']);
    expect(result.attributes).toEqual([]);
  });

  it('V3: actions transform hidden entities; switching state reveals them already stretched', () => {
    const open = evaluateDynamicBlock(
      cabDefinition(), cabEntities(), cabAttributes(),
      state({ vis: { kind: 'visibility', value: 'Open' }, width: { kind: 'distance', value: 14 } }),
    );
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    expect(idsOf(open.entities)).toEqual(['L1', 'L2', 'C1']); // L3 hidden here
    expect(asLine(open.entities[1]!).a).toEqual({ x: 14, y: 0 }); // L2 stretched

    const closed = evaluateDynamicBlock(
      cabDefinition(), cabEntities(), cabAttributes(),
      state({ vis: { kind: 'visibility', value: 'Closed' }, width: { kind: 'distance', value: 14 } }),
    );
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    // L3 was hidden in the Open evaluation; in Closed it appears AND is
    // stretched (its in-frame endpoint moved +4) — the stretch ran while the
    // other state hid it.
    expect(idsOf(closed.entities)).toEqual(['L1', 'L3']);
    expect(asLine(closed.entities[1]!).a).toEqual({ x: 0, y: 5 });
    expect(asLine(closed.entities[1]!).b).toEqual({ x: 14, y: 5 });
  });

  it('V8: the filter preserves identity for everything it keeps', () => {
    const base = cabEntities();
    const attrs = cabAttributes();
    const result = evaluateDynamicBlock(
      cabDefinition(), base, attrs, state({ vis: { kind: 'visibility', value: 'Open' } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // width is at default, so the stretch replaced nothing; the filter kept
    // the surviving objects by identity (L3, filtered out, is simply absent).
    expect(result.entities[0]).toBe(base[0]); // L1
    expect(result.entities[1]).toBe(base[1]); // L2
    expect(result.entities[2]).toBe(base[3]); // C1
    expect(result.attributes[0]).toBe(attrs[0]); // NOTE
  });

  it('V9: deterministic under sealed inputs; evaluationKey separates states', () => {
    const def = sealImmutableData(cabDefinition());
    const base = sealImmutableData(cabEntities());
    const attrs = sealImmutableData(cabAttributes());
    const open = sealImmutableData(state({ vis: { kind: 'visibility', value: 'Open' }, width: { kind: 'distance', value: 14 } }));
    const r1 = evaluateDynamicBlock(def, base, attrs, open);
    const r2 = evaluateDynamicBlock(def, base, attrs, open);
    expect(r1.ok).toBe(true);
    expect(r1).toEqual(r2);
    // Inputs unmutated (sealing would have thrown on a write; also check shape).
    expect(base.map((e) => e.id)).toEqual(['L1', 'L2', 'L3', 'C1']);

    const effOpen = validateInstanceValues(def, open);
    const effClosed = validateInstanceValues(def, state({ vis: { kind: 'visibility', value: 'Closed' }, width: { kind: 'distance', value: 14 } }));
    expect(effOpen.ok && effClosed.ok).toBe(true);
    if (effOpen.ok && effClosed.ok) {
      expect(evaluationKey(def, effOpen.effective)).not.toBe(evaluationKey(def, effClosed.effective));
      expect(evaluationKey(def, effOpen.effective)).toBe(evaluationKey(def, effOpen.effective));
    }
  });
});

// --- Validation refusals (V5, V6) --------------------------------------------
describe('visibility validation (30.2a)', () => {
  it('V5: an unknown state name is refused, never replaced by the default', () => {
    const bad = state({ vis: { kind: 'visibility', value: 'Ajar' } });
    const validation = validateInstanceValues(cabDefinition(), bad);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issues.map((i) => i.code)).toContain('unknown-visibility-state');
    }
    const result = evaluateDynamicBlock(cabDefinition(), cabEntities(), cabAttributes(), bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('invalid-instance');
      expect(result.refusal.instanceIssues?.map((i) => i.code)).toContain('unknown-visibility-state');
    }
    // A distance value on the visibility parameter is the wrong kind entirely.
    const wrongKind = validateInstanceValues(cabDefinition(), state({ vis: { kind: 'distance', value: 3 } }));
    expect(wrongKind.ok).toBe(false);
    if (!wrongKind.ok) expect(wrongKind.issues.map((i) => i.code)).toContain('wrong-value-kind');
  });

  it('V5 (document level): editing the visibility parameter through the distance edit path refuses atomically', () => {
    // setDynamicParameter is the document edit path in this slice; it sets
    // distance values only, so an edit aimed at 'vis' is refused with the
    // SAME state object — zero trace (no undo entry, no dirty flag).
    const block: BlockDef = {
      name: 'CAB', basePoint: { x: 0, y: 0 }, entities: cabEntities(), attributes: cabAttributes(),
      dynamic: cabDefinition(),
    };
    const ins: InsertEntity = {
      id: 'I1', layer: '0', color: 'ByLayer', type: 'insert', block: 'CAB',
      position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: { NOTE: 'N7' },
      dynamic: state({ vis: { kind: 'visibility', value: 'Ajar' } }),
    };
    const drawing: DrawingState = {
      entities: [ins],
      layers: [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }],
      blocks: { CAB: block },
      currentLayer: '0',
    };
    const r = setDynamicParameter(drawing, 'I1', 'vis', 12);
    expect(r.state).toBe(drawing);
    expect(r.problem).toBe('wrong-value-kind');

    // And the stored 'Ajar' value is retained on the insert: expansion falls
    // back to the authored geometry (all four entities + NOTE text).
    const lookup = (n: string) => (n === 'CAB' ? block : undefined);
    const expanded = explodeInsert(ins, lookup);
    expect(idsOf(expanded.filter((e) => e.type !== 'text'))).toEqual(['L1', 'L2', 'L3', 'C1']);
    expect(expanded.filter((e): e is TextEntity => e.type === 'text').map((t) => t.text)).toEqual(['N7']);
    expect(ins.dynamic?.values.vis).toEqual({ kind: 'visibility', value: 'Ajar' });
  });

  it('V6: malformed visibility definitions refuse with their §1.3 codes', () => {
    const variants: [string, DynamicBlockDefinition, string][] = [
      ['two visibility parameters', cabDefinition({
        parameters: [...cabDefinition().parameters, visParam({ id: 'vis2' })],
      }), 'duplicate-visibility-parameter'],
      ['duplicate state names', cabDefinition({
        parameters: [cabDefinition().parameters[0]!, visParam({
          states: [
            { name: 'Open', visible: ['L1'] },
            { name: 'Open', visible: ['L2'] },
          ],
          defaultState: 'Open',
        })],
      }), 'duplicate-visibility-state'],
      ['no states', cabDefinition({
        parameters: [cabDefinition().parameters[0]!, visParam({ states: [], defaultState: 'Closed' })],
      }), 'invalid-visibility-states'],
      ['defaultState names no state', cabDefinition({
        parameters: [cabDefinition().parameters[0]!, visParam({ defaultState: 'Ajar' })],
      }), 'invalid-visibility-states'],
      ['empty state name', cabDefinition({
        parameters: [cabDefinition().parameters[0]!, visParam({
          states: [{ name: '', visible: ['L1'] }, { name: 'Closed', visible: ['L1', 'L3'] }],
        })],
      }), 'invalid-visibility-states'],
      ['a state shows nothing', cabDefinition({
        parameters: [cabDefinition().parameters[0]!, visParam({
          states: [
            { name: 'Open', visible: ['L1', 'L2', 'C1', 'NOTE'] },
            { name: 'Closed', visible: [] },
          ],
        })],
      }), 'empty-visibility-state'],
      ['a state lists a missing id', cabDefinition({
        parameters: [cabDefinition().parameters[0]!, visParam({
          states: [
            { name: 'Open', visible: ['L1', 'ZZ'] },
            { name: 'Closed', visible: ['L1', 'L3'] },
          ],
        })],
      }), 'unknown-entity-ref'],
      ['a visible list repeats an entry', cabDefinition({
        parameters: [cabDefinition().parameters[0]!, visParam({
          states: [
            { name: 'Open', visible: ['L1', 'L1'] },
            { name: 'Closed', visible: ['L1', 'L3'] },
          ],
        })],
      }), 'invalid-visibility-states'],
      ['non-finite grip anchor', cabDefinition({
        parameters: [cabDefinition().parameters[0]!, visParam({ basePoint: { x: Number.NaN, y: 0 } })],
      }), 'invalid-base-point'],
    ];
    for (const [label, def, code] of variants) {
      const issues = validateDefinition(def, CAB_IDS);
      expect(issues.map((i) => i.code), label).toContain(code);
      const result = evaluateDynamicBlock(def, cabEntities(), cabAttributes(), undefined);
      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.refusal.code, label).toBe('invalid-definition');
        expect(result.refusal.definitionIssues?.map((i) => i.code), label).toContain(code);
      }
    }
  });

  it('an action driven by the visibility parameter is a kind mismatch (design §1.2)', () => {
    const def = cabDefinition({
      actions: [{
        kind: 'move', id: 'M1', name: 'Move', parameterId: 'vis',
        selection: [{ entityId: 'L1' }],
      }],
    });
    const issues = validateDefinition(def, CAB_IDS);
    expect(issues.map((i) => i.code)).toContain('parameter-kind-mismatch');
  });

  it('the CAB definition itself is valid', () => {
    expect(validateDefinition(cabDefinition(), CAB_IDS)).toEqual([]);
    const v = validateInstanceValues(cabDefinition(), state({ vis: { kind: 'visibility', value: 'Open' } }));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.effective.vis).toEqual({ kind: 'visibility', value: 'Open' });
  });
});

// --- Document / expansion level (V4, V7) -------------------------------------
describe('visibility at document level (30.2a)', () => {
  const cabBlock = (): BlockDef => ({
    name: 'CAB', basePoint: { x: 0, y: 0 }, entities: cabEntities(), attributes: cabAttributes(),
    dynamic: cabDefinition(),
  });
  const cabInsert = (id: string, visState: string, x = 100): InsertEntity => ({
    id, layer: '0', color: 'ByLayer', type: 'insert', block: 'CAB',
    position: { x, y: 100 }, rotation: 0, scale: 1,
    attributes: { NOTE: 'N7' },
    dynamic: state({ vis: { kind: 'visibility', value: visState } }),
  });

  it('V4: a hidden attribute generates no text; its value survives on the insert and reappears on switch', () => {
    const block = cabBlock();
    const lookup = (n: string) => (n === 'CAB' ? block : undefined);
    const closed = cabInsert('I1', 'Closed');
    const expandedClosed = explodeInsert(closed, lookup);
    expect(expandedClosed.filter((e) => e.type === 'text')).toEqual([]);
    // The value was never an evaluation output: it is untouched on the insert.
    expect(closed.attributes).toEqual({ NOTE: 'N7' });

    const open = cabInsert('I1', 'Open');
    const texts = explodeInsert(open, lookup).filter((e): e is TextEntity => e.type === 'text');
    expect(texts.map((t) => t.text)).toEqual(['N7']);
    expect(texts[0]!.position).toEqual({ x: 101, y: 101 }); // authored placement + insert offset
  });

  it('V7: the filter shrinks expansion input exactly by the visible-set difference', () => {
    const block = cabBlock();
    const lookup = (n: string) => (n === 'CAB' ? block : undefined);
    const open = expandInsert(cabInsert('I1', 'Open'), lookup);
    const closed = expandInsert(cabInsert('I2', 'Closed', 200), lookup);
    expect(open.truncated).toBe(false);
    expect(open.cyclic).toBe(false);
    expect(closed.truncated).toBe(false);
    expect(closed.cyclic).toBe(false);
    const openGeo = open.entities.filter((e) => e.type !== 'text');
    const closedGeo = closed.entities.filter((e) => e.type !== 'text');
    expect(idsOf(openGeo)).toEqual(['L1', 'L2', 'C1']);
    expect(idsOf(closedGeo)).toEqual(['L1', 'L3']);
    // Open carries NOTE text; Closed does not. Total counts differ by the
    // C1 entity + the NOTE text (L2/L3 swap cancels).
    expect(open.entities.filter((e) => e.type === 'text')).toHaveLength(1);
    expect(closed.entities.filter((e) => e.type === 'text')).toHaveLength(0);
    expect(open.entities.length - closed.entities.length).toBe(2);
  });

  // Design §1.4(d): EXPLODE of a dynamic instance whose evaluation REFUSES
  // must refuse rather than explode the fallback geometry and discard the
  // parameter state. Specified in 30.2a; the evaluation-status probe beside
  // insertExpansionLimited is 30.4 work, so the case is pinned, not faked.
  it.todo('EXPLODE refuses a dynamic insert whose evaluation refuses (design §1.4(d), 30.4 hook)');
});

// --- Serialization (design §1.5 + §6.2) --------------------------------------
describe('JCAD_DYNAMIC serialization — visibility (30.2a, model version stays 1)', () => {
  const base = { entityIdsInOrder: ['L1', 'L2', 'L3', 'C1'], attributeTags: new Set(['NOTE']) };

  it('round-trips the visibility parameter; visible lists use #<ordinal> for entities, tags verbatim', () => {
    const def = cabDefinition();
    const payload = encodeDynamicDefinition(def, base.entityIdsInOrder);
    // Open = [L1, L2, C1, NOTE] -> ordinals for entities, tag verbatim.
    expect(payload).toContain('"visible":["#0","#1","#3","NOTE"]');
    expect(payload).toContain('"visible":["#0","#2"]');
    const decoded = decodeDynamicDefinition(payload, base);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.definition).toEqual(def);
  });

  it('round-trips a visibility instance value against the definition', () => {
    const s = state({ vis: { kind: 'visibility', value: 'Open' }, width: { kind: 'distance', value: 14 } });
    const payload = encodeDynamicInstance(s);
    expect(payload).toContain('"vis":{"kind":"visibility","value":"Open"}');
    const decoded = decodeDynamicInstance(payload, cabDefinition(), 'CAB');
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.state).toEqual(s);
  });

  it('an instance naming an unknown state is retained on decode, never modeled', () => {
    const payload = encodeDynamicInstance(state({ vis: { kind: 'visibility', value: 'Ajar' } }));
    const decoded = decodeDynamicInstance(payload, cabDefinition(), 'CAB');
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.retained).toBe(payload);
  });

  it('an unknown parameter kind retains the whole payload (the fallback that protects visibility payloads on older builds)', () => {
    // §6.1: an older build fails structural decode on ANY member kind it does
    // not know and retains the payload verbatim — that is exactly how a
    // pre-30.2a build treats a 'visibility' member. Pinned here with the
    // next slice's kind: this build must retain, never half-model.
    const payload = JSON.stringify({
      v: 1, kind: 'definition',
      parameters: [{ kind: 'lookup', id: 'lk', name: 'Lookup' }],
      actions: [],
    });
    const decoded = decodeDynamicDefinition(payload, base);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.retained).toBe(payload);
  });

  it('a visibility value against a definition without a visibility parameter is retained', () => {
    const payload = encodeDynamicInstance(state({ vis: { kind: 'visibility', value: 'Open' } }));
    const noVis = cabDefinition({ parameters: [cabDefinition().parameters[0]!] });
    const decoded = decodeDynamicInstance(payload, noVis, 'CAB');
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.retained).toBe(payload);
  });

  it('a pre-30.2a v1 payload (linear + stretch only) still decodes, unchanged', () => {
    const payload = JSON.stringify({
      v: 1, kind: 'definition',
      parameters: [{
        kind: 'linear-distance', id: 'width', name: 'Width',
        basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, defaultValue: 10,
        constraint: { kind: 'range', min: 5, max: 20 },
        grips: [{ role: 'value', movesWithValue: true }],
      }],
      actions: [{
        kind: 'stretch', id: 'S1', name: 'Stretch', parameterId: 'width',
        frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 6 } },
        selection: [{ entityId: '#1', points: { kind: 'frame' } }],
      }],
    });
    const decoded = decodeDynamicDefinition(payload, base);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.definition.parameters).toHaveLength(1);
      expect(decoded.definition.parameters[0]!.kind).toBe('linear-distance');
    }
  });
});
