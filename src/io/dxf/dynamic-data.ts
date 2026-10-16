/**
 * Priority 30.1 — the JCAD_DYNAMIC XDATA carrier: canonical serialization of JCad's
 * authored dynamic-block model (core/parametric) for DXF.
 *
 * Shape (ONE canonical JSON object per carrier, versioned from day one — a deliberate
 * deviation from JCAD_TABLE / JCAD_MTEXT_COLUMNS, which carry no version):
 *   definition, on the BLOCK record: {"v":1,"kind":"definition","parameters":[…],"actions":[…]}
 *   instance,   on the INSERT:       {"v":1,"kind":"instance","block":"<name>","values":{…}}
 * Instance values are sparse and tagged ({kind:'distance',value} | {kind:'opaque',payload});
 * instance value keys are written sorted by parameter id so the encoding is canonical.
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
 */
import type { Pair } from './groups';
import {
  DYNAMIC_MODEL_VERSION,
  validateDefinition,
  type DistanceConstraint,
  type DynamicAction,
  type DynamicBlockDefinition,
  type DynamicParameter,
  type LinearDistanceParameter,
  type StretchAction,
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

function encodeParameter(p: DynamicParameter): Record<string, unknown> {
  if (p.kind === 'opaque-parameter') {
    return { kind: 'opaque-parameter', id: p.id, name: p.name, sourceKind: p.sourceKind, payload: p.payload };
  }
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
}

function encodeAction(a: DynamicAction): Record<string, unknown> {
  if (a.kind === 'opaque-action') {
    return { kind: 'opaque-action', id: a.id, name: a.name, parameterId: a.parameterId, sourceKind: a.sourceKind, payload: a.payload };
  }
  return {
    kind: 'stretch',
    id: a.id,
    name: a.name,
    parameterId: a.parameterId,
    frame: { kind: 'rectangle', min: { x: a.frame.min.x, y: a.frame.min.y }, max: { x: a.frame.max.x, y: a.frame.max.y } },
    selection: a.selection.map((sel) => ({
      entityId: sel.entityId,
      points: sel.points.kind === 'frame' ? { kind: 'frame' } : { kind: 'points', indices: [...sel.points.indices] },
    })),
    ...(a.distanceMultiplier !== undefined ? { distanceMultiplier: a.distanceMultiplier } : {}),
    ...(a.angleOffset !== undefined ? { angleOffset: a.angleOffset } : {}),
  };
}

/** Canonical escaped JSON text for a definition payload (chunk with chunkDynamicPayload). */
export function encodeDynamicDefinition(definition: DynamicBlockDefinition): string {
  return escapeDynamicJson(JSON.stringify({
    v: DYNAMIC_MODEL_VERSION,
    kind: 'definition',
    parameters: definition.parameters.map(encodeParameter),
    actions: definition.actions.map(encodeAction),
  }));
}

/** Canonical escaped JSON text for an instance payload (chunk with chunkDynamicPayload). */
export function encodeDynamicInstance(state: DynamicInstanceState): string {
  const values: Record<string, unknown> = {};
  for (const id of Object.keys(state.values).sort()) {
    const value = state.values[id]!;
    values[id] = value.kind === 'distance' ? { kind: 'distance', value: value.value } : { kind: 'opaque', payload: value.payload };
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

function decodeParameter(raw: unknown): DynamicParameter | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') return undefined;
  if (raw.kind === 'opaque-parameter') {
    return typeof raw.sourceKind === 'string' && typeof raw.payload === 'string'
      ? { kind: 'opaque-parameter', id: raw.id, name: raw.name, sourceKind: raw.sourceKind, payload: raw.payload }
      : undefined;
  }
  if (raw.kind !== 'linear-distance') return undefined;
  if (!isPoint(raw.basePoint) || !isPoint(raw.direction) || !isFiniteNumber(raw.defaultValue)) return undefined;
  const constraint = decodeConstraint(raw.constraint);
  if (!constraint) return undefined;
  if (!Array.isArray(raw.grips)) return undefined;
  const grips: LinearDistanceParameter['grips'][number][] = [];
  for (const grip of raw.grips) {
    if (!isRecord(grip) || (grip.role !== 'base' && grip.role !== 'value') || typeof grip.movesWithValue !== 'boolean') return undefined;
    grips.push({ role: grip.role, movesWithValue: grip.movesWithValue });
  }
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

function decodeAction(raw: unknown): DynamicAction | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.parameterId !== 'string') return undefined;
  const base = { id: raw.id, name: raw.name, parameterId: raw.parameterId };
  if (raw.kind === 'opaque-action') {
    return typeof raw.sourceKind === 'string' && typeof raw.payload === 'string'
      ? { kind: 'opaque-action', ...base, sourceKind: raw.sourceKind, payload: raw.payload }
      : undefined;
  }
  if (raw.kind !== 'stretch') return undefined;
  if (!isRecord(raw.frame) || raw.frame.kind !== 'rectangle' || !isPoint(raw.frame.min) || !isPoint(raw.frame.max)) return undefined;
  if (!Array.isArray(raw.selection)) return undefined;
  const selection: StretchAction['selection'][number][] = [];
  for (const sel of raw.selection) {
    if (!isRecord(sel) || typeof sel.entityId !== 'string' || !isRecord(sel.points)) return undefined;
    if (sel.points.kind === 'frame') selection.push({ entityId: sel.entityId, points: { kind: 'frame' } });
    else if (sel.points.kind === 'points' && Array.isArray(sel.points.indices) && sel.points.indices.every((i) => typeof i === 'number')) {
      selection.push({ entityId: sel.entityId, points: { kind: 'points', indices: [...sel.points.indices] } });
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

/**
 * Decode a definition payload. When `baseEntityIds` is supplied (the ids of the owning
 * block's entities plus its attribute tags), the decoded definition must also pass
 * validateDefinition; any issue retains the payload instead of modeling it.
 */
export function decodeDynamicDefinition(raw: string, baseEntityIds?: ReadonlySet<string>): DynamicDefinitionDecode {
  const retained: DynamicDefinitionDecode = { ok: false, retained: raw };
  const parsed = parsePayload(raw, 'definition');
  if (!parsed || !Array.isArray(parsed.parameters) || !Array.isArray(parsed.actions)) return retained;
  const parameters: DynamicParameter[] = [];
  for (const p of parsed.parameters) {
    const decoded = decodeParameter(p);
    if (!decoded) return retained;
    parameters.push(decoded);
  }
  const actions: DynamicAction[] = [];
  for (const a of parsed.actions) {
    const decoded = decodeAction(a);
    if (!decoded) return retained;
    actions.push(decoded);
  }
  const definition: DynamicBlockDefinition = { version: DYNAMIC_MODEL_VERSION, parameters, actions };
  if (baseEntityIds && validateDefinition(definition, baseEntityIds).length > 0) return retained;
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
    if (!isRecord(value)) return retained;
    if (value.kind === 'distance' && isFiniteNumber(value.value)) values[id] = { kind: 'distance', value: value.value };
    else if (value.kind === 'opaque' && typeof value.payload === 'string') values[id] = { kind: 'opaque', payload: value.payload };
    else return retained;
  }
  const state: DynamicInstanceState = { block: parsed.block, values };
  if (definition && !validateInstanceValues(definition, state, blockName).ok) return retained;
  return { ok: true, state };
}
