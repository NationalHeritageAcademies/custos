/**
 * MongoDB driver for Custos.
 *
 * The shape is the same as the SQL drivers — one {@link DatabaseDriver}, one
 * {@link DriverConnection} — but two things differ, and both are handled
 * without special-casing MongoDB anywhere outside this package:
 *
 *  - **The language is not SQL.** The editor's text is parsed as mongosh
 *    statements (see `./parse`), and the driver publishes its own
 *    {@link StatementAnalyzer} (see `./analyze`) so the read-only flag and the
 *    destructive-statement confirmation work exactly as they do for SQL.
 *  - **There is no schema.** Collections have no declared columns, so
 *    `getColumns` samples documents and reports the fields it finds; a field
 *    holding more than one BSON type is labelled `mixed`.
 *
 * Cursor-returning statements (`find`, `aggregate`) are read through the cursor
 * and stopped one document past `maxRows`, mirroring the capped streaming the
 * MySQL and Azure SQL drivers do: peak memory is bounded by the row cap rather
 * than by the size of the collection.
 */
import {
  MongoClient,
  type AggregationCursor,
  type Db,
  type Document,
  type FindCursor,
  type MongoClientOptions,
  type WithId,
} from 'mongodb';
import {
  ConnectionError,
  QueryError,
  emptyResultSet,
  type ColumnMeta,
  type ConnectionConfig,
  type ConnectionField,
  type ConnectionSecrets,
  type DatabaseDriver,
  type DriverCapabilities,
  type DriverConnection,
  type DriverMetadata,
  type ForeignKey,
  type QueryOptions,
  type QueryResult,
  type ResultSet,
  type TableRef,
  type TestConnectionResult,
} from '@custos/core';
import { parseBatch, type ChainCall, type MongoStatement } from './parse';
import { documentsToResultSet, nameListResultSet, summaryResultSet, toSqlValue } from './rows';
import { mongoAnalyzer } from './analyze';

export { mongoAnalyzer, analyzeMongoStatement } from './analyze';
export { parseBatch, parseStatement, parseLiteral, splitStatements } from './parse';
export { documentsToResultSet, toSqlValue, typeLabel } from './rows';

/** How many documents `getColumns` samples to infer a collection's fields. */
const SCHEMA_SAMPLE_SIZE = 100;

const METADATA: DriverMetadata = {
  id: 'mongodb',
  displayName: 'MongoDB',
  iconId: 'mongodb',
};

const CAPABILITIES: DriverCapabilities = {
  // Mongo's "database → collection" has no schema level in between.
  supportsSchemas: false,
  supportsTransactions: true,
  // A batch runs statement by statement, each contributing a result set.
  supportsMultipleResultSets: true,
  supportsCancel: true,
  paramStyle: 'none',
  defaultPort: 27017,
  queryLanguage: 'mongodb',
};

const CONNECTION_FIELDS: ConnectionField[] = [
  {
    key: 'mode',
    label: 'Connect using',
    type: 'select',
    required: true,
    default: 'fields',
    options: [
      { value: 'fields', label: 'Host and port' },
      { value: 'uri', label: 'Connection string' },
    ],
  },
  {
    key: 'uri',
    label: 'Connection string',
    type: 'password',
    secret: true,
    required: true,
    placeholder: 'mongodb+srv://user:password@cluster.example.net/mydb',
    help: 'Kept in the OS keychain, because a connection string usually carries the password.',
    visibleWhen: { field: 'mode', equals: 'uri' },
  },
  {
    key: 'srv',
    label: 'DNS seed list (mongodb+srv)',
    type: 'boolean',
    default: false,
    help: 'For Atlas and other clusters advertised through SRV records. The port is taken from DNS.',
    visibleWhen: { field: 'mode', equals: 'fields' },
  },
  {
    key: 'host',
    label: 'Host',
    type: 'string',
    required: true,
    default: 'localhost',
    visibleWhen: { field: 'mode', equals: 'fields' },
  },
  {
    key: 'port',
    label: 'Port',
    type: 'number',
    default: 27017,
    visibleWhen: { field: 'mode', equals: 'fields' },
  },
  {
    key: 'database',
    label: 'Database',
    type: 'string',
    placeholder: 'optional — pick one from the tree later',
  },
  { key: 'user', label: 'User', type: 'string', visibleWhen: { field: 'mode', equals: 'fields' } },
  {
    key: 'password',
    label: 'Password',
    type: 'password',
    secret: true,
    visibleWhen: { field: 'mode', equals: 'fields' },
  },
  {
    key: 'authSource',
    label: 'Auth database',
    type: 'string',
    placeholder: 'admin',
    help: 'The database the user is defined in. Defaults to admin.',
    visibleWhen: { field: 'mode', equals: 'fields' },
  },
  {
    key: 'replicaSet',
    label: 'Replica set',
    type: 'string',
    placeholder: 'optional',
    visibleWhen: { field: 'mode', equals: 'fields' },
  },
  {
    key: 'tls',
    label: 'Use TLS',
    type: 'boolean',
    default: false,
    help: 'Require an encrypted connection. Always on for mongodb+srv.',
    visibleWhen: { field: 'mode', equals: 'fields' },
  },
];

/** The database a connection starts in when its params name one. */
function defaultDatabase(config: ConnectionConfig, uri: string): string | null {
  const named = config.params.database ? String(config.params.database) : '';
  if (named) return named;
  // A connection string may carry the database in its path.
  const path = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(uri);
  return path?.[1] ? decodeURIComponent(path[1]) : null;
}

/**
 * Fail with a clear message when a secret the chosen mode needs is missing,
 * before the client is built. Exported so it can be unit-tested offline.
 */
export function assertRequiredSecrets(
  config: ConnectionConfig,
  secrets: ConnectionSecrets,
): void {
  const mode = String(config.params.mode ?? 'fields');
  const missing = (what: string): never => {
    throw new ConnectionError(
      `This MongoDB connection is missing its ${what}. Re-enter it in the connection form and ` +
        `try again. (The web host keeps secrets in memory only, so they are cleared when it restarts.)`,
    );
  };
  if (mode === 'uri') {
    if (!secrets.uri) missing('connection string');
    return;
  }
  if (!config.params.host) missing('host');
  // A user without a password would silently attempt an unauthenticated login.
  if (config.params.user && !secrets.password) missing('password');
}

/** Build the connection string and client options for a saved connection. */
export function buildClientConfig(
  config: ConnectionConfig,
  secrets: ConnectionSecrets,
): { uri: string; options: MongoClientOptions } {
  const p = config.params;
  const options: MongoClientOptions = {
    // Fail fast rather than queueing behind a 30s default when a host is wrong.
    serverSelectionTimeoutMS: 8000,
    appName: 'Custos',
  };

  if (String(p.mode ?? 'fields') === 'uri') {
    return { uri: secrets.uri ?? '', options };
  }

  const srv = p.srv === true || p.srv === 'true';
  const host = String(p.host ?? 'localhost');
  // An SRV record supplies the port itself; adding one is an error.
  const hostPart = srv ? host : `${host}:${Number(p.port ?? CAPABILITIES.defaultPort)}`;
  const search = new URLSearchParams();
  if (p.authSource) search.set('authSource', String(p.authSource));
  if (p.replicaSet) search.set('replicaSet', String(p.replicaSet));
  if (p.tls === true || p.tls === 'true') search.set('tls', 'true');
  const query = search.toString();

  if (p.user) {
    options.auth = { username: String(p.user), password: secrets.password ?? '' };
  }
  return {
    uri: `mongodb${srv ? '+srv' : ''}://${hostPart}/${query ? `?${query}` : ''}`,
    options,
  };
}

/** What `collection.find()` hands back: documents are known to carry an `_id`. */
type FoundCursor = FindCursor<WithId<Document>>;

/** Cursor methods a `find()` chain may carry, and how each shapes the cursor. */
type CursorShaper = (cursor: FoundCursor, args: unknown[]) => FoundCursor;
const FIND_CHAIN: Record<string, CursorShaper> = {
  sort: (c, a) => c.sort((a[0] ?? {}) as Document),
  limit: (c, a) => c.limit(Number(a[0] ?? 0)),
  skip: (c, a) => c.skip(Number(a[0] ?? 0)),
  project: (c, a) => c.project((a[0] ?? {}) as Document) as FoundCursor,
  hint: (c, a) => c.hint(a[0] as Document),
  max: (c, a) => c.max((a[0] ?? {}) as Document),
  min: (c, a) => c.min((a[0] ?? {}) as Document),
  collation: (c, a) => c.collation(a[0] as never),
  maxTimeMS: (c, a) => c.maxTimeMS(Number(a[0] ?? 0)),
  batchSize: (c, a) => c.batchSize(Number(a[0] ?? 0)),
  // `.toArray()` / `.pretty()` are how a shell user asks for the documents; the
  // driver already returns them, so they are accepted and ignored.
  toArray: (c) => c,
  pretty: (c) => c,
};

class MongoConnection implements DriverConnection {
  private db: Db;
  /** Cursors currently being drained, so `close()` and cancel can stop them. */
  private readonly openCursors = new Set<{ close(): Promise<void> }>();

  constructor(
    private readonly client: MongoClient,
    initialDatabase: string | null,
  ) {
    this.db = client.db(initialDatabase ?? undefined);
  }

  async listDatabases(): Promise<string[]> {
    try {
      const result = await this.client.db('admin').admin().listDatabases({ nameOnly: true });
      return result.databases.map((d) => d.name).sort();
    } catch (err) {
      // listDatabases needs a cluster-wide right that a scoped user may lack;
      // fall back to the one database this connection can already see.
      if (this.db.databaseName) return [this.db.databaseName];
      throw new QueryError((err as Error).message, { cause: err });
    }
  }

  /** Mongo has no schema level between database and collection. */
  async listSchemas(): Promise<string[]> {
    return [];
  }

  async listTables(database?: string): Promise<TableRef[]> {
    const db = database ? this.client.db(database) : this.db;
    const infos = await db.listCollections({}, { nameOnly: true }).toArray();
    return infos
      .map((info) => ({
        database: db.databaseName,
        schema: null,
        name: String(info.name),
        kind: (info.type === 'view' ? 'view' : 'table') as TableRef['kind'],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Collections are schemaless, so "columns" are inferred: sample up to
   * {@link SCHEMA_SAMPLE_SIZE} documents and report the top-level fields found.
   * `$sample` is representative of a large collection; if the server refuses it
   * (a view, or a restricted right) fall back to the first N documents.
   */
  async getColumns(table: TableRef): Promise<ColumnMeta[]> {
    const db = table.database ? this.client.db(table.database) : this.db;
    const collection = db.collection(table.name);
    let documents: Document[];
    try {
      documents = await collection
        .aggregate([{ $sample: { size: SCHEMA_SAMPLE_SIZE } }])
        .toArray();
    } catch {
      documents = await collection.find({}).limit(SCHEMA_SAMPLE_SIZE).toArray();
    }
    return documentsToResultSet(documents as Record<string, unknown>[]).columns;
  }

  /** Mongo has no foreign keys; relationships are a modelling convention. */
  async getForeignKeys(): Promise<ForeignKey[]> {
    return [];
  }

  async useDatabase(database: string): Promise<void> {
    this.db = this.client.db(database);
  }

  async query(source: string, options: QueryOptions = {}): Promise<QueryResult> {
    const start = Date.now();
    const statements = parseBatch(source);
    if (statements.length === 0) {
      return { resultSets: [emptyResultSet()], rowsAffected: null, executionMs: 0 };
    }

    const resultSets: ResultSet[] = [];
    let rowsAffected: number | null = null;

    for (const statement of statements) {
      throwIfAborted(options.signal);
      const outcome = await this.runStatement(statement, options);
      resultSets.push(outcome.resultSet);
      if (outcome.rowsAffected !== null) {
        rowsAffected = (rowsAffected ?? 0) + outcome.rowsAffected;
      }
    }

    return { resultSets, rowsAffected, executionMs: Date.now() - start };
  }

  async close(): Promise<void> {
    await Promise.all([...this.openCursors].map((c) => c.close().catch(() => undefined)));
    this.openCursors.clear();
    await this.client.close();
  }

  // --- statement execution ---

  private async runStatement(
    statement: MongoStatement,
    options: QueryOptions,
  ): Promise<{ resultSet: ResultSet; rowsAffected: number | null }> {
    try {
      switch (statement.kind) {
        case 'use':
          await this.useDatabase(statement.database);
          return {
            resultSet: summaryResultSet({ switched: statement.database }),
            rowsAffected: null,
          };
        case 'show': {
          const names =
            statement.target === 'databases'
              ? await this.listDatabases()
              : (await this.listTables()).map((t) => t.name);
          return {
            resultSet: nameListResultSet(
              statement.target === 'databases' ? 'database' : 'collection',
              names,
            ),
            rowsAffected: null,
          };
        }
        case 'collection':
          return await this.runCollectionMethod(statement, options);
        case 'database':
          return await this.runDatabaseMethod(statement, options);
      }
    } catch (err) {
      if (err instanceof QueryError) throw err;
      throw new QueryError(`${(err as Error).message} — in: ${statement.source}`, { cause: err });
    }
  }

  private async runCollectionMethod(
    statement: Extract<MongoStatement, { kind: 'collection' }>,
    options: QueryOptions,
  ): Promise<{ resultSet: ResultSet; rowsAffected: number | null }> {
    const collection = this.db.collection(statement.collection);
    const { method, args, chain } = statement;
    const rows = (documents: Document[], truncated = false) => ({
      resultSet: documentsToResultSet(documents as Record<string, unknown>[], truncated),
      rowsAffected: null,
    });
    const summary = (value: Record<string, unknown>, affected: number | null = null) => ({
      resultSet: summaryResultSet(value),
      rowsAffected: affected,
    });

    switch (method) {
      case 'find': {
        let cursor = collection.find((args[0] ?? {}) as Document);
        if (args[1]) cursor = cursor.project(args[1] as Document) as FoundCursor;
        if (options.timeoutMs) cursor = cursor.maxTimeMS(options.timeoutMs);
        for (const call of chain) cursor = applyFindChain(cursor, call);
        // A `.count()` at the end of a chain asks for the number, not the rows.
        if (chain.at(-1)?.method === 'count') {
          const count = await collection.countDocuments((args[0] ?? {}) as Document);
          return summary({ count });
        }
        return this.drainCursor(cursor, options);
      }
      case 'findOne': {
        const document = await collection.findOne((args[0] ?? {}) as Document, {
          ...(args[1] as Document),
          ...(options.timeoutMs ? { maxTimeMS: options.timeoutMs } : {}),
        });
        return rows(document ? [document] : []);
      }
      case 'aggregate': {
        const pipeline = Array.isArray(args[0]) ? (args[0] as Document[]) : [];
        const cursor = this.db.collection(statement.collection).aggregate(pipeline, {
          ...(args[1] as Document),
          ...(options.timeoutMs ? { maxTimeMS: options.timeoutMs } : {}),
        });
        return this.drainCursor(cursor, options);
      }
      case 'countDocuments':
      case 'count':
        return summary({ count: await collection.countDocuments((args[0] ?? {}) as Document) });
      case 'estimatedDocumentCount':
        return summary({ count: await collection.estimatedDocumentCount() });
      case 'distinct': {
        const values = await collection.distinct(
          String(args[0] ?? ''),
          (args[1] ?? {}) as Document,
        );
        return {
          resultSet: documentsToResultSet(values.map((value) => ({ value }))),
          rowsAffected: null,
        };
      }
      case 'getIndexes':
      case 'listIndexes':
      case 'indexes':
        return rows(await collection.listIndexes().toArray());
      case 'stats':
        return summary(asRecord(await this.db.command({ collStats: statement.collection })));

      case 'insertOne': {
        const result = await collection.insertOne(requireDocument(args[0], 'insertOne'));
        return summary({ acknowledged: result.acknowledged, insertedId: toSqlValue(result.insertedId) }, 1);
      }
      case 'insertMany':
      case 'insert': {
        const documents = Array.isArray(args[0])
          ? (args[0] as Document[])
          : [requireDocument(args[0], method)];
        const result = await collection.insertMany(documents);
        return summary(
          { acknowledged: result.acknowledged, insertedCount: result.insertedCount },
          result.insertedCount,
        );
      }
      case 'updateOne':
      case 'updateMany':
      case 'update': {
        const filter = (args[0] ?? {}) as Document;
        const update = requireDocument(args[1], method);
        const opts = (args[2] ?? {}) as Document;
        const many = method === 'updateMany' || (method === 'update' && opts.multi === true);
        const result = many
          ? await collection.updateMany(filter, update, opts)
          : await collection.updateOne(filter, update, opts);
        return summary(
          {
            acknowledged: result.acknowledged,
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount,
            upsertedId: toSqlValue(result.upsertedId),
          },
          result.modifiedCount + (result.upsertedCount ?? 0),
        );
      }
      case 'replaceOne': {
        const result = await collection.replaceOne(
          (args[0] ?? {}) as Document,
          requireDocument(args[1], 'replaceOne'),
          (args[2] ?? {}) as Document,
        );
        return summary(
          {
            acknowledged: result.acknowledged,
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount,
          },
          result.modifiedCount,
        );
      }
      case 'deleteOne':
      case 'deleteMany':
      case 'remove': {
        const filter = (args[0] ?? {}) as Document;
        const result =
          method === 'deleteOne'
            ? await collection.deleteOne(filter)
            : await collection.deleteMany(filter);
        return summary(
          { acknowledged: result.acknowledged, deletedCount: result.deletedCount },
          result.deletedCount,
        );
      }
      case 'findOneAndUpdate': {
        const document = await collection.findOneAndUpdate(
          (args[0] ?? {}) as Document,
          requireDocument(args[1], 'findOneAndUpdate'),
          (args[2] ?? {}) as Document,
        );
        return rows(document ? [document] : []);
      }
      case 'findOneAndReplace': {
        const document = await collection.findOneAndReplace(
          (args[0] ?? {}) as Document,
          requireDocument(args[1], 'findOneAndReplace'),
          (args[2] ?? {}) as Document,
        );
        return rows(document ? [document] : []);
      }
      case 'findOneAndDelete': {
        const document = await collection.findOneAndDelete(
          (args[0] ?? {}) as Document,
          (args[1] ?? {}) as Document,
        );
        return rows(document ? [document] : []);
      }
      case 'bulkWrite': {
        const result = await collection.bulkWrite((args[0] ?? []) as never);
        return summary(
          {
            insertedCount: result.insertedCount,
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount,
            deletedCount: result.deletedCount,
            upsertedCount: result.upsertedCount,
          },
          result.insertedCount + result.modifiedCount + result.deletedCount + result.upsertedCount,
        );
      }

      case 'createIndex':
        return summary({
          index: await collection.createIndex(
            (args[0] ?? {}) as Document,
            (args[1] ?? {}) as Document,
          ),
        });
      case 'createIndexes':
        return summary({ indexes: await collection.createIndexes((args[0] ?? []) as never) });
      case 'dropIndex':
        return summary(asRecord(await collection.dropIndex(String(args[0] ?? ''))));
      case 'dropIndexes':
        return summary(asRecord(await collection.dropIndexes()));
      case 'drop':
        return summary({ dropped: await collection.drop() });
      case 'renameCollection':
        return summary({
          renamedTo: (
            await collection.rename(String(args[0] ?? ''), (args[1] ?? {}) as Document)
          ).collectionName,
        });
      default:
        throw new QueryError(
          `Custos does not support "${method}()" on a collection. ` +
            `Use db.runCommand({ … }) to send a command Custos does not model directly.`,
        );
    }
  }

  private async runDatabaseMethod(
    statement: Extract<MongoStatement, { kind: 'database' }>,
    options: QueryOptions,
  ): Promise<{ resultSet: ResultSet; rowsAffected: number | null }> {
    const { method, args } = statement;
    switch (method) {
      case 'runCommand':
      case 'adminCommand': {
        const command = requireDocument(args[0], method);
        const db = method === 'adminCommand' ? this.client.db('admin') : this.db;
        const reply = asRecord(await db.command(command));
        // Command replies that carry a cursor read better as their documents.
        const batch = (reply.cursor as { firstBatch?: Document[] } | undefined)?.firstBatch;
        return {
          resultSet: Array.isArray(batch)
            ? documentsToResultSet(batch as Record<string, unknown>[])
            : summaryResultSet(reply),
          rowsAffected: null,
        };
      }
      case 'getCollectionNames':
        return {
          resultSet: nameListResultSet('collection', (await this.listTables()).map((t) => t.name)),
          rowsAffected: null,
        };
      case 'getCollectionInfos':
      case 'listCollections':
        return {
          resultSet: documentsToResultSet(
            (await this.db.listCollections().toArray()) as Record<string, unknown>[],
          ),
          rowsAffected: null,
        };
      case 'stats':
        return { resultSet: summaryResultSet(asRecord(await this.db.command({ dbStats: 1 }))), rowsAffected: null };
      case 'version':
        return {
          resultSet: summaryResultSet({
            version: String(asRecord(await this.db.command({ buildInfo: 1 })).version ?? ''),
          }),
          rowsAffected: null,
        };
      case 'createCollection':
        await this.db.createCollection(String(args[0] ?? ''), (args[1] ?? {}) as Document);
        return { resultSet: summaryResultSet({ created: String(args[0] ?? '') }), rowsAffected: null };
      case 'dropDatabase':
        return { resultSet: summaryResultSet({ dropped: await this.db.dropDatabase() }), rowsAffected: null };
      case 'getSiblingDB':
        await this.useDatabase(String(args[0] ?? ''));
        return { resultSet: summaryResultSet({ switched: String(args[0] ?? '') }), rowsAffected: null };
      default:
        // An unknown `db.x()` is most likely a collection named `x` without a
        // method — say so, rather than "unsupported method".
        void options;
        throw new QueryError(
          `Custos does not support "db.${method}()". ` +
            `Use db.runCommand({ … }) to send a command Custos does not model directly.`,
        );
    }
  }

  /**
   * Read a cursor, keeping at most `maxRows` documents and closing it as soon
   * as one more arrives — which stops the server preparing further batches.
   * Peak memory is bounded by the cap, not by the size of the result.
   */
  private async drainCursor(
    cursor: FoundCursor | AggregationCursor<Document>,
    options: QueryOptions,
  ): Promise<{ resultSet: ResultSet; rowsAffected: number | null }> {
    const cap = options.maxRows && options.maxRows > 0 ? options.maxRows : Infinity;
    const documents: Document[] = [];
    let truncated = false;

    this.openCursors.add(cursor);
    const onAbort = (): void => void cursor.close().catch(() => undefined);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      for await (const document of cursor) {
        if (documents.length >= cap) {
          truncated = true;
          break;
        }
        documents.push(document);
      }
      throwIfAborted(options.signal);
    } catch (err) {
      throwIfAborted(options.signal);
      throw new QueryError((err as Error).message, { cause: err });
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.openCursors.delete(cursor);
      await cursor.close().catch(() => undefined);
    }

    return {
      resultSet: documentsToResultSet(documents as Record<string, unknown>[], truncated),
      rowsAffected: null,
    };
  }
}

/** Apply one chained cursor call, rejecting anything not in {@link FIND_CHAIN}. */
function applyFindChain(cursor: FoundCursor, call: ChainCall): FoundCursor {
  if (call.method === 'count') return cursor; // handled by the caller
  const shaper = FIND_CHAIN[call.method];
  if (!shaper) {
    throw new QueryError(`Custos does not support ".${call.method}()" on a find() cursor.`);
  }
  return shaper(cursor, call.args);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new QueryError('Query cancelled.');
}

function requireDocument(value: unknown, method: string): Document {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new QueryError(`${method}() needs a document argument, e.g. ${method}({ … }).`);
  }
  return value as Document;
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

export class MongoDbDriver implements DatabaseDriver {
  readonly metadata = METADATA;
  readonly capabilities = CAPABILITIES;
  readonly connectionFields = CONNECTION_FIELDS;
  // Not SQL: the guardian rules are enforced against parsed shell statements.
  readonly analyzer = mongoAnalyzer;

  async connect(config: ConnectionConfig, secrets: ConnectionSecrets): Promise<DriverConnection> {
    assertRequiredSecrets(config, secrets);
    const { uri, options } = buildClientConfig(config, secrets);
    let client: MongoClient | undefined;
    try {
      client = new MongoClient(uri, options);
      await client.connect();
      return new MongoConnection(client, defaultDatabase(config, uri));
    } catch (err) {
      await client?.close().catch(() => undefined);
      throw new ConnectionError((err as Error).message, { cause: err });
    }
  }

  async testConnection(
    config: ConnectionConfig,
    secrets: ConnectionSecrets,
  ): Promise<TestConnectionResult> {
    const start = Date.now();
    let client: MongoClient | undefined;
    try {
      assertRequiredSecrets(config, secrets);
      const { uri, options } = buildClientConfig(config, secrets);
      client = new MongoClient(uri, options);
      await client.connect();
      const info = await client.db('admin').command({ buildInfo: 1 });
      return {
        ok: true,
        message: 'Connected successfully.',
        serverVersion: info.version ? String(info.version) : undefined,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
}

export default MongoDbDriver;
