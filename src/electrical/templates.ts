/**
 * Sheet templates: border, zone ticks and a title block with attributes,
 * like AutoCAD Electrical's ACAD_ELECTRICAL.dwt sheets. Units: inches.
 */
import type { Entity, BlockDef, InsertEntity } from '../core/entities';
import { newId } from '../core/entities';
import type { DrawingState } from '../core/document';
import { Drawing } from '../core/document';
import { LIBRARY_BLOCKS } from './library';

export interface SheetSize {
  key: string;
  name: string;
  width: number;
  height: number;
}

export const SHEET_SIZES: SheetSize[] = [
  { key: 'A', name: 'ANSI A  11 x 8.5 in (landscape)', width: 11, height: 8.5 },
  { key: 'B', name: 'ANSI B  17 x 11 in', width: 17, height: 11 },
  { key: 'C', name: 'ANSI C  22 x 17 in', width: 22, height: 17 },
  { key: 'D', name: 'ANSI D  34 x 22 in', width: 34, height: 22 },
  { key: 'A4', name: 'ISO A4  11.69 x 8.27 in (297 x 210 mm)', width: 11.69, height: 8.27 },
  { key: 'A3', name: 'ISO A3  16.54 x 11.69 in (420 x 297 mm)', width: 16.54, height: 11.69 },
];

const L = (x1: number, y1: number, x2: number, y2: number, layer = 'BORDER'): Entity => ({ id: newId(), layer, color: 'ByLayer', type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
const T = (x: number, y: number, text: string, h: number, align: 'left' | 'center' | 'right' = 'left', layer = 'BORDER'): Entity => ({ id: newId(), layer, color: 'ByLayer', type: 'text', position: { x, y }, text, height: h, rotation: 0, align });

/** The title block as a block definition with attributes (so its fields are editable and reportable). */
export const TITLE_BLOCK: BlockDef = {
  name: 'WD_TITLEBLOCK',
  description: 'Title block',
  basePoint: { x: 0, y: 0 },
  entities: [
    { id: newId(), layer: '0', color: 'ByLayer', type: 'polyline', closed: true, points: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 1.5 }, { x: 0, y: 1.5 }] },
    L(0, 0.5, 6, 0.5, '0'),
    L(0, 1.0, 6, 1.0, '0'),
    L(3.5, 0, 3.5, 1.0, '0'),
    L(4.75, 0, 4.75, 1.0, '0'),
    T(0.1, 1.35, 'PROJECT', 0.07),
    T(0.1, 0.85, 'TITLE', 0.07),
    T(3.6, 0.85, 'DRAWN', 0.07),
    T(4.85, 0.85, 'DATE', 0.07),
    T(0.1, 0.35, 'DRAWING NO.', 0.07),
    T(3.6, 0.35, 'REV', 0.07),
    T(4.85, 0.35, 'SHEET', 0.07),
  ],
  attributes: [
    { tag: 'PROJECT', prompt: 'Project', default: 'SAMPLE PROJECT', position: { x: 0.8, y: 1.1 }, height: 0.14, align: 'left' },
    { tag: 'TITLE', prompt: 'Drawing title', default: 'SCHEMATIC', position: { x: 0.8, y: 0.6 }, height: 0.14, align: 'left' },
    { tag: 'DRAWN', prompt: 'Drawn by', default: '', position: { x: 4.1, y: 0.6 }, height: 0.1, align: 'center' },
    { tag: 'DATE', prompt: 'Date', default: '', position: { x: 5.4, y: 0.6 }, height: 0.1, align: 'center' },
    { tag: 'DWGNO', prompt: 'Drawing number', default: '001', position: { x: 1.0, y: 0.12 }, height: 0.14, align: 'left' },
    { tag: 'REV', prompt: 'Revision', default: 'A', position: { x: 4.1, y: 0.12 }, height: 0.12, align: 'center' },
    { tag: 'SHEET', prompt: 'Sheet', default: '1 OF 1', position: { x: 5.4, y: 0.12 }, height: 0.1, align: 'center' },
  ],
};

/** Build border + title block entities for a sheet size. */
export function sheetEntities(size: SheetSize, fields: Partial<Record<string, string>> = {}): Entity[] {
  const m = 0.5; // margin
  const out: Entity[] = [];
  const W = size.width;
  const H = size.height;
  out.push({ id: newId(), layer: 'BORDER', color: 'ByLayer', type: 'polyline', closed: true, points: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }] });
  out.push({ id: newId(), layer: 'BORDER', color: 'ByLayer', type: 'polyline', closed: true, points: [{ x: m, y: m }, { x: W - m, y: m }, { x: W - m, y: H - m }, { x: m, y: H - m }] });
  // zone ticks and labels
  const cols = Math.max(4, Math.round((W - 2 * m) / 2.5));
  const rows = Math.max(2, Math.round((H - 2 * m) / 2.5));
  for (let i = 1; i < cols; i += 1) {
    const x = m + ((W - 2 * m) * i) / cols;
    out.push(L(x, 0, x, m), L(x, H - m, x, H));
  }
  for (let i = 0; i < cols; i += 1) {
    const x = m + ((W - 2 * m) * (i + 0.5)) / cols;
    out.push(T(x, 0.18, String(cols - i), 0.12, 'center'), T(x, H - 0.32, String(cols - i), 0.12, 'center'));
  }
  for (let i = 1; i < rows; i += 1) {
    const y = m + ((H - 2 * m) * i) / rows;
    out.push(L(0, y, m, y), L(W - m, y, W, y));
  }
  for (let i = 0; i < rows; i += 1) {
    const y = m + ((H - 2 * m) * (i + 0.5)) / rows;
    const label = String.fromCharCode(65 + i);
    out.push(T(m / 2, y - 0.07, label, 0.12, 'center'), T(W - m / 2, y - 0.07, label, 0.12, 'center'));
  }
  const tb: InsertEntity = {
    id: newId(),
    layer: 'BORDER',
    color: 'ByLayer',
    type: 'insert',
    block: TITLE_BLOCK.name,
    position: { x: W - m - 6, y: m },
    rotation: 0,
    scale: 1,
    attributes: Object.fromEntries(TITLE_BLOCK.attributes.map((a) => [a.tag, fields[a.tag] ?? a.default])),
  };
  out.push(tb);
  return out;
}

/** A fresh drawing state from a template. */
export function newFromTemplate(size: SheetSize, fields: Partial<Record<string, string>> = {}): DrawingState {
  const d = new Drawing();
  d.ensureBlocks([...LIBRARY_BLOCKS, TITLE_BLOCK]);
  d.addLayer({ name: 'BORDER', color: 7, visible: true, locked: false, lineWeight: 0.5 });
  d.addEntities(sheetEntities(size, fields));
  return d.snapshot;
}

/**
 * UPDATE TITLE BLOCK: write project / drawing fields into the title block
 * insert (only attributes the block defines). Returns false when the drawing
 * has no title block.
 */
export function updateTitleBlock(doc: Drawing, fields: Record<string, string>): boolean {
  const tb = doc.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === TITLE_BLOCK.name);
  if (!tb) return false;
  const def = doc.lookupBlock(TITLE_BLOCK.name) ?? TITLE_BLOCK;
  const allowed = new Set(def.attributes.map((a) => a.tag));
  const attrs = { ...tb.attributes };
  let changed = false;
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.has(k) || attrs[k] === v) continue;
    attrs[k] = v;
    changed = true;
  }
  if (changed) doc.replaceEntities([{ ...tb, attributes: attrs }]);
  return true;
}
