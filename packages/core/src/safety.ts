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

/**
 * A query language's safety analyzer. Every driver's query text is analyzed
 * before it runs (read-only enforcement, destructive-statement confirmation),
 * but not every driver speaks SQL — a driver supplies its own analyzer via
 * {@link DatabaseDriver.analyzer} and the engine uses that instead of
 * {@link sqlAnalyzer}. Analyzers are pure text heuristics: no connection, no
 * I/O, so they can run before anything is sent to a server.
 */
export interface StatementAnalyzer {
  /** Split a batch into statements and classify each one. */
  analyzeBatch(source: string): StatementAnalysis[];
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

/** The SQL implementation of {@link StatementAnalyzer}; the engine's default. */
export const sqlAnalyzer: StatementAnalyzer = { analyzeBatch };

/**
 * The first statement a read-only connection must refuse, given an already
 * computed analysis. Language-agnostic, so the engine can enforce read-only on
 * any driver's analyzer output.
 */
export function firstMutatingAnalysis(analyses: StatementAnalysis[]): StatementAnalysis | null {
  return analyses.find((a) => a.kind === 'write' || a.kind === 'ddl') ?? null;
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
  return firstMutatingAnalysis(analyzeBatch(sql));
}

/**
 * Statements a driver may stream row-by-row with an early stop: each always
 * produces a result set (so a row stream terminates rather than hanging on an
 * OK-packet / no-result-set statement) and none can front a write. `with` is
 * excluded because a CTE can lead a writing statement; `SELECT … INTO` is
 * excluded because it returns no result set. Shared by the streaming drivers
 * (MySQL, Azure SQL) so the gate can't drift between them.
 */
const STREAMABLE_KEYWORDS = new Set(['select', 'show', 'describe', 'desc', 'explain']);

/**
 * Whether a query should be streamed with an early stop rather than buffered.
 * Only a single, capped, result-set-returning statement qualifies — see
 * {@link STREAMABLE_KEYWORDS} for why the set is deliberately conservative.
 */
export function canStreamSelect(sql: string, maxRows: number | undefined): boolean {
  if (!maxRows || maxRows <= 0) return false; // no cap → nothing to stop early for
  const statements = splitStatements(sql);
  if (statements.length !== 1) return false; // multi-statement → buffered
  const only = statements[0]!;
  if (!STREAMABLE_KEYWORDS.has(firstKeyword(only))) return false;
  // `SELECT … INTO @var / INTO OUTFILE / INTO <table>` returns no result set.
  if (/\binto\b/i.test(stripSqlComments(only))) return false;
  return true;
}
