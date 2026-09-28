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
import { withAcadeAttributes } from './attributes';

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
