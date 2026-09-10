/**
 * Turning documents into the flat, positional {@link ResultSet} the grid draws.
 *
 * Two problems to solve. First, documents have no fixed shape: the columns are
 * the union of the top-level fields actually seen, in first-seen order (so
 * `_id` leads, as it does in every Mongo tool). Second, BSON values are class
 * instances — an `ObjectId` would not survive the IPC boundary (structured
 * clone in Electron, JSON in the web host) as anything the grid could render —
 * so every value is normalized to a plain JS value on the way out. Nested
 * documents and arrays stay structured; the grid JSON-stringifies them.
 */
import type { ColumnMeta, ResultSet, SqlValue } from '@custos/core';

/** A BSON value carries `_bsontype`; that is cheaper and safer than instanceof. */
function bsonType(value: object): string | null {
  const tag = (value as { _bsontype?: unknown })._bsontype;
  return typeof tag === 'string' ? tag : null;
}

/** Convert one BSON/JS value into something that survives IPC and renders. */
export function toSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;

  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
    return value as SqlValue;
  }
  if (value instanceof Date) return value;
  if (value instanceof RegExp) return `/${value.source}/${value.flags}`;
  if (Array.isArray(value)) return value.map(toSqlValue);

  if (type === 'object') {
    const tag = bsonType(value as object);
    switch (tag) {
      case 'ObjectId':
      case 'ObjectID':
      case 'Decimal128':
      case 'Code':
      case 'BSONSymbol':
      case 'Timestamp':
        return String(value);
      case 'Long': {
        // Keep exact values: only widen to a number when it round-trips.
        const asString = String(value);
        const asNumber = Number(asString);
        return Number.isSafeInteger(asNumber) ? asNumber : asString;
      }
      case 'Int32':
      case 'Double':
        return Number(value);
      case 'MinKey':
        return 'MinKey';
      case 'MaxKey':
        return 'MaxKey';
      case 'BSONRegExp': {
        const re = value as { pattern: string; options: string };
        return `/${re.pattern}/${re.options}`;
      }
      case 'Binary': {
        const bin = value as { sub_type?: number; toUUID?: () => unknown; buffer?: Uint8Array };
        // Subtype 4 is a UUID; show it as one rather than as base64.
        if (bin.sub_type === 4 && typeof bin.toUUID === 'function') {
          try {
            return String(bin.toUUID());
          } catch {
            /* fall through to base64 */
          }
        }
        return Buffer.from(bin.buffer ?? new Uint8Array()).toString('base64');
      }
      default:
        break;
    }
    if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
    // A plain sub-document: normalize its values too.
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toSqlValue(nested);
    }
    return out;
  }
  return String(value);
}

/** The type label shown in the grid header for one value. */
export function typeLabel(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (value instanceof RegExp) return 'regex';
  switch (typeof value) {
    case 'string': return 'string';
    case 'boolean': return 'bool';
    case 'bigint': return 'long';
    case 'number': return Number.isInteger(value) ? 'int' : 'double';
    case 'object': break;
    default: return 'unknown';
  }
  const tag = bsonType(value as object);
  switch (tag) {
    case 'ObjectId':
    case 'ObjectID': return 'objectId';
    case 'Long': return 'long';
    case 'Int32': return 'int';
    case 'Double': return 'double';
    case 'Decimal128': return 'decimal';
    case 'Binary': return (value as { sub_type?: number }).sub_type === 4 ? 'uuid' : 'binary';
    case 'Timestamp': return 'timestamp';
    case 'MinKey': return 'minKey';
    case 'MaxKey': return 'maxKey';
    case 'BSONRegExp': return 'regex';
    case 'Code': return 'javascript';
    case 'DBRef': return 'dbRef';
    default: return 'object';
  }
}

/**
 * Build a result set from documents: columns are the union of top-level fields
 * in first-seen order, and a field holding more than one BSON type is labelled
 * `mixed` (which is honest about a schemaless collection rather than picking
 * whichever type happened to come first).
 */
export function documentsToResultSet(
  documents: ReadonlyArray<Record<string, unknown>>,
  truncated = false,
): ResultSet {
  const order: string[] = [];
  const types = new Map<string, string>();

  for (const doc of documents) {
    for (const [key, value] of Object.entries(doc)) {
      if (!types.has(key)) {
        order.push(key);
        types.set(key, typeLabel(value));
      } else if (value !== null && value !== undefined) {
        const seen = types.get(key)!;
        const current = typeLabel(value);
        if (seen === 'null') types.set(key, current);
        else if (seen !== current && seen !== 'mixed') types.set(key, 'mixed');
      }
    }
  }

  const columns: ColumnMeta[] = order.map((name) => ({
    name,
    dataType: types.get(name) ?? 'unknown',
    // A field missing from a document reads as null, so every column is nullable.
    nullable: true,
  }));

  const rows: SqlValue[][] = documents.map((doc) =>
    order.map((name) => (name in doc ? toSqlValue(doc[name]) : null)),
  );

  return { columns, rows, truncated };
}

/** A one-row result set built from a summary object (write results, stats). */
export function summaryResultSet(summary: Record<string, unknown>): ResultSet {
  return documentsToResultSet([summary]);
}

/** A single-column result set listing names (`show dbs`, `show collections`). */
export function nameListResultSet(columnName: string, names: readonly string[]): ResultSet {
  return {
    columns: [{ name: columnName, dataType: 'string', nullable: false }],
    rows: names.map((name) => [name]),
    truncated: false,
  };
}
