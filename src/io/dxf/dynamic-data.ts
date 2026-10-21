/**
 * Priority 30.1 — the JCAD_DYNAMIC XDATA carrier: canonical serialization of JCad's
 * authored dynamic-block model (core/parametric) for DXF.
 *
 * Shape (ONE canonical JSON object per carrier, versioned from day one — a deliberate
 * deviation from JCAD_TABLE / JCAD_MTEXT_COLUMNS, which carry no version):
 *   definition, on the BLOCK record: {"v":1,"kind":"definition","parameters":[…],"actions":[…]}
 *   instance,   on the INSERT:       {"v":1,"kind":"instance","block":"<name>","values":{…}}
 * Instance values are sparse and tagged ({kind:'distance',value} | {kind:'angle',value} |
 * {kind:'flip',value} | {kind:'opaque',payload}); instance value keys are written sorted
 * by parameter id so the encoding is canonical.
 *
 * Model version stays 1 for the 30.2 kinds (angle/flip parameters; move/rotate/scale/flip
 * actions), the 30.2a visibility parameter + value, the 30.2b lookup parameter +
 * value (row key/assignment values reuse the tagged instance-value encoding; the
 * instance choice is {"kind":"lookup","value":<row name or null>}), the 30.2c
 * array action ({"kind":"array", selection refs in the existing #<ordinal>/tag
 * encoding, plus "spacing"}), and the 30.2e alignment spec (a TOP-LEVEL
 * "alignment" key on the definition object, NOT a parameters[] member —
 * design §6.2): they are additive
 * union members, as the design planned (§1.3, visibility design §6.2). A v1 payload written before
 * those slices contains only the earlier members and decodes identically; a payload
 * using the new kinds, read by an older build, fails that build's structural decode
 * and is retained verbatim — the designed fallback — instead of being half-modeled.
 * The version only moves when a member's shape changes.
 *
 * The alignment key is the one deliberate exception to "unknown member ⇒ retained":
 * it is a TOP-LEVEL key, and unknown top-level keys are ignored by the decoder
 * (design §6.1). An older build therefore decodes a definition carrying
 * "alignment" fully and evaluates it correctly (alignment passes the
 * inert-member test, design §4.1) — but DROPS the key if it re-saves, because
 * the encoder writes only modeled fields. That silent drop is accepted
 * deliberately (design §6.2): what is lost is placement convenience for a
 * future tool, never geometry, values, or evaluation correctness.
 *
 * Escaping decision (explicit, following the JCAD_TABLE variant in write-annotations.ts,
 * NOT the unescaped MTEXT-columns variant): the JSON text is escaped to 7-bit ASCII —
 * every character U+007F–U+FFFF becomes \uXXXX — before it is split into 250-character
 * group-1000 chunks, so a chunk never exceeds 250 bytes in any code page (the DXF limit
 * for a 1000 string is 255 bytes). JSON.parse on the reader side restores the original
 * characters. A RETAINED payload (malformed or newer-version data) is the exception:
 * it is stored and re-emitted verbatim, unescaped and unmodified, chunked at 250
 * characters — transforming it would break verbatim retention.
 *
 * Decode is total and never throws: any problem (bad JSON, wrong shape, a model version
 * other than the current one, or a validation issue from core/parametric) returns the
 * raw payload as `retained`, so the caller stores it on dynamicRetained and the block /
 * instance displays at its authored (static/default) state. Nothing is half-parsed,
 * clamped, snapped or repaired here.
 *
 * Entity references in action selections are the one place the payload does NOT carry
 * the model value verbatim: DXF does not preserve EntityBase.id (the reader assigns
 * fresh ids), so a selection naming a block entity is serialized as `#<index>` — the
 * entity's ordinal in BlockDef.entities, which write/read order preserves — while a
 * selection naming an attribute definition is serialized as its tag (tags are stable
 * names). Decode maps `#<index>` back to the freshly read entity's id, so the modeled
 * definition after a round-trip is exactly the authored one. (The evaluator resolves
 * an id as an entity first, then as an attribute tag; ordinal encoding preserves that
 * precedence even if an entity id and a tag collide.) The same `#<index>`/tag rule
 * applies to a visibility state's `visible` list (design §1.5): entity ids in the
 * list serialize as ordinals, attribute tags verbatim — so the ordinal map is
 * threaded into parameter encoding for the visibility kind.
 */
import type { Pair } from './groups';
import {
  DYNAMIC_MODEL_VERSION,
  validateDefinition,
  type AlignmentSpec,
  type AngleConstraint,
  type DistanceConstraint,
  type DynamicAction,
  type DynamicBlockDefinition,
  type DynamicParameter,
  type LookupRow,
  type ParameterGrip,
  type StretchAction,
  type VisibilityState,
  type WholeSelection,
} from '../../core/parametric/definitions';
import {
  validateInstanceValues,
  type DynamicInstanceState,
  type DynamicParameterValue,
} from '../../core/parametric/instance';

/** Import-report wording (design §4 / DXF-adapter audit §3.3): what is kept, in which
 *  carrier; what is not modeled; what other CAD programs show. */
export const DYNAMIC_DEFINITION_REPORT = 'dynamic-block definition is kept in JCAD_DYNAMIC for JCad reimport; native dynamic-block parameters and actions are not modeled, and other CAD programs show the static block';
export const DYNAMIC_DEFINITION_RETAINED_REPORT = 'dynamic-block definition data in JCAD_DYNAMIC could not be read (malformed or a newer version); the raw payload is retained for JCad re-export, and the block is imported as a static block';
export const DYNAMIC_INSTANCE_REPORT = 'dynamic-block parameter values are kept in JCAD_DYNAMIC for JCad reimport; native dynamic-block parameters and actions are not modeled, and other CAD programs show the static block';
export const DYNAMIC_INSTANCE_RETAINED_REPORT = 'dynamic-block parameter values in JCAD_DYNAMIC could not be read (malformed or a newer version); the raw payload is retained for JCad re-export, and the instance shows the static block';

// ---------------------------------------------------------------------------
// Encoding (model -> escaped JSON text -> 250-char chunks)
// ---------------------------------------------------------------------------

/** Escape a JSON text to 7-bit ASCII (\uXXXX), as the JCAD_TABLE writer does. */
export function escapeDynamicJson(json: string): string {
  return json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Split a payload into group-1000 chunks of at most 250 characters. */
export function chunkDynamicPayload(payload: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < payload.length; i += 250) out.push(payload.slice(i, i + 250));
  return out;
}

function encodeConstraint(c: DistanceConstraint): Record<string, unknown> {
  switch (c.kind) {
    case 'unbounded':
      return { kind: 'unbounded' };
    case 'range':
      return { kind: 'range', ...(c.min !== undefined ? { min: c.min } : {}), ...(c.max !== undefined ? { max: c.max } : {}) };
    case 'increment':
      return { kind: 'increment', min: c.min, max: c.max, increment: c.increment };
    case 'list':
      return { kind: 'list', values: [...c.values] };
  }
}

function encodeAngleConstraint(c: AngleConstraint): Record<string, unknown> {
  return c.kind === 'unbounded'
    ? { kind: 'unbounded' }
    : { kind: 'range', ...(c.min !== undefined ? { min: c.min } : {}), ...(c.max !== undefined ? { max: c.max } : {}) };
}

/** An entity reference for serialization: `#<index>` when it names a block entity
 *  (see header), the tag verbatim when it names an attribute definition. */
function encodeEntityRef(entityId: string, entityIdsInOrder?: readonly string[]): string {
  const index = entityIdsInOrder?.indexOf(entityId) ?? -1;
  return index >= 0 ? `#${index}` : entityId;
}

function encodeWholeSelection(selection: readonly WholeSelection[], entityIdsInOrder?: readonly string[]): { entityId: string }[] {
  return selection.map((sel) => ({ entityId: encodeEntityRef(sel.entityId, entityIdsInOrder) }));
}

/** One tagged parameter value, the same shape instance payloads use. */
function encodeValue(value: DynamicParameterValue): Record<string, unknown> {
  return value.kind === 'opaque' ? { kind: 'opaque', payload: value.payload } : { kind: value.kind, value: value.value };
}

/** A parameter-id -> value map (a lookup row's key or assignments), keys
 *  sorted by parameter id so the encoding is canonical, as for instances. */
function encodeValueMap(map: Readonly<Record<string, DynamicParameterValue>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of Object.keys(map).sort()) out[id] = encodeValue(map[id]!);
  return out;
}

function encodeParameter(p: DynamicParameter, entityIdsInOrder?: readonly string[]): Record<string, unknown> {
  switch (p.kind) {
    case 'opaque-parameter':
      return { kind: 'opaque-parameter', id: p.id, name: p.name, sourceKind: p.sourceKind, payload: p.payload };
    case 'linear-distance':
      return {
        kind: 'linear-distance',
        id: p.id,
        name: p.name,
        basePoint: { x: p.basePoint.x, y: p.basePoint.y },
        direction: { x: p.direction.x, y: p.direction.y },
        defaultValue: p.defaultValue,
        constraint: encodeConstraint(p.constraint),
        grips: p.grips.map((grip) => ({ role: grip.role, movesWithValue: grip.movesWithValue })),
      };
    case 'angle':
      return {
        kind: 'angle',
        id: p.id,
        name: p.name,
        basePoint: { x: p.basePoint.x, y: p.basePoint.y },
        defaultValue: p.defaultValue,
        constraint: encodeAngleConstraint(p.constraint),
        grips: p.grips.map((grip) => ({ role: grip.role, movesWithValue: grip.movesWithValue })),
      };
    case 'flip':
      return {
        kind: 'flip',
        id: p.id,
        name: p.name,
        basePoint: { x: p.basePoint.x, y: p.basePoint.y },
        defaultValue: p.defaultValue,
      };
    case 'visibility':
      return {
        kind: 'visibility',
        id: p.id,
        name: p.name,
        basePoint: { x: p.basePoint.x, y: p.basePoint.y },
        defaultState: p.defaultState,
        states: p.states.map((s) => ({
          name: s.name,
          visible: s.visible.map((ref) => encodeEntityRef(ref, entityIdsInOrder)),
        })),
      };
    case 'lookup':
      return {
        kind: 'lookup',
        id: p.id,
        name: p.name,
        basePoint: { x: p.basePoint.x, y: p.basePoint.y },
        inputs: [...p.inputs],
        defaultRow: p.defaultRow,
        rows: p.rows.map((r) => ({ name: r.name, key: encodeValueMap(r.key), assignments: encodeValueMap(r.assignments) })),
      };
  }
}

function encodeAction(a: DynamicAction, entityIdsInOrder?: readonly string[]): Record<string, unknown> {
  const base = { id: a.id, name: a.name, parameterId: a.parameterId };
  switch (a.kind) {
    case 'opaque-action':
      return { kind: 'opaque-action', ...base, sourceKind: a.sourceKind, payload: a.payload };
    case 'stretch':
      return {
        kind: 'stretch',
        ...base,
        frame: { kind: 'rectangle', min: { x: a.frame.min.x, y: a.frame.min.y }, max: { x: a.frame.max.x, y: a.frame.max.y } },
        selection: a.selection.map((sel) => ({
          entityId: encodeEntityRef(sel.entityId, entityIdsInOrder),
          points: sel.points.kind === 'frame' ? { kind: 'frame' } : { kind: 'points', indices: [...sel.points.indices] },
        })),
        ...(a.distanceMultiplier !== undefined ? { distanceMultiplier: a.distanceMultiplier } : {}),
        ...(a.angleOffset !== undefined ? { angleOffset: a.angleOffset } : {}),
      };
    case 'move':
      return {
        kind: 'move',
        ...base,
        selection: encodeWholeSelection(a.selection, entityIdsInOrder),
        ...(a.distanceMultiplier !== undefined ? { distanceMultiplier: a.distanceMultiplier } : {}),
        ...(a.angleOffset !== undefined ? { angleOffset: a.angleOffset } : {}),
      };
    case 'rotate':
      return {
        kind: 'rotate',
        ...base,
        center: { x: a.center.x, y: a.center.y },
        selection: encodeWholeSelection(a.selection, entityIdsInOrder),
      };
    case 'scale':
      return {
        kind: 'scale',
        ...base,
        basePoint: { x: a.basePoint.x, y: a.basePoint.y },
        selection: encodeWholeSelection(a.selection, entityIdsInOrder),
      };
    case 'flip':
      return {
        kind: 'flip',
        ...base,
        axisA: { x: a.axisA.x, y: a.axisA.y },
        axisB: { x: a.axisB.x, y: a.axisB.y },
        selection: encodeWholeSelection(a.selection, entityIdsInOrder),
      };
    case 'array':
      return {
        kind: 'array',
        ...base,
        selection: encodeWholeSelection(a.selection, entityIdsInOrder),
        spacing: a.spacing,
      };
  }
}

/**
 * Canonical escaped JSON text for a definition payload (chunk with chunkDynamicPayload).
 * `entityIdsInOrder` is the owning block's entity ids in BlockDef order, used to
 * serialize entity selections by ordinal; without it selections are written verbatim
 * (only correct for payloads that will be decoded without a block context).
 */
export function encodeDynamicDefinition(definition: DynamicBlockDefinition, entityIdsInOrder?: readonly string[]): string {
  return escapeDynamicJson(JSON.stringify({
    v: DYNAMIC_MODEL_VERSION,
    kind: 'definition',
    parameters: definition.parameters.map((p) => encodeParameter(p, entityIdsInOrder)),
    actions: definition.actions.map((a) => encodeAction(a, entityIdsInOrder)),
    // Top-level key, NOT a parameters[] member (design §6.2): an older build
    // ignores it on decode and drops it on re-save — the documented downgrade.
    ...(definition.alignment !== undefined
      ? {
          alignment: {
            basePoint: { x: definition.alignment.basePoint.x, y: definition.alignment.basePoint.y },
            direction: { x: definition.alignment.direction.x, y: definition.alignment.direction.y },
            mode: definition.alignment.mode,
          },
        }
      : {}),
  }));
}

/** Canonical escaped JSON text for an instance payload (chunk with chunkDynamicPayload). */
export function encodeDynamicInstance(state: DynamicInstanceState): string {
  const values: Record<string, unknown> = {};
  for (const id of Object.keys(state.values).sort()) {
    values[id] = encodeValue(state.values[id]!);
  }
  return escapeDynamicJson(JSON.stringify({ v: DYNAMIC_MODEL_VERSION, kind: 'instance', block: state.block, values }));
}

/** The raw payload text of one XDATA application: its group-1000 values joined. */
export function dynamicPayloadText(pairs: readonly Pair[]): string {
  return pairs.filter((p) => p.code === 1000).map((p) => p.value).join('');
}

// ---------------------------------------------------------------------------
// Decoding (raw payload text -> model, or retained verbatim)
// ---------------------------------------------------------------------------

export type DynamicDefinitionDecode =
  | { readonly ok: true; readonly definition: DynamicBlockDefinition }
  | { readonly ok: false; readonly retained: string };

export type DynamicInstanceDecode =
  | { readonly ok: true; readonly state: DynamicInstanceState }
  | { readonly ok: false; readonly retained: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPoint = (v: unknown): v is { x: number; y: number } => isRecord(v) && isFiniteNumber(v.x) && isFiniteNumber(v.y);

function decodeConstraint(raw: unknown): DistanceConstraint | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.kind) {
    case 'unbounded':
      return { kind: 'unbounded' };
    case 'range': {
      if (raw.min !== undefined && !isFiniteNumber(raw.min)) return undefined;
      if (raw.max !== undefined && !isFiniteNumber(raw.max)) return undefined;
      return { kind: 'range', ...(raw.min !== undefined ? { min: raw.min as number } : {}), ...(raw.max !== undefined ? { max: raw.max as number } : {}) };
    }
    case 'increment':
      return isFiniteNumber(raw.min) && isFiniteNumber(raw.max) && isFiniteNumber(raw.increment)
        ? { kind: 'increment', min: raw.min, max: raw.max, increment: raw.increment }
        : undefined;
    case 'list':
      return Array.isArray(raw.values) && raw.values.every(isFiniteNumber) ? { kind: 'list', values: [...raw.values] } : undefined;
    default:
      return undefined;
  }
}

function decodeAngleConstraint(raw: unknown): AngleConstraint | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === 'unbounded') return { kind: 'unbounded' };
  if (raw.kind !== 'range') return undefined;
  if (raw.min !== undefined && !isFiniteNumber(raw.min)) return undefined;
  if (raw.max !== undefined && !isFiniteNumber(raw.max)) return undefined;
  return { kind: 'range', ...(raw.min !== undefined ? { min: raw.min as number } : {}), ...(raw.max !== undefined ? { max: raw.max as number } : {}) };
}

/** One tagged parameter value (instance values, lookup row keys/assignments). */
function decodeValue(raw: unknown): DynamicParameterValue | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === 'distance' && isFiniteNumber(raw.value)) return { kind: 'distance', value: raw.value };
  if (raw.kind === 'angle' && isFiniteNumber(raw.value)) return { kind: 'angle', value: raw.value };
  if (raw.kind === 'flip' && typeof raw.value === 'boolean') return { kind: 'flip', value: raw.value };
  if (raw.kind === 'visibility' && typeof raw.value === 'string') return { kind: 'visibility', value: raw.value };
  if (raw.kind === 'lookup' && (typeof raw.value === 'string' || raw.value === null)) return { kind: 'lookup', value: raw.value };
  if (raw.kind === 'opaque' && typeof raw.payload === 'string') return { kind: 'opaque', payload: raw.payload };
  return undefined;
}

/** A parameter-id -> value map (a lookup row's key or assignments). */
function decodeValueMap(raw: unknown): Record<string, DynamicParameterValue> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, DynamicParameterValue> = {};
  for (const [id, value] of Object.entries(raw)) {
    const decoded = decodeValue(value);
    if (!decoded) return undefined;
    out[id] = decoded;
  }
  return out;
}

function decodeGrips(raw: unknown): ParameterGrip[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const grips: ParameterGrip[] = [];
  for (const grip of raw) {
    if (!isRecord(grip) || (grip.role !== 'base' && grip.role !== 'value') || typeof grip.movesWithValue !== 'boolean') return undefined;
    grips.push({ role: grip.role, movesWithValue: grip.movesWithValue });
  }
  return grips;
}

/** Map an ordinal entity reference (`#<index>`) back to the read entity's id;
 *  any other reference (an attribute tag) passes through verbatim. */
function resolveEntityRef(entityId: string, entityIdsInOrder?: readonly string[]): string | undefined {
  if (!entityId.startsWith('#')) return entityId;
  const index = Number(entityId.slice(1));
  if (!entityIdsInOrder || !Number.isInteger(index) || index < 0 || index >= entityIdsInOrder.length) return undefined;
  return entityIdsInOrder[index]!;
}

function decodeWholeSelection(raw: unknown, entityIdsInOrder?: readonly string[]): WholeSelection[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const selection: WholeSelection[] = [];
  for (const sel of raw) {
    if (!isRecord(sel) || typeof sel.entityId !== 'string') return undefined;
    const entityId = resolveEntityRef(sel.entityId, entityIdsInOrder);
    if (entityId === undefined) return undefined;
    selection.push({ entityId });
  }
  return selection;
}

function decodeParameter(raw: unknown, entityIdsInOrder?: readonly string[]): DynamicParameter | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') return undefined;
  if (raw.kind === 'opaque-parameter') {
    return typeof raw.sourceKind === 'string' && typeof raw.payload === 'string'
      ? { kind: 'opaque-parameter', id: raw.id, name: raw.name, sourceKind: raw.sourceKind, payload: raw.payload }
      : undefined;
  }
  if (raw.kind === 'visibility') {
    if (!isPoint(raw.basePoint) || typeof raw.defaultState !== 'string' || !Array.isArray(raw.states)) return undefined;
    const states: VisibilityState[] = [];
    for (const s of raw.states) {
      if (!isRecord(s) || typeof s.name !== 'string' || !Array.isArray(s.visible)) return undefined;
      const visible: string[] = [];
      for (const ref of s.visible) {
        if (typeof ref !== 'string') return undefined;
        // Entity ids resolve from `#<index>` ordinals; attribute tags pass
        // through verbatim. An unresolvable ordinal retains the whole payload.
        const resolved = resolveEntityRef(ref, entityIdsInOrder);
        if (resolved === undefined) return undefined;
        visible.push(resolved);
      }
      states.push({ name: s.name, visible });
    }
    return {
      kind: 'visibility',
      id: raw.id,
      name: raw.name,
      basePoint: { x: raw.basePoint.x, y: raw.basePoint.y },
      defaultState: raw.defaultState,
      states,
    };
  }
  if (raw.kind === 'lookup') {
    if (!isPoint(raw.basePoint)) return undefined;
    if (!Array.isArray(raw.inputs) || !raw.inputs.every((i) => typeof i === 'string')) return undefined;
    if (raw.defaultRow !== null && typeof raw.defaultRow !== 'string') return undefined;
    if (!Array.isArray(raw.rows)) return undefined;
    const rows: LookupRow[] = [];
    for (const r of raw.rows) {
      if (!isRecord(r) || typeof r.name !== 'string') return undefined;
      const key = decodeValueMap(r.key);
      const assignments = decodeValueMap(r.assignments);
      if (!key || !assignments) return undefined;
      rows.push({ name: r.name, key, assignments });
    }
    return {
      kind: 'lookup',
      id: raw.id,
      name: raw.name,
      basePoint: { x: raw.basePoint.x, y: raw.basePoint.y },
      inputs: [...raw.inputs] as string[],
      defaultRow: raw.defaultRow as string | null,
      rows,
    };
  }
  if (raw.kind === 'flip') {
    if (!isPoint(raw.basePoint) || typeof raw.defaultValue !== 'boolean') return undefined;
    return {
      kind: 'flip',
      id: raw.id,
      name: raw.name,
      basePoint: { x: raw.basePoint.x, y: raw.basePoint.y },
      defaultValue: raw.defaultValue,
    };
  }
  if (raw.kind === 'angle') {
    if (!isPoint(raw.basePoint) || !isFiniteNumber(raw.defaultValue)) return undefined;
    const constraint = decodeAngleConstraint(raw.constraint);
    if (!constraint) return undefined;
    const grips = decodeGrips(raw.grips);
    if (!grips) return undefined;
    return {
      kind: 'angle',
      id: raw.id,
      name: raw.name,
      basePoint: { x: raw.basePoint.x, y: raw.basePoint.y },
      defaultValue: raw.defaultValue,
      constraint,
      grips,
    };
  }
  if (raw.kind !== 'linear-distance') return undefined;
  if (!isPoint(raw.basePoint) || !isPoint(raw.direction) || !isFiniteNumber(raw.defaultValue)) return undefined;
  const constraint = decodeConstraint(raw.constraint);
  if (!constraint) return undefined;
  const grips = decodeGrips(raw.grips);
  if (!grips) return undefined;
  return {
    kind: 'linear-distance',
    id: raw.id,
    name: raw.name,
    basePoint: { x: raw.basePoint.x, y: raw.basePoint.y },
    direction: { x: raw.direction.x, y: raw.direction.y },
    defaultValue: raw.defaultValue,
    constraint,
    grips,
  };
}

function decodeAction(raw: unknown, entityIdsInOrder?: readonly string[]): DynamicAction | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.parameterId !== 'string') return undefined;
  const base = { id: raw.id, name: raw.name, parameterId: raw.parameterId };
  if (raw.kind === 'opaque-action') {
    return typeof raw.sourceKind === 'string' && typeof raw.payload === 'string'
      ? { kind: 'opaque-action', ...base, sourceKind: raw.sourceKind, payload: raw.payload }
      : undefined;
  }
  if (raw.kind === 'move') {
    if (raw.distanceMultiplier !== undefined && !isFiniteNumber(raw.distanceMultiplier)) return undefined;
    if (raw.angleOffset !== undefined && !isFiniteNumber(raw.angleOffset)) return undefined;
    const selection = decodeWholeSelection(raw.selection, entityIdsInOrder);
    if (!selection) return undefined;
    return {
      kind: 'move',
      ...base,
      selection,
      ...(raw.distanceMultiplier !== undefined ? { distanceMultiplier: raw.distanceMultiplier as number } : {}),
      ...(raw.angleOffset !== undefined ? { angleOffset: raw.angleOffset as number } : {}),
    };
  }
  if (raw.kind === 'rotate') {
    if (!isPoint(raw.center)) return undefined;
    const selection = decodeWholeSelection(raw.selection, entityIdsInOrder);
    if (!selection) return undefined;
    return { kind: 'rotate', ...base, center: { x: raw.center.x, y: raw.center.y }, selection };
  }
  if (raw.kind === 'scale') {
    if (!isPoint(raw.basePoint)) return undefined;
    const selection = decodeWholeSelection(raw.selection, entityIdsInOrder);
    if (!selection) return undefined;
    return { kind: 'scale', ...base, basePoint: { x: raw.basePoint.x, y: raw.basePoint.y }, selection };
  }
  if (raw.kind === 'flip') {
    if (!isPoint(raw.axisA) || !isPoint(raw.axisB)) return undefined;
    const selection = decodeWholeSelection(raw.selection, entityIdsInOrder);
    if (!selection) return undefined;
    return {
      kind: 'flip',
      ...base,
      axisA: { x: raw.axisA.x, y: raw.axisA.y },
      axisB: { x: raw.axisB.x, y: raw.axisB.y },
      selection,
    };
  }
  if (raw.kind === 'array') {
    if (!isFiniteNumber(raw.spacing)) return undefined;
    const selection = decodeWholeSelection(raw.selection, entityIdsInOrder);
    if (!selection) return undefined;
    return { kind: 'array', ...base, selection, spacing: raw.spacing as number };
  }
  if (raw.kind !== 'stretch') return undefined;
  if (!isRecord(raw.frame) || raw.frame.kind !== 'rectangle' || !isPoint(raw.frame.min) || !isPoint(raw.frame.max)) return undefined;
  if (!Array.isArray(raw.selection)) return undefined;
  const selection: StretchAction['selection'][number][] = [];
  for (const sel of raw.selection) {
    if (!isRecord(sel) || typeof sel.entityId !== 'string' || !isRecord(sel.points)) return undefined;
    // Map an ordinal entity reference (`#<index>`) back to the read entity's id.
    const entityId = resolveEntityRef(sel.entityId, entityIdsInOrder);
    if (entityId === undefined) return undefined;
    if (sel.points.kind === 'frame') selection.push({ entityId, points: { kind: 'frame' } });
    else if (sel.points.kind === 'points' && Array.isArray(sel.points.indices) && sel.points.indices.every((i) => typeof i === 'number')) {
      selection.push({ entityId, points: { kind: 'points', indices: [...sel.points.indices] } });
    } else return undefined;
  }
  if (raw.distanceMultiplier !== undefined && !isFiniteNumber(raw.distanceMultiplier)) return undefined;
  if (raw.angleOffset !== undefined && !isFiniteNumber(raw.angleOffset)) return undefined;
  return {
    kind: 'stretch',
    ...base,
    frame: { kind: 'rectangle', min: { x: raw.frame.min.x, y: raw.frame.min.y }, max: { x: raw.frame.max.x, y: raw.frame.max.y } },
    selection,
    ...(raw.distanceMultiplier !== undefined ? { distanceMultiplier: raw.distanceMultiplier as number } : {}),
    ...(raw.angleOffset !== undefined ? { angleOffset: raw.angleOffset as number } : {}),
  };
}

/** The top-level "alignment" key (design §4.2/§6.2). Structural decode only:
 *  point finiteness is checked here (isPoint); the non-zero-direction rule is
 *  validateDefinition's, applied by the caller exactly as for parameters. */
function decodeAlignment(raw: unknown): AlignmentSpec | undefined {
  if (!isRecord(raw) || !isPoint(raw.basePoint) || !isPoint(raw.direction)) return undefined;
  if (raw.mode !== 'perpendicular' && raw.mode !== 'tangent') return undefined;
  return {
    basePoint: { x: raw.basePoint.x, y: raw.basePoint.y },
    direction: { x: raw.direction.x, y: raw.direction.y },
    mode: raw.mode,
  };
}

function parsePayload(raw: string, kind: 'definition' | 'instance'): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  // A payload of any other model version — newer or older — is never guessed at.
  if (parsed.v !== DYNAMIC_MODEL_VERSION || parsed.kind !== kind) return undefined;
  return parsed;
}

/** The owning block's identity space for decode: entity ids in BlockDef order
 *  (ordinal references resolve against it) plus attribute tags (validation set). */
export interface DynamicDefinitionBase {
  readonly entityIdsInOrder: readonly string[];
  readonly attributeTags?: ReadonlySet<string>;
}

/**
 * Decode a definition payload. When `base` is supplied, ordinal selection references
 * are resolved against it and the decoded definition must also pass
 * validateDefinition (against entity ids + attribute tags); any issue retains the
 * payload instead of modeling it.
 */
export function decodeDynamicDefinition(raw: string, base?: DynamicDefinitionBase): DynamicDefinitionDecode {
  const retained: DynamicDefinitionDecode = { ok: false, retained: raw };
  const parsed = parsePayload(raw, 'definition');
  if (!parsed || !Array.isArray(parsed.parameters) || !Array.isArray(parsed.actions)) return retained;
  const parameters: DynamicParameter[] = [];
  for (const p of parsed.parameters) {
    const decoded = decodeParameter(p, base?.entityIdsInOrder);
    if (!decoded) return retained;
    parameters.push(decoded);
  }
  const actions: DynamicAction[] = [];
  for (const a of parsed.actions) {
    const decoded = decodeAction(a, base?.entityIdsInOrder);
    if (!decoded) return retained;
    actions.push(decoded);
  }
  // The alignment key is optional and top-level (design §6.2). Present but
  // malformed retains the whole payload, like any other modeled member.
  let alignment: AlignmentSpec | undefined;
  if (parsed.alignment !== undefined) {
    alignment = decodeAlignment(parsed.alignment);
    if (!alignment) return retained;
  }
  const definition: DynamicBlockDefinition = {
    version: DYNAMIC_MODEL_VERSION,
    parameters,
    actions,
    ...(alignment !== undefined ? { alignment } : {}),
  };
  if (base) {
    const baseIds = new Set<string>([...base.entityIdsInOrder, ...(base.attributeTags ?? [])]);
    if (validateDefinition(definition, baseIds).length > 0) return retained;
  }
  return { ok: true, definition };
}

/**
 * Decode an instance payload. With a definition, the values must also pass
 * validateInstanceValues (with the block-mismatch check when `blockName` is supplied);
 * any issue retains the payload. Without a definition only the canonical structure is
 * checked — the caller decides whether values without a modeled definition may be
 * modeled at all (see read-entities.ts: values for a block whose definition is absent
 * or itself retained are retained, never modeled).
 */
export function decodeDynamicInstance(raw: string, definition?: DynamicBlockDefinition, blockName?: string): DynamicInstanceDecode {
  const retained: DynamicInstanceDecode = { ok: false, retained: raw };
  const parsed = parsePayload(raw, 'instance');
  if (!parsed || typeof parsed.block !== 'string' || !isRecord(parsed.values)) return retained;
  const values: Record<string, DynamicParameterValue> = {};
  for (const [id, value] of Object.entries(parsed.values)) {
    const decoded = decodeValue(value);
    if (!decoded) return retained;
    values[id] = decoded;
  }
  const state: DynamicInstanceState = { block: parsed.block, values };
  if (definition && !validateInstanceValues(definition, state, blockName).ok) return retained;
  return { ok: true, state };
}
