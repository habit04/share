/**
 * TABLE entity: a grid of rows and columns with cell text (title, header and
 * data rows), merged cells and borders. The geometry (border lines and one
 * MTEXT per cell) is generated from the cell data, so editing a cell only
 * changes data; the insertion point is the table's top-left corner.
 */
import type { Point } from './geometry';
import * as g from './geometry';
import type { EntityBase } from './entities';
import type { MTextAttachment, MTextEntity } from './mtext';

export interface TableCell {
  /** Plain cell text (paragraphs separated by '\n'). */
  readonly text: string;
  /** Formatted DXF content when it still matches `text` (see MTextEntity.raw). */
  readonly raw?: string;
  /** Text height override. */
  readonly height?: number;
  readonly attachment?: MTextAttachment;
  /** Merged cell spanning several rows / columns (set on the top-left cell of the range). */
  readonly span?: { readonly rows: number; readonly cols: number };
}

export interface TableEntity extends EntityBase {
  readonly type: 'table';
  /** Top-left corner. */
  readonly position: Point;
  /** Radians (DXF horizontal direction vector). */
  readonly rotation: number;
  readonly rowHeights: readonly number[];
  readonly columnWidths: readonly number[];
  /** cells[row][column]. */
  readonly cells: readonly (readonly TableCell[])[];
  /** Default text height for data cells. */
  readonly textHeight: number;
  /** Horizontal / vertical cell margin (0.06 in the Standard table style). */
  readonly margin?: number;
}

export const TABLE_DEFAULTS = { margin: 0.06, titleHeight: 0.25, textHeight: 0.18, columnWidth: 2.5 };

/** Row height that fits `lines` lines of text of height h with the cell margins. */
export function rowHeightFor(lines: number, h: number, margin = TABLE_DEFAULTS.margin): number {
  return Math.max(1, lines) * h * (4 / 3) + 2 * margin;
}

export interface NewTableOptions {
  position: Point;
  columns: number;
  /** Data rows (title and header rows come on top when enabled). */
  dataRows: number;
  columnWidth?: number;
  /** Row height in lines of text. */
  rowLines?: number;
  textHeight?: number;
  title?: boolean;
  header?: boolean;
}

/** A new Standard-style table: optional title row (merged), header row and data rows. */
export function newTable(base: EntityBase, o: NewTableOptions): TableEntity {
  const th = o.textHeight ?? TABLE_DEFAULTS.textHeight;
  const cols = Math.max(1, Math.round(o.columns));
  const title = o.title !== false;
  const header = o.header !== false;
  const lines = o.rowLines ?? 1;
  const rows: TableCell[][] = [];
  const heights: number[] = [];
  if (title) {
    rows.push(Array.from({ length: cols }, (_, c) => (c === 0 ? { text: '', height: TABLE_DEFAULTS.titleHeight, attachment: 5 as MTextAttachment, ...(cols > 1 ? { span: { rows: 1, cols } } : {}) } : { text: '' })));
    heights.push(rowHeightFor(lines, TABLE_DEFAULTS.titleHeight));
  }
  if (header) {
    rows.push(Array.from({ length: cols }, () => ({ text: '', attachment: 5 as MTextAttachment })));
    heights.push(rowHeightFor(lines, th));
  }
  for (let r = 0; r < Math.max(1, Math.round(o.dataRows)); r += 1) {
    rows.push(Array.from({ length: cols }, () => ({ text: '', attachment: 2 as MTextAttachment })));
    heights.push(rowHeightFor(lines, th));
  }
  return {
    ...base,
    type: 'table',
    position: o.position,
    rotation: 0,
    rowHeights: heights,
    columnWidths: Array.from({ length: cols }, () => o.columnWidth ?? TABLE_DEFAULTS.columnWidth),
    cells: rows,
    textHeight: th,
  };
}

/** For every grid position, the [row, col] of the (merged) cell that covers it. */
export function cellOwners(t: Pick<TableEntity, 'cells' | 'rowHeights' | 'columnWidths'>): Array<Array<[number, number]>> {
  const R = t.rowHeights.length;
  const C = t.columnWidths.length;
  const own: Array<Array<[number, number]>> = Array.from({ length: R }, (_, r) => Array.from({ length: C }, (_, c) => [r, c] as [number, number]));
  for (let r = 0; r < R; r += 1) {
    for (let c = 0; c < C; c += 1) {
      const span = t.cells[r]?.[c]?.span;
      if (!span || own[r]![c]![0] !== r || own[r]![c]![1] !== c) continue;
      for (let rr = r; rr < Math.min(R, r + span.rows); rr += 1) for (let cc = c; cc < Math.min(C, c + span.cols); cc += 1) own[rr]![cc] = [r, c];
    }
  }
  return own;
}

const sum = (a: readonly number[], from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i += 1) s += a[i] ?? 0;
  return s;
};

export interface TableGeometry {
  lines: Array<[Point, Point]>;
  texts: MTextEntity[];
}

/** Border lines and cell texts in world space. */
export function tableGeometry(t: TableEntity): TableGeometry {
  const R = t.rowHeights.length;
  const C = t.columnWidths.length;
  const own = cellOwners(t);
  const same = (a: [number, number] | undefined, b: [number, number] | undefined) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
  const xs = [0];
  for (let c = 0; c < C; c += 1) xs.push(xs[c]! + t.columnWidths[c]!);
  const ys = [0];
  for (let r = 0; r < R; r += 1) ys.push(ys[r]! - t.rowHeights[r]!);
  const W = (p: Point) => g.add(t.position, g.rotate(p, t.rotation));
  const lines: Array<[Point, Point]> = [];
  // Horizontal borders: between rows r-1 and r, skip columns inside one merged cell; join runs.
  for (let r = 0; r <= R; r += 1) {
    let start: number | null = null;
    for (let c = 0; c <= C; c += 1) {
      const draw = c < C && (r === 0 || r === R || !same(own[r - 1]?.[c], own[r]?.[c]));
      if (draw && start === null) start = c;
      if (!draw && start !== null) {
        lines.push([W({ x: xs[start]!, y: ys[r]! }), W({ x: xs[c]!, y: ys[r]! })]);
        start = null;
      }
    }
  }
  for (let c = 0; c <= C; c += 1) {
    let start: number | null = null;
    for (let r = 0; r <= R; r += 1) {
      const draw = r < R && (c === 0 || c === C || !same(own[r]?.[c - 1], own[r]?.[c]));
      if (draw && start === null) start = r;
      if (!draw && start !== null) {
        lines.push([W({ x: xs[c]!, y: ys[start]! }), W({ x: xs[c]!, y: ys[r]! })]);
        start = null;
      }
    }
  }
  const margin = t.margin ?? TABLE_DEFAULTS.margin;
  const texts: MTextEntity[] = [];
  for (let r = 0; r < R; r += 1) {
    for (let c = 0; c < C; c += 1) {
      if (own[r]![c]![0] !== r || own[r]![c]![1] !== c) continue;
      const cell = t.cells[r]?.[c];
      if (!cell || !cell.text) continue;
      const span = cell.span ?? { rows: 1, cols: 1 };
      const x0 = xs[c]!;
      const w = sum(t.columnWidths, c, Math.min(C, c + span.cols));
      const y0 = ys[r]!;
      const h = sum(t.rowHeights, r, Math.min(R, r + span.rows));
      const att = cell.attachment ?? 5;
      const col = (att - 1) % 3;
      const row = Math.floor((att - 1) / 3);
      const ax = col === 0 ? x0 + margin : col === 1 ? x0 + w / 2 : x0 + w - margin;
      const ay = row === 0 ? y0 - margin : row === 1 ? y0 - h / 2 : y0 - h + margin;
      texts.push({
        id: `${t.id}:c${r}_${c}`,
        layer: t.layer,
        color: t.color,
        ...(t.trueColor !== undefined ? { trueColor: t.trueColor } : {}),
        type: 'mtext',
        position: W({ x: ax, y: ay }),
        text: cell.text,
        ...(cell.raw ? { raw: cell.raw } : {}),
        height: cell.height ?? t.textHeight,
        width: Math.max(0, w - 2 * margin),
        rotation: t.rotation,
        attachment: att,
        lineSpacing: 1,
      });
    }
  }
  return { lines, texts };
}

/** The (merged) cell under a world point, or null outside the table. */
export function cellAt(t: TableEntity, p: Point): { row: number; col: number } | null {
  const local = g.rotate(g.sub(p, t.position), -t.rotation);
  if (local.x < 0 || local.y > 0) return null;
  let c = -1;
  let x = 0;
  for (let i = 0; i < t.columnWidths.length; i += 1) {
    x += t.columnWidths[i]!;
    if (local.x <= x) {
      c = i;
      break;
    }
  }
  let r = -1;
  let y = 0;
  for (let i = 0; i < t.rowHeights.length; i += 1) {
    y -= t.rowHeights[i]!;
    if (local.y >= y) {
      r = i;
      break;
    }
  }
  if (r < 0 || c < 0) return null;
  const [or, oc] = cellOwners(t)[r]![c]!;
  return { row: or, col: oc };
}

/** Replace one cell's text (dropping stale formatting). */
export function setCellText(t: TableEntity, row: number, col: number, text: string): TableEntity {
  const cells = t.cells.map((rr, r) => (r !== row ? rr : rr.map((cell, c) => (c !== col ? cell : { ...cell, text, raw: undefined }))));
  return { ...t, cells };
}

/** Overall width and height. */
export function tableSize(t: TableEntity): { width: number; height: number } {
  return { width: sum(t.columnWidths, 0, t.columnWidths.length), height: sum(t.rowHeights, 0, t.rowHeights.length) };
}
