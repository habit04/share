import {
  AI_DRAFT_MAX_AFFECTED,
  AI_DRAFT_MAX_COORDINATE,
  AI_DRAFT_MAX_CREATED,
  AI_DRAFT_MAX_DIMENSION,
  AI_DRAFT_MAX_MESSAGE_CHARS,
  AI_DRAFT_MAX_OPERATIONS,
  AI_DRAFT_MAX_TARGETS_PER_OP,
} from './limits';

/**
 * The milestone-3 plan contract (docs/AI-ASSISTANT-M3.md): a bounded,
 * versioned, provider-neutral operation plan. The provider returns data in
 * exactly this shape; local validation here is authoritative for both live
 * providers and the offline fixtures. Nothing executable exists in the
 * schema: no code, command strings, file paths, entity replacements or
 * property patches.
 */

export interface AiPlanPoint {
  readonly x: number;
  readonly y: number;
}

export type AiPlanOperation =
  | { readonly op: 'createLine'; readonly a: AiPlanPoint; readonly b: AiPlanPoint; readonly layer: string | null }
  | { readonly op: 'createCircle'; readonly center: AiPlanPoint; readonly radius: number; readonly layer: string | null }
  | { readonly op: 'createRectangle'; readonly origin: AiPlanPoint; readonly width: number; readonly height: number; readonly rotationDeg: number | null; readonly layer: string | null }
  | { readonly op: 'move'; readonly targetIds: readonly string[]; readonly dx: number; readonly dy: number }
  | { readonly op: 'copy'; readonly targetIds: readonly string[]; readonly dx: number; readonly dy: number }
  | { readonly op: 'rotate'; readonly targetIds: readonly string[]; readonly pivot: AiPlanPoint; readonly angleDeg: number }
  | { readonly op: 'delete'; readonly targetIds: readonly string[] };

export interface AiPlan {
  readonly message: string | null;
  readonly operations: readonly AiPlanOperation[];
}

/** A provider's draft response after local validation. */
export type AiDraftResponse =
  | { readonly kind: 'plan'; readonly plan: AiPlan }
  | { readonly kind: 'clarification'; readonly message: string }
  | { readonly kind: 'unsupported'; readonly message: string };

const TOP_KEYS: ReadonlySet<string> = new Set(['outcome', 'message', 'operations']);
const OP_KEYS: ReadonlySet<string> = new Set([
  'op', 'a', 'b', 'center', 'radius', 'origin', 'width', 'height', 'rotationDeg',
  'layer', 'targetIds', 'dx', 'dy', 'pivot', 'angleDeg',
]);
const ID_MAX_CHARS = 512;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function parsePoint(v: unknown): AiPlanPoint | null {
  if (!isRecord(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 2 || typeof v.x !== 'number' || typeof v.y !== 'number') return null;
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
  if (Math.abs(v.x) > AI_DRAFT_MAX_COORDINATE || Math.abs(v.y) > AI_DRAFT_MAX_COORDINATE) return null;
  return { x: v.x, y: v.y };
}

function parseDimension(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v <= 0 || v > AI_DRAFT_MAX_DIMENSION) return null;
  return v;
}

function parseFinite(v: unknown, maxAbs: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > maxAbs) return null;
  return v;
}

function parseLayer(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length === 0 || v.length > 512) return undefined;
  return v;
}

function parseTargets(v: unknown): readonly string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > AI_DRAFT_MAX_TARGETS_PER_OP) return null;
  const seen = new Set<string>();
  for (const id of v) {
    if (typeof id !== 'string' || id.length === 0 || id.length > ID_MAX_CHARS) return null;
    if (seen.has(id)) return null;
    seen.add(id);
  }
  return v as string[];
}

/** Fields that must be null for each op (non-null = misplaced data). */
const NULL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  createLine: ['center', 'radius', 'origin', 'width', 'height', 'rotationDeg', 'targetIds', 'dx', 'dy', 'pivot', 'angleDeg'],
  createCircle: ['a', 'b', 'origin', 'width', 'height', 'rotationDeg', 'targetIds', 'dx', 'dy', 'pivot', 'angleDeg'],
  createRectangle: ['a', 'b', 'center', 'radius', 'targetIds', 'dx', 'dy', 'pivot', 'angleDeg'],
  move: ['a', 'b', 'center', 'radius', 'origin', 'width', 'height', 'rotationDeg', 'layer', 'pivot', 'angleDeg'],
  copy: ['a', 'b', 'center', 'radius', 'origin', 'width', 'height', 'rotationDeg', 'layer', 'pivot', 'angleDeg'],
  rotate: ['a', 'b', 'center', 'radius', 'origin', 'width', 'height', 'rotationDeg', 'layer', 'dx', 'dy'],
  delete: ['a', 'b', 'center', 'radius', 'origin', 'width', 'height', 'rotationDeg', 'layer', 'dx', 'dy', 'pivot', 'angleDeg'],
};

function parseOperation(raw: unknown): AiPlanOperation | null {
  if (!isRecord(raw)) return null;
  for (const key of Object.keys(raw)) if (!OP_KEYS.has(key)) return null;
  const op = raw.op;
  if (typeof op !== 'string' || !(op in NULL_FIELDS)) return null;
  for (const field of NULL_FIELDS[op]!) if (raw[field] !== null && raw[field] !== undefined) return null;
  switch (op) {
    case 'createLine': {
      const a = parsePoint(raw.a);
      const b = parsePoint(raw.b);
      const layer = parseLayer(raw.layer);
      if (!a || !b || layer === undefined) return null;
      if (a.x === b.x && a.y === b.y) return null; // zero-length line
      return { op, a, b, layer };
    }
    case 'createCircle': {
      const center = parsePoint(raw.center);
      const radius = parseDimension(raw.radius);
      const layer = parseLayer(raw.layer);
      if (!center || radius === null || layer === undefined) return null;
      return { op, center, radius, layer };
    }
    case 'createRectangle': {
      const origin = parsePoint(raw.origin);
      const width = parseDimension(raw.width);
      const height = parseDimension(raw.height);
      let rotationDeg: number | null = null;
      if (raw.rotationDeg !== null && raw.rotationDeg !== undefined) {
        rotationDeg = parseFinite(raw.rotationDeg, 3600);
        if (rotationDeg === null) return null;
      }
      const layer = parseLayer(raw.layer);
      if (!origin || width === null || height === null || layer === undefined) return null;
      return { op, origin, width, height, rotationDeg, layer };
    }
    case 'move':
    case 'copy': {
      const targetIds = parseTargets(raw.targetIds);
      const dx = parseFinite(raw.dx, AI_DRAFT_MAX_COORDINATE);
      const dy = parseFinite(raw.dy, AI_DRAFT_MAX_COORDINATE);
      if (!targetIds || dx === null || dy === null) return null;
      if (dx === 0 && dy === 0) return null; // a no-op edit can never be staged
      return { op, targetIds, dx, dy };
    }
    case 'rotate': {
      const targetIds = parseTargets(raw.targetIds);
      const pivot = parsePoint(raw.pivot);
      const angleDeg = parseFinite(raw.angleDeg, 3600);
      if (!targetIds || !pivot || angleDeg === null) return null;
      if (((angleDeg % 360) + 360) % 360 === 0) return null; // no-op rotation
      return { op, targetIds, pivot, angleDeg };
    }
    case 'delete': {
      const targetIds = parseTargets(raw.targetIds);
      if (!targetIds) return null;
      return { op, targetIds };
    }
    default:
      return null;
  }
}

/**
 * Validate a provider's raw draft response value. Rejects unknown operations
 * and fields, invalid types, non-finite or out-of-range values, conflicting
 * targets (an id targeted by more than one edit operation) and excessive
 * counts. Eligibility/authorization of targets is the compiler's job.
 */
export function parseAiDraftResponse(value: unknown): { ok: true; response: AiDraftResponse } | { ok: false; error: string } {
  if (!isRecord(value)) return fail('The provider response was not an object.');
  for (const key of Object.keys(value)) if (!TOP_KEYS.has(key)) return fail('The provider response carried unexpected fields.');
  const outcome = value.outcome;
  if (outcome !== 'proposal' && outcome !== 'clarification' && outcome !== 'unsupported') {
    return fail('The provider response had an unknown outcome.');
  }
  const message = value.message;
  if (message !== null && message !== undefined && (typeof message !== 'string' || message.length > AI_DRAFT_MAX_MESSAGE_CHARS)) {
    return fail('The provider message was invalid.');
  }
  if (outcome !== 'proposal') {
    if (value.operations !== null && value.operations !== undefined) {
      return fail('A clarification or unsupported response must not carry operations.');
    }
    if (typeof message !== 'string' || message.length === 0) {
      return fail('The provider response did not explain itself.');
    }
    return { ok: true, response: { kind: outcome, message } };
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    return fail('The proposal carried no operations.');
  }
  if (value.operations.length > AI_DRAFT_MAX_OPERATIONS) {
    return fail('The proposal carried too many operations.');
  }
  const operations: AiPlanOperation[] = [];
  const targeted = new Set<string>();
  let affected = 0;
  let created = 0;
  for (const rawOp of value.operations) {
    const op = parseOperation(rawOp);
    if (!op) return fail('The proposal contained an invalid or unsupported operation.');
    if ('targetIds' in op) {
      affected += op.targetIds.length;
      if (op.op === 'copy') created += op.targetIds.length;
      for (const id of op.targetIds) {
        if (targeted.has(id)) return fail('The proposal targeted the same object in more than one operation.');
        targeted.add(id);
      }
    } else {
      created += 1;
    }
    operations.push(op);
  }
  if (affected > AI_DRAFT_MAX_AFFECTED) return fail('The proposal affected too many objects.');
  if (created > AI_DRAFT_MAX_CREATED) return fail('The proposal created too many objects.');
  return {
    ok: true,
    response: { kind: 'plan', plan: { message: typeof message === 'string' && message.length > 0 ? message : null, operations } },
  };
}
