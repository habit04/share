/**
 * UNDERLAY references (PDF / DWF / DGN): a retained sibling reference model,
 * following the IMAGE + IMAGEDEF precedent — NOT an xref (CONTRACTS §7.4:
 * underlays never register as xref blocks and never ride XrefStore).
 *
 * A placement is a reference, never content: it points at a definition (the
 * referenced file, stored exactly as the drawing stores it) and carries
 * placement and display state only. The referenced source file is never
 * rewritten, resolved or flattened into the drawing by this model; decoding
 * its content happens behind the bounded adapter in io/underlay-adapter.ts.
 *
 * This module is pure and isolated: it is not yet wired into the Entity
 * union, the document, the renderers or the codecs. That integration is
 * PROPOSAL-P28 (see the six-pipeline ledger); until it is admitted, this
 * model is the contract the integration will consume.
 */
import type { Point } from './geometry';

/** One DXF group pair, verbatim. */
export type DxfGroup = readonly [code: number, value: string];

export type UnderlayKind = 'pdf' | 'dwf' | 'dgn';

/** DXF group 70 flag bits on an underlay entity. */
export const UNDERLAY_FLAG_CLIPPING_ON = 1;
export const UNDERLAY_FLAG_ON = 2;
export const UNDERLAY_FLAG_MONOCHROME = 4;
export const UNDERLAY_FLAG_ADJUST_FOR_BACKGROUND = 8;

/**
 * The referenced file: one *DEFINITION object (PDFDEFINITION /
 * DWFDEFINITION / DGNDEFINITION). `sourcePath` is the file name exactly as
 * stored in the drawing — never normalized, resolved or rewritten here.
 */
export interface UnderlayDefinition {
  readonly id: string;
  /** DXF handle of the definition object, when the record carried one. */
  readonly handle?: string;
  readonly kind: UnderlayKind;
  readonly sourcePath: string;
  /** Active page (PDF), sheet (DWF) or model (DGN) name, when stored. */
  readonly page?: string;
  /**
   * Size of the referenced page/sheet in its own coordinate units, when a
   * probe or decoder has established it. Absent = unknown: placement math
   * falls back to the unit frame (see underlayCorners).
   */
  readonly extent?: { readonly width: number; readonly height: number };
  /** Groups of the definition record this model does not claim, verbatim and in order. */
  readonly retainedGroups: readonly DxfGroup[];
}

/** One placed underlay: a *UNDERLAY entity referencing a definition by handle. */
export interface UnderlayPlacement {
  readonly id: string;
  /** DXF handle of the underlay entity, when the record carried one. */
  readonly handle?: string;
  readonly kind: UnderlayKind;
  /** Group 340 hard-pointer target: the definition object's handle, upper-cased. */
  readonly definitionHandle: string;
  readonly layer: string;
  /** Insertion point (groups 10/20). */
  readonly position: Point;
  /** Groups 41/42. Negative = mirrored, as with INSERT scales. */
  readonly scaleX: number;
  readonly scaleY: number;
  /** Radians (group 50 in degrees), the model convention for entities. */
  readonly rotation: number;
  /** Group 70 flag bits, raw (see UNDERLAY_FLAG_*). */
  readonly flags: number;
  /** Group 280, 0..100. */
  readonly contrast?: number;
  /** Group 281, 0..100. */
  readonly fade?: number;
  /**
   * Clip boundary in underlay coordinates (group 14/24 point pairs, the
   * IMAGE convention). Only meaningful when UNDERLAY_FLAG_CLIPPING_ON is
   * set; retained either way.
   */
  readonly clipBoundary?: readonly Point[];
  /** Groups of the entity record this model does not claim, verbatim and in order. */
  readonly retainedGroups: readonly DxfGroup[];
}

export const underlayIsOn = (p: UnderlayPlacement): boolean => (p.flags & UNDERLAY_FLAG_ON) !== 0;
export const underlayClippingOn = (p: UnderlayPlacement): boolean => (p.flags & UNDERLAY_FLAG_CLIPPING_ON) !== 0;
export const underlayMonochrome = (p: UnderlayPlacement): boolean => (p.flags & UNDERLAY_FLAG_MONOCHROME) !== 0;

/**
 * Every problem with a placement, or [] when it is usable. Validation is
 * total and atomic: a caller either gets a placement that passed whole, or
 * the full problem list — never a half-valid placement.
 */
export function validateUnderlayPlacement(p: UnderlayPlacement): readonly string[] {
  const problems: string[] = [];
  if (!p.definitionHandle || !p.definitionHandle.trim()) problems.push('placement has no definition reference');
  if (!Number.isFinite(p.position.x) || !Number.isFinite(p.position.y)) problems.push('position is not finite');
  if (!Number.isFinite(p.scaleX) || !Number.isFinite(p.scaleY) || p.scaleX === 0 || p.scaleY === 0) problems.push('scale is not finite and non-zero');
  if (!Number.isFinite(p.rotation)) problems.push('rotation is not finite');
  if (p.contrast !== undefined && (!Number.isFinite(p.contrast) || p.contrast < 0 || p.contrast > 100)) problems.push('contrast is outside 0..100');
  if (p.fade !== undefined && (!Number.isFinite(p.fade) || p.fade < 0 || p.fade > 100)) problems.push('fade is outside 0..100');
  if (p.clipBoundary !== undefined && p.clipBoundary.length < 2) problems.push('clip boundary has fewer than 2 points');
  if (p.clipBoundary?.some((q) => !Number.isFinite(q.x) || !Number.isFinite(q.y))) problems.push('clip boundary has a non-finite point');
  return problems;
}

/**
 * The correspondence problems between a placement and a definition, or []
 * when the definition is the one the placement references. A placement
 * points at exactly one definition, by handle (CONTRACTS §7.4: a
 * reference is never silently re-pointed); serving a placement with any
 * other definition would display and plot a file the drawing does not
 * reference under it, so the serving functions below refuse mismatched
 * pairs, and integration code assembles pairs through this check.
 * Handles are DXF hex and compare case-insensitively.
 */
export function validateUnderlayPair(p: UnderlayPlacement, def: UnderlayDefinition): readonly string[] {
  const wanted = p.definitionHandle.trim().toUpperCase();
  if (!wanted) return ['placement has no definition reference to correspond to'];
  if (!def.handle || !def.handle.trim()) {
    return [`placement references definition ${wanted} but the supplied definition (${def.id}) carries no handle`];
  }
  const actual = def.handle.trim().toUpperCase();
  if (actual !== wanted) {
    return [`placement references definition ${wanted} but was paired with definition ${actual} (${def.sourcePath})`];
  }
  return [];
}

/**
 * The assembly problems in a set of definitions, or [] when every
 * definition is uniquely keyed. Two records can carry the same handle
 * (a duplicated *DEFINITION object — the codec parses such records
 * independently, and they derive the same id); keying an assembly by
 * handle or id would silently overwrite one with the other. Integration
 * MUST run this check when assembling definitions and report collisions
 * — never overwrite (acceptance F-B, adjacent fact C1.3).
 */
export function validateUnderlayDefinitions(defs: readonly UnderlayDefinition[]): readonly string[] {
  const problems: string[] = [];
  const byHandle = new Map<string, UnderlayDefinition>();
  const byId = new Map<string, UnderlayDefinition>();
  for (const def of defs) {
    if (def.handle && def.handle.trim()) {
      const key = def.handle.trim().toUpperCase();
      const prior = byHandle.get(key);
      if (prior) {
        problems.push(`duplicate definition handle ${key}: "${prior.sourcePath}" (${prior.id}) and "${def.sourcePath}" (${def.id}) — a handle-keyed assembly must report the collision, not overwrite`);
      } else byHandle.set(key, def);
    }
    const priorId = byId.get(def.id);
    if (priorId) {
      problems.push(`duplicate definition id ${def.id}: "${priorId.sourcePath}" and "${def.sourcePath}" — an id-keyed assembly must report the collision, not overwrite`);
    } else byId.set(def.id, def);
  }
  return problems;
}

/** Typed refusal raised by the geometry functions on a mismatched pair. */
export class UnderlayCorrespondenceError extends Error {
  readonly placementId: string;
  readonly definitionId: string;
  constructor(problem: string, placementId: string, definitionId: string) {
    super(problem);
    this.name = 'UnderlayCorrespondenceError';
    this.placementId = placementId;
    this.definitionId = definitionId;
  }
}

function assertCorresponds(p: UnderlayPlacement, def: UnderlayDefinition): void {
  const problems = validateUnderlayPair(p, def);
  if (problems.length > 0) throw new UnderlayCorrespondenceError(problems[0]!, p.id, def.id);
}

/** Transform one underlay-coordinate point into world coordinates. */
function toWorld(p: UnderlayPlacement, q: Point): Point {
  const sx = q.x * p.scaleX;
  const sy = q.y * p.scaleY;
  const c = Math.cos(p.rotation);
  const s = Math.sin(p.rotation);
  return { x: p.position.x + sx * c - sy * s, y: p.position.y + sx * s + sy * c };
}

/**
 * The four world corners of the placed page/sheet, starting at the
 * insertion corner and going counter-clockwise in underlay coordinates.
 * Without a known page extent the unit frame is used — the frame a
 * not-yet-decoded underlay occupies until a probe supplies the real size.
 * Refuses a mismatched pair (UnderlayCorrespondenceError): geometry has
 * no honest "empty" answer for a definition the placement does not
 * reference.
 */
export function underlayCorners(p: UnderlayPlacement, def: UnderlayDefinition): readonly Point[] {
  assertCorresponds(p, def);
  const w = def.extent && Number.isFinite(def.extent.width) && def.extent.width > 0 ? def.extent.width : 1;
  const h = def.extent && Number.isFinite(def.extent.height) && def.extent.height > 0 ? def.extent.height : 1;
  return [
    toWorld(p, { x: 0, y: 0 }),
    toWorld(p, { x: w, y: 0 }),
    toWorld(p, { x: w, y: h }),
    toWorld(p, { x: 0, y: h }),
  ];
}

export interface UnderlayBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function underlayBounds(p: UnderlayPlacement, def: UnderlayDefinition): UnderlayBounds {
  const corners = underlayCorners(p, def);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const q of corners) {
    if (q.x < minX) minX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.x > maxX) maxX = q.x;
    if (q.y > maxY) maxY = q.y;
  }
  return { minX, minY, maxX, maxY };
}

/** File-name portion of a stored path, for labels (both separator styles). */
export function underlayLabel(def: UnderlayDefinition): string {
  const base = def.sourcePath.split(/[\\/]/).pop() || def.sourcePath;
  return def.page ? `${base} — page ${def.page}` : base;
}

/**
 * Display/plot operations for one placement — pure data, no Canvas. The
 * initial PDF slice: when no decoded content is supplied, an underlay draws
 * as a frame with a cross and a label (the IMAGE-without-a-bitmap
 * behaviour); when a decoder supplies content, an `image` op covers the
 * frame. An underlay that is off produces no ops at all, on screen or on
 * paper. A later admitted integration feeds these ops to Canvas and to the
 * plot path (CONTRACTS §5); this list is the single source for both.
 */
export type UnderlayDisplayOp =
  | { readonly op: 'frame'; readonly points: readonly Point[] }
  | { readonly op: 'clip-frame'; readonly points: readonly Point[] }
  | { readonly op: 'cross'; readonly points: readonly Point[] }
  | { readonly op: 'image'; readonly corners: readonly Point[]; readonly sourcePath: string; readonly page?: string }
  | { readonly op: 'label'; readonly text: string; readonly at: Point };

/** Decoded page content offered by an adapter: its size in underlay units. */
export interface UnderlayContent {
  readonly width: number;
  readonly height: number;
}

export function underlayDisplayList(p: UnderlayPlacement, def: UnderlayDefinition, content?: UnderlayContent): readonly UnderlayDisplayOp[] {
  // A mismatched pair is refused by serving nothing at all — never the
  // wrong file's image, frame or label, on screen or on paper (F-B).
  // Callers report the pairing through validateUnderlayPair.
  if (validateUnderlayPair(p, def).length > 0) return [];
  if (!underlayIsOn(p)) return [];
  const corners = underlayCorners(p, def);
  const ops: UnderlayDisplayOp[] = [];
  if (content) {
    ops.push({ op: 'image', corners, sourcePath: def.sourcePath, ...(def.page ? { page: def.page } : {}) });
    ops.push({ op: 'frame', points: corners });
  } else {
    ops.push({ op: 'frame', points: corners });
    ops.push({ op: 'cross', points: [corners[0]!, corners[2]!, corners[1]!, corners[3]!] });
    ops.push({ op: 'label', text: underlayLabel(def), at: corners[0]! });
  }
  if (underlayClippingOn(p) && p.clipBoundary && p.clipBoundary.length >= 2) {
    ops.push({ op: 'clip-frame', points: p.clipBoundary.map((q) => toWorld(p, q)) });
  }
  return ops;
}
