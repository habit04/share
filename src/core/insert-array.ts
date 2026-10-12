import type { InsertEntity } from './entities';
import type { Point } from './geometry';
import { add, rotate } from './geometry';
import { GeometryBudgetError } from './geometry-budget-error';

export const MAX_INSERT_ARRAY_INSTANCES = 100_000;

/** Native MINSERT uses positive UInt16 counts; spacing is in drawing units. */
export function insertArrayProblem(insert: InsertEntity): string | null {
  if (insert.columns === undefined && insert.rows === undefined && insert.columnSpacing === undefined && insert.rowSpacing === undefined) return null;
  for (const [name, value] of [['columns', insert.columns ?? 1], ['rows', insert.rows ?? 1]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535) return `INSERT ${name} must be an integer from 1 to 65535`;
  }
  const columns = insert.columns ?? 1, rows = insert.rows ?? 1;
  const dx = (columns - 1) * (insert.columnSpacing ?? 0), dy = (rows - 1) * (insert.rowSpacing ?? 0);
  if (![insert.columnSpacing ?? 0, insert.rowSpacing ?? 0, dx, dy].every(Number.isFinite)) return 'INSERT array spacing exceeds finite coordinate limits';
  for (const x of [0, dx]) for (const y of [0, dy]) {
    const point = add(insert.position, rotate({ x, y }, insert.rotation));
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return 'INSERT array positions exceed finite coordinate limits';
  }
  return null;
}

export function insertArrayCount(insert: InsertEntity): number {
  const problem = insertArrayProblem(insert);
  if (problem) throw new GeometryBudgetError(problem);
  return (insert.columns ?? 1) * (insert.rows ?? 1);
}

/** The array grid rotates with INSERT, but its spacing is independent of the block's scale. */
export function insertArrayPosition(insert: InsertEntity, row: number, column: number): Point {
  return add(insert.position, rotate({ x: column * (insert.columnSpacing ?? 0), y: row * (insert.rowSpacing ?? 0) }, insert.rotation));
}

/** Lazy instances retain shared attributes and block definitions; no geometry is allocated here. */
export function* insertArrayInstances(insert: InsertEntity): Generator<InsertEntity> {
  const count = insertArrayCount(insert);
  if (count > MAX_INSERT_ARRAY_INSTANCES) throw new GeometryBudgetError('Block expansion exceeds the safe geometry budget.');
  if (count === 1) { yield insert; return; }
  const { rows: _rows, columns: _columns, rowSpacing: _rowSpacing, columnSpacing: _columnSpacing, ...single } = insert;
  for (let row = 0; row < (insert.rows ?? 1); row += 1) for (let column = 0; column < (insert.columns ?? 1); column += 1) {
    yield { ...single, id: `${insert.id}:${row},${column}`, position: insertArrayPosition(insert, row, column) };
  }
}

/** Negative Y scales are represented by a half-turn; compensate the unscaled array grid. */
export function insertArrayFields(columns: number | null | undefined, rows: number | null | undefined, columnSpacing: number | null | undefined, rowSpacing: number | null | undefined, rotationOffset = 0): Pick<InsertEntity, 'columns' | 'rows' | 'columnSpacing' | 'rowSpacing'> {
  if (columns == null && rows == null && columnSpacing == null && rowSpacing == null) return {};
  if ((columns ?? 1) === 1 && (rows ?? 1) === 1 && (columnSpacing ?? 0) === 0 && (rowSpacing ?? 0) === 0) return {};
  const sign = rotationOffset === 0 ? 1 : -1;
  return { columns: columns ?? 1, rows: rows ?? 1, columnSpacing: (columnSpacing ?? 0) * sign, rowSpacing: (rowSpacing ?? 0) * sign };
}
