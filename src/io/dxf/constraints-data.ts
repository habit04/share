/**
 * Priority 30.4 — the JCAD_CONSTRAINTS carrier: canonical serialization of
 * JCad's 2D constraint set (core/constraints) for DXF, following the
 * JCAD_DYNAMIC pattern in dynamic-data.ts.
 *
 * The carrier is DRAWING-level: one versioned JSON payload
 *   {"v":1,"kind":"constraints","constraints":[…]}
 * carried as XDATA (application JCAD_CONSTRAINTS) on the *Model_Space
 * BLOCK record — the one record every DXF has exactly once, and the same
 * attachment point JCAD_DYNAMIC uses on named BLOCK records. It is labeled
 * JCad-specific exactly like JCAD_TABLE / JCAD_MTEXT_COLUMNS / JCAD_3D:
 * it is NOT native AutoCAD constraint data (native constraints live in an
 * associative object graph this reader does not model), no native import
 * or export of constraints is claimed, and other CAD programs ignore the
 * XDATA and show the unconstrained geometry.
 *
 * Entity references: DXF does not preserve EntityBase.id (the reader
 * assigns fresh ids), so a ref's entityId is serialized as `#<index>` —
 * the entity's ordinal in DrawingState.entities, which write/read order
 * preserves — exactly the rule dynamic-data.ts uses for block selections.
 * Decode maps `#<index>` back to the freshly read entity's id. Constraint
 * ids are authored identities and are carried verbatim.
 *
 * Escaping/chunking reuse dynamic-data.ts: JSON escaped to 7-bit ASCII,
 * split into 250-character group-1000 chunks. A RETAINED payload is stored
 * and re-emitted verbatim, unescaped and unmodified.
 *
 * Decode is total and never throws: any problem (bad JSON, wrong shape, a
 * version other than the current one, an unresolvable ordinal, or a §4
 * validation problem against the read entities) returns the raw payload
 * as `retained`, so the caller stores it on DrawingState.
 * constraintsRetained — the set is then inactive, its edits/solves are
 * refused by core/constraints/apply.ts, and the geometry displays as
 * authored. Nothing is half-parsed, clamped, snapped or repaired here.
 */
import {
  DIMENSIONAL_KINDS,
  GEOMETRIC_KINDS,
  type AnchorKind,
  type Constraint,
  type ConstraintKind,
  type ConstraintSet,
} from '../../core/constraints/model';
import { validateConstraints } from '../../core/constraints/validate';
import type { Entity } from '../../core/entities';
import { escapeDynamicJson } from './dynamic-data';

/** Carrier format version. Independent of the constraint model: it moves
 *  only when a member's serialized shape changes. */
export const CONSTRAINTS_CARRIER_VERSION = 1;

/** Import-report wording: what is kept, in which carrier; what is not modeled. */
export const CONSTRAINTS_REPORT = 'drawing constraints are kept in JCAD_CONSTRAINTS for JCad reimport; native constraint data is not modeled, and other CAD programs show the geometry without constraints';
export const CONSTRAINTS_RETAINED_REPORT = 'drawing constraint data in JCAD_CONSTRAINTS could not be read (malformed or a newer version); the raw payload is retained for JCad re-export, and the drawing is imported without active constraints';

// ---------------------------------------------------------------------------
// Encoding (model -> escaped JSON text; chunk with dynamic-data's chunker)
// ---------------------------------------------------------------------------

function encodeEntityRef(entityId: string, entityIdsInOrder: readonly string[]): string {
  const index = entityIdsInOrder.indexOf(entityId);
  return index >= 0 ? `#${index}` : entityId;
}

/**
 * Canonical escaped JSON text for the constraint payload (chunk with
 * chunkDynamicPayload from dynamic-data.ts). `entityIdsInOrder` is
 * DrawingState.entities' ids in order; refs are written as `#<index>`
 * ordinals against it. A ref naming an entity outside the list is written
 * verbatim — decode then fails validation (missing-reference) and the
 * payload is retained rather than half-modeled.
 */
export function encodeConstraints(set: ConstraintSet, entityIdsInOrder: readonly string[]): string {
  return escapeDynamicJson(JSON.stringify({
    v: CONSTRAINTS_CARRIER_VERSION,
    kind: 'constraints',
    constraints: set.constraints.map((c) => ({
      id: c.id,
      kind: c.kind,
      role: c.role,
      refs: c.refs.map((r) => ({
        entityId: encodeEntityRef(r.entityId, entityIdsInOrder),
        anchor: r.anchor,
        ...(r.index !== undefined ? { index: r.index } : {}),
      })),
      ...(c.value !== undefined ? { value: c.value } : {}),
      ...(c.distanceMode !== undefined ? { distanceMode: c.distanceMode } : {}),
      ...(c.suppressed !== undefined ? { suppressed: c.suppressed } : {}),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Decoding (raw payload text -> model, or retained verbatim)
// ---------------------------------------------------------------------------

export type ConstraintsDecode =
  | { readonly ok: true; readonly set: ConstraintSet }
  | { readonly ok: false; readonly retained: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const CONSTRAINT_KINDS: ReadonlySet<string> = new Set([...GEOMETRIC_KINDS, ...DIMENSIONAL_KINDS]);
const ANCHOR_KINDS: ReadonlySet<string> = new Set<AnchorKind>([
  'start', 'end', 'center', 'vertex', 'segment', 'midpoint', 'position', 'whole',
]);
const DISTANCE_MODES: ReadonlySet<string> = new Set(['aligned', 'horizontal', 'vertical']);

/** Map an ordinal entity reference (`#<index>`) back to the read entity's
 *  id; any other reference passes through (validation will judge it). */
function resolveEntityRef(entityId: string, entityIdsInOrder: readonly string[]): string | undefined {
  if (!entityId.startsWith('#')) return entityId;
  const index = Number(entityId.slice(1));
  if (!Number.isInteger(index) || index < 0 || index >= entityIdsInOrder.length) return undefined;
  return entityIdsInOrder[index]!;
}

function decodeConstraint(raw: unknown, entityIdsInOrder: readonly string[]): Constraint | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.id !== 'string' || raw.id === '') return undefined;
  if (typeof raw.kind !== 'string' || !CONSTRAINT_KINDS.has(raw.kind)) return undefined;
  if (raw.role !== 'driving' && raw.role !== 'reference') return undefined;
  if (!Array.isArray(raw.refs) || raw.refs.length === 0) return undefined;
  const refs: Constraint['refs'][number][] = [];
  for (const r of raw.refs) {
    if (!isRecord(r) || typeof r.entityId !== 'string' || typeof r.anchor !== 'string' || !ANCHOR_KINDS.has(r.anchor)) return undefined;
    if (r.index !== undefined && (!Number.isInteger(r.index) || (r.index as number) < 0)) return undefined;
    const entityId = resolveEntityRef(r.entityId, entityIdsInOrder);
    if (entityId === undefined) return undefined;
    refs.push({ entityId, anchor: r.anchor as AnchorKind, ...(r.index !== undefined ? { index: r.index as number } : {}) });
  }
  if (raw.value !== undefined && !isFiniteNumber(raw.value)) return undefined;
  if (raw.distanceMode !== undefined && (typeof raw.distanceMode !== 'string' || !DISTANCE_MODES.has(raw.distanceMode))) return undefined;
  if (raw.suppressed !== undefined && typeof raw.suppressed !== 'boolean') return undefined;
  return {
    id: raw.id,
    kind: raw.kind as ConstraintKind,
    role: raw.role,
    refs,
    ...(raw.value !== undefined ? { value: raw.value as number } : {}),
    ...(raw.distanceMode !== undefined ? { distanceMode: raw.distanceMode as Constraint['distanceMode'] } : {}),
    ...(raw.suppressed !== undefined ? { suppressed: raw.suppressed as boolean } : {}),
  };
}

/**
 * Decode a constraints payload against the drawing's read entities. The
 * decoded set must also pass §4 validation (validateConstraints) against
 * exactly those entities; any problem retains the payload instead of
 * modeling a set the solver would refuse anyway.
 */
export function decodeConstraints(raw: string, entities: readonly Entity[]): ConstraintsDecode {
  const retained: ConstraintsDecode = { ok: false, retained: raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return retained;
  }
  if (!isRecord(parsed)) return retained;
  // A payload of any other carrier version — newer or older — is never guessed at.
  if (parsed.v !== CONSTRAINTS_CARRIER_VERSION || parsed.kind !== 'constraints') return retained;
  if (!Array.isArray(parsed.constraints)) return retained;
  const entityIdsInOrder = entities.map((e) => e.id);
  const constraints: Constraint[] = [];
  for (const c of parsed.constraints) {
    const decoded = decodeConstraint(c, entityIdsInOrder);
    if (!decoded) return retained;
    constraints.push(decoded);
  }
  const set: ConstraintSet = { constraints };
  if (validateConstraints(entities, set).length > 0) return retained;
  return { ok: true, set };
}
