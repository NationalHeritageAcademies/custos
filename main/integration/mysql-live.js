'use strict';
/**
 * Live integration harness: drives the REAL @custos/driver-mysql through the
 * REAL ConnectionManager engine against a running MySQL server. This is the
 * one path the in-browser demo backend cannot prove — actual driver → engine →
 * database wire.
 *
 * Not part of `npm test` (filename is not *.test.js) because it needs a live DB.
 * Run with a seeded MySQL reachable via the env below:
 *
 *   CUSTOS_MYSQL_HOST=127.0.0.1 CUSTOS_MYSQL_PORT=3307 CUSTOS_MYSQL_USER=root \
 *   CUSTOS_MYSQL_PASSWORD= CUSTOS_MYSQL_DB=shopdb \
 *   node main/integration/mysql-live.js
 */
const assert = require('node:assert/strict');
const { DriverRegistry, ReadOnlyViolationError, ConfirmationRequiredError } = require('@custos/core');
const { MySqlDriver } = require('@custos/driver-mysql');
const { ConnectionManager, InMemoryConnectionStore, InMemorySecretStore } = require('../dist/engine/index.js');

const env = process.env;
const HOST = env.CUSTOS_MYSQL_HOST ?? '127.0.0.1';
const PORT = Number(env.CUSTOS_MYSQL_PORT ?? 3307);
const USER = env.CUSTOS_MYSQL_USER ?? 'root';
const PASSWORD = env.CUSTOS_MYSQL_PASSWORD ?? '';
const DATABASE = env.CUSTOS_MYSQL_DB ?? 'shopdb';

let passed = 0;
function ok(label, detail) {
  passed++;
  console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  const registry = new DriverRegistry();
  registry.register(new MySqlDriver());
  const manager = new ConnectionManager(registry, new InMemoryConnectionStore(), new InMemorySecretStore());

  const params = { host: HOST, port: PORT, user: USER, database: DATABASE };
  const secrets = PASSWORD ? { password: PASSWORD } : {};

  console.log(`\nCustos ↔ real MySQL @ ${HOST}:${PORT}/${DATABASE}\n`);

  // 1. testConnection through the real driver
  const test = await manager.testConnection({ driverId: 'mysql', params, secrets });
  assert.equal(test.ok, true, 'testConnection should succeed');
  ok('testConnection', `${test.serverVersion} in ${test.latencyMs}ms`);

  // 2. Save + open a writable connection
  await manager.saveConnection({ config: { id: 'shop', name: 'shop', driverId: 'mysql', readOnly: false, params }, secrets });
  await manager.openConnection('shop');
  ok('openConnection');

  // 3. Schema introspection
  const dbs = await manager.listDatabases('shop');
  assert.ok(dbs.includes(DATABASE), 'listDatabases includes the target db');
  const tables = await manager.listTables('shop');
  const names = tables.map((t) => t.name).sort();
  assert.deepEqual(names, ['customers', 'products'], 'listTables finds seeded tables');
  ok('introspection', `${dbs.length} databases, tables: ${names.join(', ')}`);

  const columns = await manager.listColumns('shop', { schema: null, name: 'products', kind: 'table' });
  const colNames = columns.map((c) => `${c.name}:${c.dataType}`);
  assert.ok(colNames.includes('price:decimal'), 'columns carry real types');
  ok('getColumns', colNames.join(', '));

  // 4. Run a real SELECT
  const res = await manager.runQuery({ connectionId: 'shop', queryId: 'q1', sql: 'SELECT sku, name, price, in_stock FROM products ORDER BY price DESC' });
  const rs = res.resultSets[0];
  assert.equal(rs.rows.length, 7, 'SELECT returns all 7 products');
  assert.equal(rs.columns[0].name, 'sku');
  ok('SELECT', `${rs.rows.length} rows in ${res.executionMs}ms · top: ${rs.rows[0][1]} @ ${rs.rows[0][2]}`);

  // 5. maxRows truncation
  const capped = await manager.runQuery({ connectionId: 'shop', queryId: 'q2', sql: 'SELECT * FROM products', maxRows: 3 });
  assert.equal(capped.resultSets[0].rows.length, 3);
  assert.equal(capped.resultSets[0].truncated, true);
  ok('maxRows cap', 'fetched 3 of 7, truncated=true');

  // 6. A guarded write that actually mutates
  const upd = await manager.runQuery({ connectionId: 'shop', queryId: 'q3', sql: "UPDATE products SET in_stock = in_stock + 5 WHERE sku = 'KB-001'" });
  assert.equal(upd.rowsAffected, 1, 'UPDATE ... WHERE affects 1 row');
  const check = await manager.runQuery({ connectionId: 'shop', queryId: 'q4', sql: "SELECT in_stock FROM products WHERE sku = 'KB-001'" });
  assert.equal(Number(check.resultSets[0].rows[0][0]), 47, 'stock incremented 42 -> 47');
  ok('guarded UPDATE ... WHERE', 'wrote 1 row, verified 42 -> 47');

  // 7. Destructive statement without WHERE requires confirmation (NOT run)
  await assert.rejects(
    manager.runQuery({ connectionId: 'shop', queryId: 'q5', sql: 'UPDATE products SET price = price' }),
    ConfirmationRequiredError,
    'unbounded UPDATE should require confirmation',
  );
  ok('confirmation guard', 'unbounded UPDATE paused (not executed)');

  // 8. Read-only connection blocks writes even with a WHERE
  await manager.saveConnection({ config: { id: 'shop-ro', name: 'shop-ro', driverId: 'mysql', readOnly: true, params }, secrets });
  await manager.openConnection('shop-ro');
  await assert.rejects(
    manager.runQuery({ connectionId: 'shop-ro', queryId: 'q6', sql: "UPDATE products SET price = 0 WHERE sku = 'KB-001'" }),
    ReadOnlyViolationError,
    'read-only connection should refuse writes',
  );
  ok('read-only guard', 'write refused on read-only connection');

  // 9. Connect to the SERVER without a database, then browse + pick one
  await manager.saveConnection({
    config: { id: 'srv', name: 'srv', driverId: 'mysql', readOnly: false, params: { host: HOST, port: PORT, user: USER } },
    secrets,
  });
  await manager.openConnection('srv');
  const allDbs = await manager.listDatabases('srv');
  assert.ok(allDbs.includes('shopdb') && allDbs.includes('warehouse'), 'server lists multiple databases');
  ok('connect without a database', `sees ${['shopdb', 'warehouse'].filter((d) => allDbs.includes(d)).join(', ')}`);

  // 10. Database-scoped table listing (each db shows its own tables)
  const shopTables = (await manager.listTables('srv', 'shopdb')).map((t) => t.name);
  const whTables = (await manager.listTables('srv', 'warehouse')).map((t) => t.name);
  assert.deepEqual(shopTables, ['customers', 'products'], 'shopdb tables');
  assert.deepEqual(whTables, ['shipments'], 'warehouse tables');
  // Each db reports its own tables — no bleed-through between databases.
  assert.ok(!whTables.includes('products'), 'warehouse does not see shopdb tables');
  ok('database-scoped listTables', `shopdb=[${shopTables}] warehouse=[${whTables}]`);

  // 11. Selecting a database sets the query context (server-side USE)
  await manager.setActiveDatabase('srv', 'shopdb');
  const inShop = await manager.runQuery({ connectionId: 'srv', queryId: 'd1', sql: 'SELECT COUNT(*) AS n FROM products' });
  assert.equal(Number(inShop.resultSets[0].rows[0][0]), 7, 'products count in shopdb');
  ok('use shopdb, then query it', 'SELECT count(products) = 7');

  await manager.setActiveDatabase('srv', 'warehouse');
  const inWh = await manager.runQuery({ connectionId: 'srv', queryId: 'd2', sql: 'SELECT COUNT(*) AS n FROM shipments' });
  assert.equal(Number(inWh.resultSets[0].rows[0][0]), 4, 'shipments count in warehouse');
  ok('switch to warehouse, then query it', 'SELECT count(shipments) = 4');

  // 12. Streaming a capped SELECT stops fetching early. Build a large table so
  // the cap is far below the row count, read with a small maxRows, and confirm
  // we get exactly the cap, the truncated flag, and the right rows in order —
  // and that the connection is healthy afterwards (early stream teardown must
  // not desync the protocol). The table is dropped again so re-runs against the
  // same server keep shopdb's table list pristine.
  await manager.runQuery({ connectionId: 'shop', queryId: 'sc0', sql: 'DROP TABLE IF EXISTS stream_big', confirmDestructive: true });
  await manager.runQuery({ connectionId: 'shop', queryId: 'sc', sql: 'CREATE TABLE stream_big (id INT AUTO_INCREMENT PRIMARY KEY, val VARCHAR(32))' });
  await manager.runQuery({ connectionId: 'shop', queryId: 'si', sql: "INSERT INTO stream_big (val) VALUES ('x')" });
  for (let i = 0; i < 16; i++) {
    await manager.runQuery({ connectionId: 'shop', queryId: `sd${i}`, sql: 'INSERT INTO stream_big (val) SELECT val FROM stream_big' });
  }
  const totalRows = Number(
    (await manager.runQuery({ connectionId: 'shop', queryId: 'st', sql: 'SELECT COUNT(*) AS n FROM stream_big' })).resultSets[0].rows[0][0],
  );
  // Authoritative first-5 via a buffered LIMIT query (ids may be non-contiguous:
  // MySQL 8 leaves auto-increment gaps for bulk INSERT ... SELECT).
  const expectedFirst5 = (
    await manager.runQuery({ connectionId: 'shop', queryId: 'se', sql: 'SELECT id FROM stream_big ORDER BY id LIMIT 5' })
  ).resultSets[0].rows.map((r) => Number(r[0]));
  const bigCapped = await manager.runQuery({ connectionId: 'shop', queryId: 'sb', sql: 'SELECT id FROM stream_big ORDER BY id', maxRows: 5 });
  assert.equal(bigCapped.resultSets[0].rows.length, 5, 'streamed exactly maxRows (5) rows');
  assert.equal(bigCapped.resultSets[0].truncated, true, 'truncated flag is set');
  assert.deepEqual(bigCapped.resultSets[0].rows.map((r) => Number(r[0])), expectedFirst5, 'streamed the correct first 5 rows, in order');
  const afterStream = await manager.runQuery({ connectionId: 'shop', queryId: 'sa', sql: 'SELECT 123 AS x' });
  assert.equal(Number(afterStream.resultSets[0].rows[0][0]), 123, 'connection healthy after early stream stop');
  await manager.runQuery({ connectionId: 'shop', queryId: 'scz', sql: 'DROP TABLE IF EXISTS stream_big', confirmDestructive: true });
  ok('streaming cap + early stop', `capped 5 of ${totalRows} rows, truncated, connection reused cleanly`);

  // 13. Multi-statement batches still take the buffered path (two result sets).
  const multi = await manager.runQuery({ connectionId: 'shop', queryId: 'ms', sql: 'SELECT 1 AS a; SELECT 2 AS b', maxRows: 10 });
  assert.equal(multi.resultSets.length, 2, 'two result sets from a multi-statement batch');
  assert.equal(Number(multi.resultSets[0].rows[0][0]), 1);
  assert.equal(Number(multi.resultSets[1].rows[0][0]), 2);
  ok('multi-statement (buffered path)', 'two result sets: 1, 2');

  await manager.dispose();
  console.log(`\n${passed} checks passed against real MySQL.\n`);
}

main().catch((err) => {
  console.error('\nINTEGRATION FAILED:', err);
  process.exit(1);
});
