/**
 * The MongoDB half of Custos' guardian rules.
 *
 * Every driver's query text is classified before it runs, so a read-only
 * connection can refuse writes and a destructive statement can be held for
 * confirmation. The SQL analyzer in `@custos/core` keys off leading keywords,
 * which says nothing useful about `db.users.deleteMany({})` — so this module
 * implements {@link StatementAnalyzer} over the parsed shell statement instead.
 *
 * Same bias as the SQL side: conservative. Anything not recognized is
 * `unknown`, which a read-only connection still allows through to the server
 * (Mongo will refuse it if the user lacks the right), while everything known to
 * write is named explicitly.
 */
import type { StatementAnalysis, StatementAnalyzer, StatementKind } from '@custos/core';
import { parseStatement, splitStatements, type MongoStatement } from './parse';

/** Collection methods that only read. */
const READ_METHODS = new Set([
  'find',
  'findOne',
  'countDocuments',
  'estimatedDocumentCount',
  'count',
  'distinct',
  'getIndexes',
  'listIndexes',
  'indexes',
  'stats',
  'explain',
  'getIndexKeys',
  'dataSize',
  'totalSize',
  'isCapped',
]);

/** Collection methods that modify documents. */
const WRITE_METHODS = new Set([
  'insertOne',
  'insertMany',
  'insert',
  'updateOne',
  'updateMany',
  'update',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'remove',
  'save',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'findAndModify',
  'bulkWrite',
  'mapReduce',
]);

/** Collection methods that change structure. */
const DDL_METHODS = new Set([
  'createIndex',
  'createIndexes',
  'dropIndex',
  'dropIndexes',
  'drop',
  'renameCollection',
]);

/** Database-level methods, by kind. */
const DB_READ_METHODS = new Set([
  'getCollectionNames',
  'getCollectionInfos',
  'listCollections',
  'stats',
  'version',
  'serverStatus',
  'hostInfo',
  'currentOp',
  'getProfilingStatus',
]);
const DB_DDL_METHODS = new Set(['createCollection', 'createView', 'dropDatabase']);

/** `runCommand` command names, by kind — the command key is the first field. */
const COMMAND_KINDS: Record<string, StatementKind> = {
  find: 'read',
  aggregate: 'read',
  count: 'read',
  distinct: 'read',
  listCollections: 'read',
  listDatabases: 'read',
  listIndexes: 'read',
  dbStats: 'read',
  collStats: 'read',
  explain: 'read',
  serverStatus: 'read',
  buildInfo: 'read',
  hello: 'read',
  ping: 'read',
  insert: 'write',
  update: 'write',
  delete: 'write',
  findAndModify: 'write',
  create: 'ddl',
  createIndexes: 'ddl',
  drop: 'ddl',
  dropDatabase: 'ddl',
  dropIndexes: 'ddl',
  renameCollection: 'ddl',
  collMod: 'ddl',
};

function isEmptyFilter(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

/** True when an aggregation pipeline ends up writing to a collection. */
function pipelineWritesTo(pipeline: unknown): string | null {
  if (!Array.isArray(pipeline)) return null;
  for (const stage of pipeline) {
    if (!stage || typeof stage !== 'object') continue;
    const keys = Object.keys(stage as Record<string, unknown>);
    if (keys.includes('$out')) return '$out';
    if (keys.includes('$merge')) return '$merge';
  }
  return null;
}

/** The command name a `runCommand({...})` document invokes. */
function commandName(args: unknown[]): string | null {
  const doc = args[0];
  if (typeof doc === 'string') return doc;
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    return Object.keys(doc as Record<string, unknown>)[0] ?? null;
  }
  return null;
}

function analyzeCollection(
  stmt: Extract<MongoStatement, { kind: 'collection' }>,
): StatementAnalysis {
  const { method, args, collection, source } = stmt;
  let kind: StatementKind = 'unknown';
  let requiresConfirmation = false;
  let reason: string | undefined;

  if (method === 'aggregate') {
    const writeStage = pipelineWritesTo(args[0]);
    kind = writeStage ? 'write' : 'read';
    if (writeStage === '$out') {
      requiresConfirmation = true;
      reason = `$out replaces the entire target collection with this pipeline's output.`;
    }
  } else if (READ_METHODS.has(method)) {
    kind = 'read';
  } else if (WRITE_METHODS.has(method)) {
    kind = 'write';
  } else if (DDL_METHODS.has(method)) {
    kind = 'ddl';
  }

  if (!requiresConfirmation) {
    if ((method === 'deleteMany' || method === 'remove') && isEmptyFilter(args[0])) {
      requiresConfirmation = true;
      reason = `${method}() has an empty filter and will remove every document in "${collection}".`;
    } else if (method === 'updateMany' && isEmptyFilter(args[0])) {
      requiresConfirmation = true;
      reason = `updateMany() has an empty filter and will modify every document in "${collection}".`;
    } else if (method === 'drop') {
      requiresConfirmation = true;
      reason = `drop() permanently removes the "${collection}" collection and its indexes.`;
    } else if (method === 'dropIndexes') {
      requiresConfirmation = true;
      reason = `dropIndexes() removes every index on "${collection}".`;
    } else if (method === 'renameCollection') {
      requiresConfirmation = true;
      reason = `renameCollection() can overwrite an existing collection when dropTarget is set.`;
    }
  }

  return { sql: source, kind, keyword: method, requiresConfirmation, reason };
}

function analyzeDatabase(stmt: Extract<MongoStatement, { kind: 'database' }>): StatementAnalysis {
  const { method, args, source } = stmt;

  if (method === 'runCommand' || method === 'adminCommand') {
    const name = commandName(args);
    const kind: StatementKind = (name ? COMMAND_KINDS[name] : undefined) ?? 'unknown';
    const destructive = name === 'drop' || name === 'dropDatabase' || name === 'dropIndexes';
    return {
      sql: source,
      kind,
      keyword: name ? `${method}:${name}` : method,
      requiresConfirmation: destructive,
      reason: destructive ? `The "${name}" command permanently removes data.` : undefined,
    };
  }

  let kind: StatementKind = 'unknown';
  if (DB_READ_METHODS.has(method)) kind = 'read';
  else if (DB_DDL_METHODS.has(method)) kind = 'ddl';

  const isDropDatabase = method === 'dropDatabase';
  return {
    sql: source,
    kind,
    keyword: method,
    requiresConfirmation: isDropDatabase,
    reason: isDropDatabase ? 'dropDatabase() permanently removes the entire database.' : undefined,
  };
}

/** Classify one already-parsed statement. */
export function analyzeMongoStatement(stmt: MongoStatement): StatementAnalysis {
  switch (stmt.kind) {
    case 'use':
      return { sql: stmt.source, kind: 'read', keyword: 'use', requiresConfirmation: false };
    case 'show':
      return { sql: stmt.source, kind: 'read', keyword: 'show', requiresConfirmation: false };
    case 'collection':
      return analyzeCollection(stmt);
    case 'database':
      return analyzeDatabase(stmt);
  }
}

/**
 * Classify every statement in a batch. Statements that fail to parse are
 * reported as `unknown` rather than throwing: analysis runs on every keystroke
 * path (read-only checks, the confirm dialog), and a half-typed statement must
 * not blow up the UI. The parse error surfaces later, when the batch is run.
 */
export function analyzeBatch(source: string): StatementAnalysis[] {
  return splitStatements(source).map((text) => {
    try {
      return analyzeMongoStatement(parseStatement(text));
    } catch {
      return { sql: text, kind: 'unknown' as const, keyword: '', requiresConfirmation: false };
    }
  });
}

/** The MongoDB implementation of {@link StatementAnalyzer}. */
export const mongoAnalyzer: StatementAnalyzer = { analyzeBatch };
