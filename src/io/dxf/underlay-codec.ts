/**
 * DXF group codec for *UNDERLAY entities and *DEFINITION objects — pure and
 * isolated: it converts between DXF group lists (the pairs after the leading
 * 0/record-name pair) and the retained model in core/underlay.ts.
 *
 * Record layout (AutoCAD DXF Reference "UNDERLAY" / "UNDERLAYDEFINITION",
 * matched by ezdxf 1.3.5 entities/underlay.py and confirmed against an
 * AutoCAD 2027 DXFOUT at the v0.6.4 gate — review finding F-F; the first
 * codec used 70/280/281 and 14/24 with AcDbPdfUnderlay markers, which made
 * AutoCAD discard the whole drawing):
 *
 *   PDFUNDERLAY / DWFUNDERLAY / DGNUNDERLAY
 *     100 AcDbEntity ... 100 AcDbUnderlayReference
 *     340 definition handle; 10/20/30 insertion; 41/42/43 scales;
 *     50 rotation (degrees); 210/220/230 normal;
 *     280 flags (1 clipping on, 2 on, 4 monochrome, 8 adjust for
 *         background, 16 clip inside); 281 contrast (20..100);
 *     282 fade (0..80); then the clip boundary as repeated 11/21 pairs
 *     (2 points = rectangle, 3+ = polygon).
 *   PDFDEFINITION / DWFDEFINITION / DGNDEFINITION
 *     100 AcDbUnderlayDefinition; 1 file name; 2 page / sheet / model name.
 *
 * The codec's contract:
 *
 * - Groups the model claims are parsed and re-emitted canonically.
 * - Every other group — including ones no version of JCad understands yet —
 *   is retained verbatim and re-emitted. Nothing is silently discarded; a
 *   duplicate scalar group keeps its first value modeled and retains the
 *   rest.
 * - Default-valued claimed groups are the one refinement: when a claimed
 *   group's value equals the canonical default the writer would omit
 *   (layer "0", unit scales, rotation 0, flags = on), the group ALSO rides
 *   retainedGroups verbatim, and an absent group 280 is never invented on
 *   write — so explicit defaults stay explicit and absence stays absent,
 *   and the round trip preserves the group multiset exactly (acceptance
 *   F-A).
 * - On write the retained groups are SLOTTED into the AutoCAD order above
 *   (AutoCAD's underlay reader is sequential — an out-of-place or unknown
 *   code is "Unexpected DXF group code"), and (v0.6.4 review F-G) a
 *   retained copy of a code the canonical emission writes is dropped: an
 *   edited scale or rotation is written once, with the new value, never
 *   "41 2 ... 41 1.0". A retained copy is emitted only where the canonical
 *   emission omits that code (an explicit default).
 * - Contrast and fade are clamped to AutoCAD's ranges on write (20..100,
 *   0..80); the parsed model keeps the file's value untouched.
 * - Malformed modeled data (missing definition reference, missing
 *   insertion point, non-numeric modeled group, unpaired clip point)
 *   refuses the whole record atomically with a reason — never a
 *   half-parsed placement.
 * - Subclass-marker (100) groups are structural: they are not retained;
 *   the writer regenerates the canonical markers.
 */
import {
  UNDERLAY_FLAG_ON,
  type DxfGroup,
  type UnderlayDefinition,
  type UnderlayKind,
  type UnderlayPlacement,
} from '../../core/underlay';
import type { Point } from '../../core/geometry';

export type DxfGroupPair = DxfGroup;

export type UnderlayParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: string };

const ENTITY_KIND: Readonly<Record<string, UnderlayKind>> = { PDFUNDERLAY: 'pdf', DWFUNDERLAY: 'dwf', DGNUNDERLAY: 'dgn' };
const DEFINITION_KIND: Readonly<Record<string, UnderlayKind>> = { PDFDEFINITION: 'pdf', DWFDEFINITION: 'dwf', DGNDEFINITION: 'dgn' };
const ENTITY_TYPE: Readonly<Record<UnderlayKind, string>> = { pdf: 'PDFUNDERLAY', dwf: 'DWFUNDERLAY', dgn: 'DGNUNDERLAY' };
const DEFINITION_TYPE: Readonly<Record<UnderlayKind, string>> = { pdf: 'PDFDEFINITION', dwf: 'DWFDEFINITION', dgn: 'DGNDEFINITION' };
/** Subclass markers: the same for every kind (the kind is the record name). */
export const UNDERLAY_ENTITY_SUBCLASS = 'AcDbUnderlayReference';
export const UNDERLAY_DEFINITION_SUBCLASS = 'AcDbUnderlayDefinition';
/** CLASSES-section C++ class names, as AutoCAD registers them ("ObjectDBX Classes"). */
const ENTITY_CLASS: Readonly<Record<UnderlayKind, string>> = { pdf: 'AcDbPdfReference', dwf: 'AcDbDwfReference', dgn: 'AcDbDgnReference' };
const DEFINITION_CLASS: Readonly<Record<UnderlayKind, string>> = { pdf: 'AcDbPdfDefinition', dwf: 'AcDbDwfDefinition', dgn: 'AcDbDgnDefinition' };

export const underlayEntityKind = (dxfType: string): UnderlayKind | null => ENTITY_KIND[dxfType.toUpperCase()] ?? null;
export const underlayDefinitionKind = (dxfType: string): UnderlayKind | null => DEFINITION_KIND[dxfType.toUpperCase()] ?? null;
export const underlayDxfType = (kind: UnderlayKind): string => ENTITY_TYPE[kind];
export const underlayDefinitionDxfType = (kind: UnderlayKind): string => DEFINITION_TYPE[kind];
export const underlayEntityClassName = (kind: UnderlayKind): string => ENTITY_CLASS[kind];
export const underlayDefinitionClassName = (kind: UnderlayKind): string => DEFINITION_CLASS[kind];

/** AutoCAD's ranges: contrast 20..100, fade 0..80. Applied on write only. */
export const UNDERLAY_CONTRAST_RANGE = { min: 20, max: 100 } as const;
export const UNDERLAY_FADE_RANGE = { min: 0, max: 80 } as const;
const clamp = (v: number, range: { readonly min: number; readonly max: number }): number => Math.min(range.max, Math.max(range.min, Math.round(v)));

/** Strict DXF number parse: the whole trimmed value must be one finite number. */
function num(value: string): number | null {
  const t = value.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function int(value: string): number | null {
  const n = num(value);
  return n !== null && Number.isInteger(n) ? n : null;
}

/** Canonical DXF number formatting: no float noise, no exponent for ordinary magnitudes. */
function fmt(n: number): string {
  const r = Math.round(n * 1e10) / 1e10;
  return Object.is(r, -0) ? '0' : String(r);
}

interface Scanner {
  /** First value seen for a scalar code, or undefined. Later duplicates go to retained. */
  take(code: number): string | undefined;
  retained: DxfGroup[];
}

/**
 * Split a group list into first-occurrence scalar claims and the retained
 * remainder. `claimed` codes are consumed (first occurrence only); every
 * other pair — and every duplicate of a claimed code — is retained in
 * original order. 100 markers are structural and vanish (regenerated).
 * A first occurrence that satisfies `alsoRetain` is claimed AND retained
 * (at its original position): the F-A mechanism for default-valued
 * groups, whose canonical emission the writer omits — the retained copy
 * is what carries them through the round trip verbatim.
 */
function scan(groups: readonly DxfGroupPair[], claimed: ReadonlySet<number>, alsoRetain?: (code: number, value: string) => boolean): Scanner {
  const first = new Map<number, string>();
  const retained: DxfGroup[] = [];
  for (const [code, value] of groups) {
    if (code === 100) continue;
    if (claimed.has(code) && !first.has(code)) {
      first.set(code, value);
      if (alsoRetain?.(code, value)) retained.push([code, value]);
    } else retained.push([code, value]);
  }
  return { take: (code) => first.get(code), retained };
}

const fail = (refusal: string): { ok: false; refusal: string } => ({ ok: false, refusal });

export function parseUnderlayDefinition(kind: UnderlayKind, groups: readonly DxfGroupPair[], fallbackId: string): UnderlayParseResult<UnderlayDefinition> {
  const s = scan(groups, new Set([5, 1, 2]));
  const sourcePath = s.take(1);
  if (sourcePath === undefined || !sourcePath.trim()) return fail(`${DEFINITION_TYPE[kind]} has no file name (group 1): a definition without a referenced file is not a reference`);
  const handle = s.take(5)?.toUpperCase();
  const page = s.take(2);
  return {
    ok: true,
    value: {
      id: handle ? `underlaydef:${handle}` : fallbackId,
      ...(handle ? { handle } : {}),
      kind,
      sourcePath,
      ...(page !== undefined ? { page } : {}),
      retainedGroups: s.retained,
    },
  };
}

export function writeUnderlayDefinition(def: UnderlayDefinition): DxfGroupPair[] {
  const out: Array<readonly [number, string]> = [];
  if (def.handle) out.push([5, def.handle]);
  // Owner / reactor groups the record carried ride ahead of the subclass
  // marker, where AutoCAD writes them; everything else follows the modelled
  // groups. (The in-app writer supplies its own 5 / 330 and skips these.)
  const head = def.retainedGroups.filter(([code]) => code === 330 || code === 102 || code === 360);
  const tail = def.retainedGroups.filter(([code]) => !(code === 330 || code === 102 || code === 360));
  out.push(...head);
  out.push([100, UNDERLAY_DEFINITION_SUBCLASS]);
  out.push([1, def.sourcePath]);
  if (def.page !== undefined) out.push([2, def.page]);
  out.push(...tail);
  return out;
}

/** The subclass markers the pre-v0.6.4 codec wrote (never AutoCAD's). */
const LEGACY_ENTITY_SUBCLASSES: ReadonlySet<string> = new Set(['AcDbPdfUnderlay', 'AcDbDwfUnderlay', 'AcDbDgnUnderlay']);
/** Pre-v0.6.4 code -> AutoCAD code (flags, contrast, fade, clip X / Y). */
const LEGACY_CODE_REMAP: ReadonlyMap<number, number> = new Map([[70, 280], [280, 281], [281, 282], [14, 11], [24, 21]]);

/**
 * v0.6.4 re-review (2): a record written by the pre-fix JCad codec (its
 * subclass marker AcDbPdfUnderlay / AcDbDwfUnderlay / AcDbDgnUnderlay is
 * the tell — AutoCAD never writes those) carried flags as 70, contrast as
 * 280, fade as 281 and the clip as 14/24. Remapped to AutoCAD's codes
 * before the scan, such a record reads as intended and is written in
 * AutoCAD's layout with no stray 70 / 14 / 24. Records with the AutoCAD
 * marker (or none) are untouched.
 */
function remapLegacyGroups(groups: readonly DxfGroupPair[]): readonly DxfGroupPair[] {
  if (!groups.some(([code, value]) => code === 100 && LEGACY_ENTITY_SUBCLASSES.has(value.trim()))) return groups;
  return groups.map(([code, value]) => {
    const to = LEGACY_CODE_REMAP.get(code);
    return to === undefined ? [code, value] as const : [to, value] as const;
  });
}

export function parseUnderlayEntity(kind: UnderlayKind, rawGroups: readonly DxfGroupPair[], fallbackId: string): UnderlayParseResult<UnderlayPlacement> {
  const groups = remapLegacyGroups(rawGroups);
  // Clip points (11/21 pairs) are claimed as a sequence, not as scalars.
  const points: Point[] = [];
  const rest: DxfGroupPair[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    const pair = groups[i]!;
    if (pair[0] === 11) {
      const next = groups[i + 1];
      if (!next || next[0] !== 21) return fail(`${ENTITY_TYPE[kind]} clip boundary point (group 11) has no matching group 21`);
      const x = num(pair[1]);
      const y = num(next[1]);
      if (x === null || y === null) return fail(`${ENTITY_TYPE[kind]} clip boundary point is not numeric (groups 11/21)`);
      points.push({ x, y });
      i += 1;
      continue;
    }
    if (pair[0] === 21) return fail(`${ENTITY_TYPE[kind]} clip boundary point (group 21) has no preceding group 11`);
    rest.push(pair);
  }

  // F-A: a claimed group whose value equals the canonical default the
  // writer omits (layer "0", unit scale, rotation 0, flags = on) is ALSO
  // retained verbatim, so its explicit presence survives the round trip;
  // the writer's canonical emission is what gets suppressed instead.
  const retainDefault = (code: number, value: string): boolean => {
    switch (code) {
      case 8:
        return value === '0';
      case 41:
      case 42:
        return num(value) === 1;
      case 50:
        return num(value) === 0;
      case 280:
        return int(value) === UNDERLAY_FLAG_ON;
      default:
        return false;
    }
  };
  const s = scan(rest, new Set([5, 8, 340, 10, 20, 41, 42, 50, 280, 281, 282]), retainDefault);
  const definitionHandle = s.take(340)?.trim().toUpperCase();
  if (!definitionHandle) return fail(`${ENTITY_TYPE[kind]} has no definition reference (group 340)`);
  const rawX = s.take(10);
  const rawY = s.take(20);
  if (rawX === undefined || rawY === undefined) return fail(`${ENTITY_TYPE[kind]} has no insertion point (groups 10/20)`);
  const x = num(rawX);
  const y = num(rawY);
  if (x === null || y === null) return fail(`${ENTITY_TYPE[kind]} insertion point is not numeric (groups 10/20)`);

  const scalar = (code: number, parse: (v: string) => number | null): number | undefined | string => {
    const raw = s.take(code);
    if (raw === undefined) return undefined;
    const v = parse(raw);
    return v === null ? `${ENTITY_TYPE[kind]} group ${code} is not a valid number: "${raw}"` : v;
  };
  const scaleX = scalar(41, num);
  const scaleY = scalar(42, num);
  const rotationDeg = scalar(50, num);
  const flags = scalar(280, int);
  const contrast = scalar(281, int);
  const fade = scalar(282, int);
  for (const v of [scaleX, scaleY, rotationDeg, flags, contrast, fade]) {
    if (typeof v === 'string') return fail(v);
  }

  const handle = s.take(5)?.toUpperCase();
  return {
    ok: true,
    value: {
      id: handle ? `underlay:${handle}` : fallbackId,
      ...(handle ? { handle } : {}),
      kind,
      definitionHandle,
      layer: s.take(8) ?? '0',
      position: { x, y },
      scaleX: (scaleX as number | undefined) ?? 1,
      scaleY: (scaleY as number | undefined) ?? 1,
      rotation: (((rotationDeg as number | undefined) ?? 0) * Math.PI) / 180,
      flags: (flags as number | undefined) ?? UNDERLAY_FLAG_ON,
      ...(contrast !== undefined ? { contrast: contrast as number } : {}),
      ...(fade !== undefined ? { fade: fade as number } : {}),
      ...(points.length ? { clipBoundary: points } : {}),
      retainedGroups: s.retained,
    },
  };
}

/**
 * The AcDbEntity-class codes a retained group may carry (common entity
 * data and proxy graphics): they belong between the AcDbEntity marker and
 * the AcDbUnderlayReference marker.
 */
const ENTITY_COMMON_CODES: ReadonlySet<number> = new Set([5, 102, 330, 360, 8, 6, 62, 67, 48, 60, 92, 160, 310, 347, 348, 370, 390, 420, 430, 440, 284]);
/** The AcDbUnderlayReference groups in AutoCAD's order (clip 11/21 pairs follow them). */
const REFERENCE_ORDER: readonly number[] = [340, 10, 20, 30, 41, 42, 43, 50, 210, 220, 230, 280, 281, 282];

export function writeUnderlayEntity(p: UnderlayPlacement): DxfGroupPair[] {
  const out: Array<readonly [number, string]> = [];
  // Canonical (modelled, non-default) values by code.
  const canonical = new Map<number, string>();
  canonical.set(340, p.definitionHandle);
  canonical.set(10, fmt(p.position.x));
  canonical.set(20, fmt(p.position.y));
  if (p.scaleX !== 1) canonical.set(41, fmt(p.scaleX));
  if (p.scaleY !== 1) canonical.set(42, fmt(p.scaleY));
  if (p.rotation !== 0) canonical.set(50, fmt((p.rotation * 180) / Math.PI));
  // Flags at the on-default are omitted like the other defaults: an
  // absent group 280 parses to this same default, so always emitting it
  // would invent a group the record never had (F-A). An explicit 280 at
  // the default value reaches the output via retainedGroups instead.
  if (p.flags !== UNDERLAY_FLAG_ON) canonical.set(280, String(p.flags));
  if (p.contrast !== undefined) canonical.set(281, String(clamp(p.contrast, UNDERLAY_CONTRAST_RANGE)));
  if (p.fade !== undefined) canonical.set(282, String(clamp(p.fade, UNDERLAY_FADE_RANGE)));

  const retainedOf = (code: number): readonly DxfGroup[] => p.retainedGroups.filter(([c]) => c === code);
  const used = new Set<number>();
  /** The canonical value for `code`, else every retained copy of it (F-G: never both). */
  const slot = (code: number): void => {
    used.add(code);
    const c = canonical.get(code);
    if (c !== undefined) out.push([code, c]);
    else out.push(...retainedOf(code));
  };

  if (p.handle) out.push([5, p.handle]);
  used.add(5);
  out.push([100, 'AcDbEntity']);
  if (p.layer !== '0') out.push([8, p.layer]);
  else out.push(...retainedOf(8));
  used.add(8);
  // Other common-entity data the record carried (colour, lineweight, proxy graphics ...), in order.
  for (const g of p.retainedGroups) {
    if (ENTITY_COMMON_CODES.has(g[0]) && !used.has(g[0])) out.push(g);
  }
  for (const code of ENTITY_COMMON_CODES) used.add(code);
  out.push([100, UNDERLAY_ENTITY_SUBCLASS]);
  for (const code of REFERENCE_ORDER) slot(code);
  if (p.clipBoundary) {
    for (const q of p.clipBoundary) {
      out.push([11, fmt(q.x)]);
      out.push([21, fmt(q.y)]);
    }
  }
  used.add(11);
  used.add(21);
  // Everything else the record carried (XDATA, unknown groups), in order, last.
  for (const g of p.retainedGroups) if (!used.has(g[0])) out.push(g);
  return out;
}
