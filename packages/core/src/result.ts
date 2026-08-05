import type { ColumnMeta, ResultSet, SqlValue } from './types';

/**
 * Build a normalized {@link ResultSet} from a driver's native row objects.
 *
 * Drivers typically hand back an array of `{ column: value }` objects plus some
 * column metadata. This maps them to positional rows aligned to `columns`,
 * applying an optional row cap. Keeping this in core means every driver
 * normalizes results the same way and the grid can rely on the shape.
 */
export function toResultSet(
  columns: ColumnMeta[],
  rowObjects: ReadonlyArray<Record<string, unknown>>,
  maxRows?: number,
): ResultSet {
  const cap = maxRows && maxRows > 0 ? maxRows : rowObjects.length;
  const limited = rowObjects.slice(0, cap);
  const rows: SqlValue[][] = limited.map((obj) =>
    columns.map((col) => (obj[col.name] ?? null) as SqlValue),
  );
  return {
    columns,
    rows,
    truncated: rowObjects.length > cap,
  };
}

/**
 * Build a {@link ResultSet} from already-positional rows (drivers that return
 * arrays rather than keyed objects), applying the same row cap.
 */
export function toResultSetFromArrays(
  columns: ColumnMeta[],
  rowArrays: ReadonlyArray<ReadonlyArray<unknown>>,
  maxRows?: number,
): ResultSet {
  const cap = maxRows && maxRows > 0 ? maxRows : rowArrays.length;
  const limited = rowArrays.slice(0, cap);
  const rows: SqlValue[][] = limited.map((arr) =>
    columns.map((_, i) => (arr[i] ?? null) as SqlValue),
  );
  return {
    columns,
    rows,
    truncated: rowArrays.length > cap,
  };
}

/** An empty result set for statements that return no rows (DML, DDL). */
export function emptyResultSet(): ResultSet {
  return { columns: [], rows: [], truncated: false };
}
