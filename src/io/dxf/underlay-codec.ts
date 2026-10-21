/**
 * DXF group codec for *UNDERLAY entities and *DEFINITION objects — pure and
 * isolated: it converts between DXF group lists (the pairs after the leading
 * 0/record-name pair) and the retained model in core/underlay.ts.
 *
 * On the base these records are dropped on read (read-pass lists them as
 * "not supported"), so an ordinary save loses the reference. This codec is
 * the retention contract the eventual integration consumes (PROPOSAL-P28):
 *
 * - Groups the model claims are parsed and re-emitted canonically.
 * - Every other group — including ones no version of JCad understands yet —
 *   is retained verbatim, in order, and re-emitted. Nothing is silently
 *   discarded; a duplicate scalar group keeps its first value modeled and
 *   retains the rest.
 * - Malformed modeled data (missing definition reference, missing
 *   insertion point, non-numeric modeled group, unpaired clip point)
 *   refuses the whole record atomically with a reason — never a
 *   half-parsed placement.
 * - Subclass-marker (100) groups are structural: they are not retained;
 *   the writer regenerates the canonical markers for the kind.
 *
 * Wiring this into read-pass / the writer is a shared-codec change and is
 * NOT done here; it waits for PROPOSAL-P28 admission (CONTRACTS §4/§6).
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
const ENTITY_SUBCLASS: Readonly<Record<UnderlayKind, string>> = { pdf: 'AcDbPdfUnderlay', dwf: 'AcDbDwfUnderlay', dgn: 'AcDbDgnUnderlay' };
const DEFINITION_SUBCLASS: Readonly<Record<UnderlayKind, string>> = { pdf: 'AcDbPdfDefinition', dwf: 'AcDbDwfDefinition', dgn: 'AcDbDgnDefinition' };

export const underlayEntityKind = (dxfType: string): UnderlayKind | null => ENTITY_KIND[dxfType.toUpperCase()] ?? null;
export const underlayDefinitionKind = (dxfType: string): UnderlayKind | null => DEFINITION_KIND[dxfType.toUpperCase()] ?? null;
export const underlayDxfType = (kind: UnderlayKind): string => ENTITY_TYPE[kind];
export const underlayDefinitionDxfType = (kind: UnderlayKind): string => DEFINITION_TYPE[kind];

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
 */
function scan(groups: readonly DxfGroupPair[], claimed: ReadonlySet<number>): Scanner {
  const first = new Map<number, string>();
  const retained: DxfGroup[] = [];
  for (const [code, value] of groups) {
    if (code === 100) continue;
    if (claimed.has(code) && !first.has(code)) first.set(code, value);
    else retained.push([code, value]);
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
  out.push([100, 'AcDbObject']);
  out.push([100, DEFINITION_SUBCLASS[def.kind]]);
  out.push([1, def.sourcePath]);
  if (def.page !== undefined) out.push([2, def.page]);
  out.push(...def.retainedGroups);
  return out;
}

export function parseUnderlayEntity(kind: UnderlayKind, groups: readonly DxfGroupPair[], fallbackId: string): UnderlayParseResult<UnderlayPlacement> {
  // Clip points (14/24 pairs) are claimed as a sequence, not as scalars.
  const points: Point[] = [];
  const rest: DxfGroupPair[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    const pair = groups[i]!;
    if (pair[0] === 14) {
      const next = groups[i + 1];
      if (!next || next[0] !== 24) return fail(`${ENTITY_TYPE[kind]} clip boundary point (group 14) has no matching group 24`);
      const x = num(pair[1]);
      const y = num(next[1]);
      if (x === null || y === null) return fail(`${ENTITY_TYPE[kind]} clip boundary point is not numeric (groups 14/24)`);
      points.push({ x, y });
      i += 1;
      continue;
    }
    if (pair[0] === 24) return fail(`${ENTITY_TYPE[kind]} clip boundary point (group 24) has no preceding group 14`);
    rest.push(pair);
  }

  const s = scan(rest, new Set([5, 8, 340, 10, 20, 41, 42, 50, 70, 280, 281]));
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
  const flags = scalar(70, int);
  const contrast = scalar(280, int);
  const fade = scalar(281, int);
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

export function writeUnderlayEntity(p: UnderlayPlacement): DxfGroupPair[] {
  const out: Array<readonly [number, string]> = [];
  if (p.handle) out.push([5, p.handle]);
  out.push([100, 'AcDbEntity']);
  if (p.layer !== '0') out.push([8, p.layer]);
  out.push([100, ENTITY_SUBCLASS[p.kind]]);
  out.push([340, p.definitionHandle]);
  out.push([10, fmt(p.position.x)]);
  out.push([20, fmt(p.position.y)]);
  if (p.scaleX !== 1) out.push([41, fmt(p.scaleX)]);
  if (p.scaleY !== 1) out.push([42, fmt(p.scaleY)]);
  if (p.rotation !== 0) out.push([50, fmt((p.rotation * 180) / Math.PI)]);
  out.push([70, String(p.flags)]);
  if (p.contrast !== undefined) out.push([280, String(p.contrast)]);
  if (p.fade !== undefined) out.push([281, String(p.fade)]);
  if (p.clipBoundary) {
    for (const q of p.clipBoundary) {
      out.push([14, fmt(q.x)]);
      out.push([24, fmt(q.y)]);
    }
  }
  out.push(...p.retainedGroups);
  return out;
}
