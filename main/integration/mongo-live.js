'use strict';
/**
 * Live integration harness: drives the REAL @custos/driver-mongodb through the
 * REAL ConnectionManager engine against a running MongoDB server. This is the
 * one path unit tests cannot prove — shell text → parser → driver → wire.
 *
 * Not part of `npm test` (filename is not *.test.js) because it needs a live
 * server. Unlike the MySQL harness this one seeds and drops its own database,
 * so it is safe to re-run against the same container:
 *
 *   docker compose -f db/docker-compose.yml up -d mongo
 *   CUSTOS_MONGO_HOST=127.0.0.1 CUSTOS_MONGO_PORT=27018 \
 *   node main/integration/mongo-live.js
 */
const assert = require('node:assert/strict');
const { DriverRegistry, ReadOnlyViolationError, ConfirmationRequiredError } = require('@custos/core');
const { MongoDbDriver } = require('@custos/driver-mongodb');
const { ConnectionManager, InMemoryConnectionStore, InMemorySecretStore } = require('../dist/engine/index.js');

const env = process.env;
const HOST = env.CUSTOS_MONGO_HOST ?? '127.0.0.1';
const PORT = Number(env.CUSTOS_MONGO_PORT ?? 27018);
const USER = env.CUSTOS_MONGO_USER ?? '';
const PASSWORD = env.CUSTOS_MONGO_PASSWORD ?? '';
const DATABASE = env.CUSTOS_MONGO_DB ?? 'custos_itest';

let passed = 0;
function ok(label, detail) {
  passed++;
  console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
}

/** Run one statement and return its first result set. */
async function run(manager, id, sql, extra = {}) {
  const result = await manager.runQuery({ connectionId: 'mongo', queryId: `q${++run.n}`, sql, ...extra });
  void id;
  return result;
}
run.n = 0;

/** The value of one column in the first row of a result set. */
function cell(result, column, rowIndex = 0) {
  const rs = result.resultSets[0];
  const index = rs.columns.findIndex((c) => c.name === column);
  assert.ok(index >= 0, `result has a "${column}" column (got ${rs.columns.map((c) => c.name).join(', ')})`);
  return rs.rows[rowIndex][index];
}

async function main() {
  const registry = new DriverRegistry();
  registry.register(new MongoDbDriver());
  const manager = new ConnectionManager(registry, new InMemoryConnectionStore(), new InMemorySecretStore());

  const params = { mode: 'fields', host: HOST, port: PORT, database: DATABASE };
  if (USER) params.user = USER;
  const secrets = PASSWORD ? { password: PASSWORD } : {};

  console.log(`\nCustos ↔ real MongoDB @ ${HOST}:${PORT}/${DATABASE}\n`);

  // 1. testConnection through the real driver
  const test = await manager.testConnection({ driverId: 'mongodb', params, secrets });
  assert.equal(test.ok, true, `testConnection should succeed (${test.message})`);
  ok('testConnection', `${test.serverVersion} in ${test.latencyMs}ms`);

  // 2. Save + open a writable connection
  await manager.saveConnection({ config: { id: 'mongo', name: 'mongo', driverId: 'mongodb', readOnly: false, params }, secrets });
  await manager.openConnection('mongo');
  ok('openConnection');

  // 3. Seed: a ragged collection, as a schemaless one really is.
  await run(manager, 'clean', 'db.people.drop()', { confirmDestructive: true }).catch(() => undefined);
  const seed = await run(manager, 'seed', `db.people.insertMany([
    { name: "ada", plan: "team", mrr: 480, joined: ISODate("2026-01-14T09:12:00Z"), traits: { region: "eu-west" } },
    { name: "grace", plan: "business", mrr: 1890, joined: ISODate("2026-02-03T16:40:00Z") },
    { name: "linus", mrr: "39", joined: ISODate("2026-02-19T11:05:00Z") },
    { name: "barbara", plan: "solo", mrr: 39, joined: ISODate("2026-03-07T08:22:00Z"), traits: { region: "ap-south" } }
  ])`);
  assert.equal(cell(seed, 'insertedCount'), 4, 'insertMany reports 4');
  ok('insertMany with ISODate + nested documents', '4 documents');

  // 4. Introspection: databases, collections, and INFERRED fields
  const dbs = await manager.listDatabases('mongo');
  assert.ok(dbs.includes(DATABASE), 'listDatabases includes the target database');
  const collections = (await manager.listTables('mongo')).map((t) => t.name);
  assert.ok(collections.includes('people'), 'listTables finds the seeded collection');
  const columns = await manager.listColumns('mongo', { database: DATABASE, schema: null, name: 'people', kind: 'table' });
  const byName = Object.fromEntries(columns.map((c) => [c.name, c.dataType]));
  assert.equal(byName._id, 'objectId', '_id is reported as an ObjectId');
  assert.equal(byName.joined, 'date', 'dates are reported as dates');
  // `mrr` is a number on three documents and a string on one.
  assert.equal(byName.mrr, 'mixed', 'a field with two BSON types is reported as mixed');
  ok('inferred schema', columns.map((c) => `${c.name}:${c.dataType}`).join(', '));

  // 5. find with a filter, projection and chain
  const found = await run(manager, 'find', 'db.people.find({ mrr: { $gte: 480 } }, { name: 1, mrr: 1 }).sort({ mrr: -1 })');
  assert.equal(found.resultSets[0].rows.length, 2, 'two documents at or above 480');
  assert.equal(cell(found, 'name'), 'grace', 'sorted by mrr descending');
  ok('find + projection + sort', `${found.resultSets[0].rows.length} documents in ${found.executionMs}ms`);

  // 6. An ObjectId round-trips from the grid back into a query
  const id = cell(found, '_id');
  const byId = await run(manager, 'byId', `db.people.find({ _id: ObjectId("${id}") })`);
  assert.equal(cell(byId, 'name'), 'grace', 'ObjectId("…") from a result finds that document again');
  ok('ObjectId round trip', String(id));

  // 7. Aggregation
  const agg = await run(manager, 'agg', 'db.people.aggregate([{ $group: { _id: "$plan", n: { $sum: 1 } } }, { $sort: { n: -1 } }])');
  assert.ok(agg.resultSets[0].rows.length >= 3, 'aggregation groups by plan');
  ok('aggregate', `${agg.resultSets[0].rows.length} groups`);

  // 8. maxRows caps the cursor and reports truncation. Seed enough documents
  // that the cap is far below the total, so the early stop is real.
  await run(manager, 'bulk', `db.big.insertMany([${Array.from({ length: 500 }, (_, i) => `{ i: ${i} }`).join(',')}])`);
  const capped = await run(manager, 'capped', 'db.big.find({}).sort({ i: 1 })', { maxRows: 5 });
  assert.equal(capped.resultSets[0].rows.length, 5, 'exactly maxRows documents');
  assert.equal(capped.resultSets[0].truncated, true, 'truncated flag is set');
  assert.deepEqual(capped.resultSets[0].rows.map((r) => r[r.length - 1]), [0, 1, 2, 3, 4], 'the first five, in order');
  const after = await run(manager, 'after', 'db.big.countDocuments({})');
  assert.equal(cell(after, 'count'), 500, 'connection is healthy after the cursor was closed early');
  ok('maxRows cap + early cursor stop', 'read 5 of 500, connection reused cleanly');

  // 9. A guarded write that really mutates
  const upd = await run(manager, 'upd', 'db.people.updateMany({ plan: "solo" }, { $set: { plan: "solo-plus" } })');
  assert.equal(cell(upd, 'modifiedCount'), 1, 'updateMany with a filter modified 1');
  const check = await run(manager, 'check', 'db.people.countDocuments({ plan: "solo-plus" })');
  assert.equal(cell(check, 'count'), 1, 'the write is visible');
  ok('guarded updateMany', 'wrote 1 document, verified');

  // 10. An unfiltered deleteMany is held for confirmation — and does NOT run
  await assert.rejects(
    run(manager, 'del', 'db.people.deleteMany({})'),
    ConfirmationRequiredError,
    'unfiltered deleteMany should require confirmation',
  );
  const stillThere = await run(manager, 'still', 'db.people.countDocuments({})');
  assert.equal(cell(stillThere, 'count'), 4, 'nothing was deleted while the confirmation was pending');
  ok('confirmation guard', 'unfiltered deleteMany paused (not executed)');

  // 11. Read-only refuses a write the SQL analyzer would never recognize
  await manager.saveConnection({ config: { id: 'ro', name: 'ro', driverId: 'mongodb', readOnly: true, params }, secrets });
  await manager.openConnection('ro');
  await assert.rejects(
    manager.runQuery({ connectionId: 'ro', queryId: 'ro1', sql: 'db.people.insertOne({ name: "nope" })' }),
    ReadOnlyViolationError,
    'read-only connection should refuse a write',
  );
  const roRead = await manager.runQuery({ connectionId: 'ro', queryId: 'ro2', sql: 'db.people.countDocuments({})' });
  assert.equal(roRead.resultSets[0].rows[0][0], 4, 'reads still work on a read-only connection');
  ok('read-only guard', 'insertOne refused, find allowed');

  // 12. Shell conveniences: show collections, use, runCommand
  const show = await run(manager, 'show', 'show collections');
  assert.ok(show.resultSets[0].rows.flat().includes('people'), '"show collections" lists people');
  const ping = await run(manager, 'ping', 'db.runCommand({ ping: 1 })');
  assert.equal(Number(cell(ping, 'ok')), 1, 'runCommand({ ping: 1 }) replies ok:1');
  ok('show collections / runCommand', `${show.resultSets[0].rows.length} collections, ping ok`);

  // 13. A batch runs statement by statement, one result set each
  const batch = await run(manager, 'batch', 'db.people.countDocuments({})\ndb.big.countDocuments({})');
  assert.equal(batch.resultSets.length, 2, 'two result sets from a two-statement batch');
  assert.equal(batch.resultSets[0].rows[0][0], 4);
  assert.equal(batch.resultSets[1].rows[0][0], 500);
  ok('multi-statement batch', 'two result sets: 4, 500');

  // 14. Indexes
  await run(manager, 'idx', 'db.people.createIndex({ name: 1 })');
  const indexes = await run(manager, 'idxs', 'db.people.getIndexes()');
  assert.ok(indexes.resultSets[0].rows.length >= 2, 'the new index is listed alongside _id_');
  ok('createIndex + getIndexes', `${indexes.resultSets[0].rows.length} indexes`);

  // 15. Clean up after ourselves so the harness is re-runnable
  await run(manager, 'drop', 'db.dropDatabase()', { confirmDestructive: true });
  const gone = await manager.listDatabases('mongo');
  assert.ok(!gone.includes(DATABASE), 'the test database was dropped');
  ok('dropDatabase (confirmed)', 'test database removed');

  await manager.dispose();
  console.log(`\n${passed} checks passed against real MongoDB.\n`);
}

main().catch((err) => {
  console.error('\nINTEGRATION FAILED:', err);
  process.exit(1);
});
