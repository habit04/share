/**
 * Shared primitives for the built-in symbol libraries. Units are inches;
 * an inline symbol is 0.75 wide (wire stubs end at x = ±HALF on y = 0) and
 * the block base point is the wire-connection centre. Every symbol built
 * with `symbol()` carries the AutoCAD Electrical attribute set.
 *
 * All geometry produced with these helpers is original artwork.
 */
import type { BlockDef, Entity, AttributeDef } from '../core/entities';
import type { Point } from '../core/geometry';
import { withAcadeAttributes, acadeAttributes } from './attributes';

export const HALF = 0.375; // half width of an inline symbol
export const GAP = 0.125; // half of the contact gap

let n = 0;
const nextId = (prefix: string) => `${prefix}${(n += 1)}`;
const base = { layer: '0', color: 'ByLayer' as const };

/** Entity constructors. `prefix` keeps ids unique per library module. */
export function primitives(prefix: string) {
  const id = () => nextId(prefix);
  const L = (x1: number, y1: number, x2: number, y2: number): Entity => ({ ...base, id: id(), type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
  const C = (cx: number, cy: number, r: number, filled = false): Entity => ({ ...base, id: id(), type: 'circle', center: { x: cx, y: cy }, radius: r, ...(filled ? { filled: true } : {}) });
  const A = (cx: number, cy: number, r: number, startDeg: number, endDeg: number): Entity => ({
    ...base,
    id: id(),
    type: 'arc',
    center: { x: cx, y: cy },
    radius: r,
    startAngle: (startDeg * Math.PI) / 180,
    endAngle: (endDeg * Math.PI) / 180,
  });
  const P = (pts: Array<[number, number]>, closed = false): Entity => ({ ...base, id: id(), type: 'polyline', points: pts.map(([x, y]) => ({ x, y })), closed });
  const T = (x: number, y: number, text: string, h = 0.1, rotation = 0): Entity => ({ ...base, id: id(), type: 'text', position: { x, y }, text, height: h, rotation, align: 'center' });
  /** Wire stubs from the connection points (x = ±HALF) to the symbol body. */
  const stubs = (bodyHalf: number, y = 0): Entity[] => [L(-HALF, y, -bodyHalf, y), L(bodyHalf, y, HALF, y)];
  /** A closed rectangle centred on (cx, cy). */
  const R = (cx: number, cy: number, w: number, h: number): Entity => P([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]], true);
  return { L, C, A, P, T, R, stubs };
}

export const tagAttr = (y = 0.3, def = ''): AttributeDef => ({ tag: 'TAG1', prompt: 'Component tag', default: def, position: { x: 0, y }, height: 0.125, align: 'center' });
export const descAttr = (y = -0.45): AttributeDef => ({ tag: 'DESC1', prompt: 'Description', default: '', position: { x: 0, y }, height: 0.1, align: 'center' });
/** Terminal number attribute used by terminal symbols (family TB). */
export const termAttr = (y = 0.15): AttributeDef => ({ tag: 'TERM01', prompt: 'Terminal number', default: '', position: { x: 0, y }, height: 0.08, align: 'center' });

export interface SymbolSpec {
  /** Block name, e.g. HPB11 (JIC) or IEC_S_PB_NO (IEC). Unique across all libraries. */
  name: string;
  /** Human readable description shown in the icon menu. */
  description: string;
  entities: Entity[];
  /** Tag prefix / family, e.g. PB, CR, LS (JIC) or S, K, Q (IEC). */
  family: string;
  /** Visible attributes; defaults to TAG1 above and DESC1 below the symbol. */
  attributes?: AttributeDef[];
  /** WDTYPE override (CONTACT, COIL, TERM, PLC); defaults to the family. */
  wdtype?: string;
  basePoint?: Point;
}

/** Build a symbol with the full ACADE attribute set. */
export function symbol(spec: SymbolSpec): BlockDef {
  const b: BlockDef = {
    name: spec.name,
    description: spec.description,
    basePoint: spec.basePoint ?? { x: 0, y: 0 },
    entities: spec.entities,
    attributes: spec.attributes ?? [tagAttr(), descAttr()],
  };
  return withAcadeAttributes(b, spec.family, spec.wdtype);
}

export interface SymbolCategory {
  name: string;
  symbols: BlockDef[];
}

export const category = (name: string, symbols: BlockDef[]): SymbolCategory => ({ name, symbols });

// ---------------------------------------------------------------- curated vertical variants

/** A wire connection of a curated vertical symbol: top (2) or bottom (8) at column `x`. */
export interface VerticalPin {
  x: number;
  dir: 2 | 8;
  /** Default pin number; undefined takes the horizontal twin's pin default in pin order. */
  def?: string;
}

export interface VerticalSpec {
  /** Block name of the vertical variant (VPB11_NO for HPB11_NO, IEC_S_PB_NO_V for IEC_S_PB_NO). */
  name: string;
  /** Vertical geometry: wire stubs end at y = +-HALF on the connection columns, actuators drawn to the left. */
  entities: Entity[];
  /** Explicit connections (default: one on top and one at the bottom of x = 0). */
  pins?: VerticalPin[];
  /** x of the attribute column (default: right of the geometry + 0.1). */
  attrX?: number;
}

/** Right-most x of the geometry (text estimated from its length). */
export function geometryMaxX(entities: readonly Entity[]): number {
  let max = 0;
  for (const e of entities) {
    if (e.type === 'line') max = Math.max(max, e.a.x, e.b.x);
    else if (e.type === 'circle' || e.type === 'arc') max = Math.max(max, e.center.x + e.radius);
    else if (e.type === 'polyline') for (const p of e.points) max = Math.max(max, p.x);
    else if (e.type === 'text') max = Math.max(max, e.position.x + (e.text.length * e.height * 0.9) / 2);
  }
  return max;
}

const PIN_TAG = /^X[1248]TERM\d+$/;

/**
 * A curated vertical twin of a built-in horizontal symbol (the AutoCAD
 * Electrical V* convention): hand-drawn geometry that connects at its top and
 * bottom, TAG1 / DESC1-3 (or TERM01) left-justified to the right of the
 * symbol, and the family (tag prefix), WDTYPE, data defaults and pin defaults
 * of the horizontal twin, with the pins numbered top to bottom.
 */
export function verticalSymbol(horizontal: BlockDef, family: string, spec: VerticalSpec): BlockDef {
  const x = spec.attrX ?? Math.max(0.15, Math.round((geometryMaxX(spec.entities) + 0.1) * 100) / 100);
  const pinsH = horizontal.attributes.filter((a) => PIN_TAG.test(a.tag)).sort((a, b) => a.tag.slice(6).localeCompare(b.tag.slice(6)));
  const pins = (spec.pins ?? [
    { x: 0, dir: 2 as const },
    { x: 0, dir: 8 as const },
  ]).map((p) => ({ ...p, y: p.dir === 2 ? HALF : -HALF }));
  pins.sort((a, b) => b.y - a.y || a.x - b.x);
  const pinAttrs: AttributeDef[] = pins.map((p, i) => ({
    tag: `X${p.dir}TERM${String(i + 1).padStart(2, '0')}`,
    prompt: `Pin ${i + 1}`,
    default: p.def ?? pinsH[i]?.default ?? String(i + 1),
    position: { x: p.x, y: p.y },
    height: 0.06,
    align: 'center',
    invisible: true,
  }));
  const rows: Record<string, number> = { TAG1: 0.06, DESC1: -0.12, TERM01: -0.04 };
  const visible: AttributeDef[] = [];
  for (const a of horizontal.attributes) {
    const y = rows[a.tag];
    if (y === undefined || a.invisible) continue;
    const { rotation: _r, ...rest } = a;
    void _r;
    visible.push({ ...rest, position: { x, y }, align: 'left' });
  }
  // Data defaults of the twin (MFG, CAT, WDTYPE ...) are kept; DESC2 / DESC3 are rebuilt under DESC1.
  const data = horizontal.attributes.filter((a) => a.invisible && !PIN_TAG.test(a.tag) && a.tag !== 'DESC2' && a.tag !== 'DESC3');
  const wdtype = horizontal.attributes.find((a) => a.tag === 'WDTYPE')?.default;
  const b: BlockDef = {
    name: spec.name,
    ...(horizontal.description ? { description: `${horizontal.description} (vertical)` } : {}),
    basePoint: { x: 0, y: 0 },
    entities: spec.entities,
    attributes: [...visible, ...pinAttrs, ...data],
  };
  // The pins above are the connections (acadeAttributes would only detect the ones on x = 0).
  const extra = acadeAttributes(b, family, wdtype || undefined).filter((a) => !PIN_TAG.test(a.tag));
  return { ...b, attributes: [...b.attributes, ...extra] };
}
