/**
 * SQL safety guards — the "guardian" the product is named for.
 *
 * These are deliberately lightweight, dependency-free heuristics, not a full
 * SQL parser. They are tuned to be conservative: a false positive (asking the
 * user to confirm something harmless) is acceptable; the goal is to avoid false
 * negatives on the dangerous cases (unguarded UPDATE/DELETE, TRUNCATE, DROP).
 */

export type StatementKind = 'read' | 'write' | 'ddl' | 'tcl' | 'unknown';

export interface StatementAnalysis {
  readonly sql: string;
  readonly kind: StatementKind;
  /** The leading keyword, lowercased (e.g. "select", "update"). */
  readonly keyword: string;
  /** True when running this could silently mutate or destroy a lot of data. */
  readonly requiresConfirmation: boolean;
  /** Human-readable reason shown in the confirm dialog, when applicable. */
  readonly reason?: string;
}

const WRITE_KEYWORDS = new Set([
  'insert',
  'update',
  'delete',
  'merge',
  'replace',
  'upsert',
  'truncate',
]);
const DDL_KEYWORDS = new Set(['create', 'alter', 'drop', 'rename']);
const TCL_KEYWORDS = new Set(['begin', 'commit', 'rollback', 'savepoint', 'start']);
const READ_KEYWORDS = new Set([
  'select',
  'show',
  'describe',
  'desc',
  'explain',
  'with',
  'pragma',
  'use',
  'set',
]);

/** Remove `-- line` and `/* block *\/` comments so keyword detection is clean. */
export function stripSqlComments(sql: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inSingle) {
      out += ch;
      if (ch === "'" && next === "'") {
        out += next;
        i++;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"') inDouble = false;
      continue;
    }

    if (ch === '-' && next === '-') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Split a batch into individual statements on top-level semicolons, respecting
 * string literals and comments. Best-effort — good enough for read-only
 * enforcement and confirmation prompts, not a substitute for the server parser.
 */
export function splitStatements(sql: string): string[] {
  const stripped = stripSqlComments(sql);
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]!;
    const next = stripped[i + 1];

    if (inSingle) {
      current += ch;
      if (ch === "'" && next === "'") {
        current += next;
        i++;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** The leading SQL keyword of a single statement, lowercased. */
export function firstKeyword(statement: string): string {
  const match = stripSqlComments(statement)
    .trim()
    .match(/^[a-zA-Z_]+/);
  return match ? match[0].toLowerCase() : '';
}

function classify(keyword: string): StatementKind {
  if (WRITE_KEYWORDS.has(keyword)) return 'write';
  if (DDL_KEYWORDS.has(keyword)) return 'ddl';
  if (TCL_KEYWORDS.has(keyword)) return 'tcl';
  if (READ_KEYWORDS.has(keyword)) return 'read';
  return 'unknown';
}

/** Does this single statement contain a top-level WHERE clause? */
function hasWhereClause(statement: string): boolean {
  return /\bwhere\b/i.test(stripSqlComments(statement));
}

/** Analyze a single statement for kind and whether it warrants confirmation. */
export function analyzeStatement(statement: string): StatementAnalysis {
  const keyword = firstKeyword(statement);
  const kind = classify(keyword);

  let requiresConfirmation = false;
  let reason: string | undefined;

  if ((keyword === 'update' || keyword === 'delete') && !hasWhereClause(statement)) {
    requiresConfirmation = true;
    reason = `${keyword.toUpperCase()} has no WHERE clause and will affect every row.`;
  } else if (keyword === 'truncate') {
    requiresConfirmation = true;
    reason = 'TRUNCATE removes every row and cannot be rolled back on some engines.';
  } else if (keyword === 'drop') {
    requiresConfirmation = true;
    reason = 'DROP permanently removes a database object.';
  }

  return { sql: statement, kind, keyword, requiresConfirmation, reason };
}

/** Analyze every statement in a batch. */
export function analyzeBatch(sql: string): StatementAnalysis[] {
  return splitStatements(sql).map(analyzeStatement);
}

/** True when every statement in the batch is a read (safe on read-only). */
export function isReadOnlyBatch(sql: string): boolean {
  const analyses = analyzeBatch(sql);
  if (analyses.length === 0) return true;
  return analyses.every((a) => a.kind === 'read' || a.kind === 'tcl');
}

/**
 * The kinds that a read-only connection must refuse. Used by the engine to
 * enforce the per-connection read-only flag.
 */
export function firstMutatingKind(sql: string): StatementAnalysis | null {
  return analyzeBatch(sql).find((a) => a.kind === 'write' || a.kind === 'ddl') ?? null;
}
