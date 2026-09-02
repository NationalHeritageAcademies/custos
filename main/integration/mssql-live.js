'use strict';
/**
 * Live integration harness: drives the REAL @custos/driver-azuresql through the
 * REAL ConnectionManager engine against a running SQL Server. Azure SQL and
 * SQL Server speak the same TDS protocol the driver uses (via mssql/tedious), so
 * this proves the streaming path the in-browser demo cannot.
 *
 * Not part of `npm test` (filename is not *.test.js) because it needs a live DB.
 * A throwaway SQL Server for Apple Silicon (azure-sql-edge is ARM-native):
 *
 *   docker run -d --name custos-mssql -e ACCEPT_EULA=Y \
 *     -e 'MSSQL_SA_PASSWORD=Custos!Passw0rd' -p 1434:1433 \
 *     mcr.microsoft.com/azure-sql-edge:latest
 *
 * then:
 *
 *   CUSTOS_MSSQL_HOST=127.0.0.1 CUSTOS_MSSQL_PORT=1434 CUSTOS_MSSQL_USER=sa \
 *   CUSTOS_MSSQL_PASSWORD='Custos!Passw0rd' CUSTOS_MSSQL_DB=custos_test \
 *   node main/integration/mssql-live.js
 */
const assert = require('node:assert/strict');
const sql = require('mssql');
const { DriverRegistry } = require('@custos/core');
const { AzureSqlDriver } = require('@custos/driver-azuresql');
const { ConnectionManager, InMemoryConnectionStore, InMemorySecretStore } = require('../dist/engine/index.js');

const env = process.env;
const HOST = env.CUSTOS_MSSQL_HOST ?? '127.0.0.1';
const PORT = Number(env.CUSTOS_MSSQL_PORT ?? 1434);
const USER = env.CUSTOS_MSSQL_USER ?? 'sa';
const PASSWORD = env.CUSTOS_MSSQL_PASSWORD ?? 'Custos!Passw0rd';
const DATABASE = env.CUSTOS_MSSQL_DB ?? 'custos_test';

const BIG_ROWS = 65_536;
let passed = 0;
function ok(label, detail) {
  passed++;
  console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
}

const baseOptions = { encrypt: false, trustServerCertificate: true };

/** Create the test database and a large table (fresh each run). */
async function seed() {
  const master = await sql.connect({ server: HOST, port: PORT, user: USER, password: PASSWORD, database: 'master', options: baseOptions });
  await master.request().query(`IF DB_ID('${DATABASE}') IS NULL EXEC('CREATE DATABASE [${DATABASE}]')`);
  await master.close();

  const db = await sql.connect({ server: HOST, port: PORT, user: USER, password: PASSWORD, database: DATABASE, options: baseOptions });
  await db.request().query(`IF OBJECT_ID('dbo.bigt') IS NOT NULL DROP TABLE dbo.bigt`);
  await db.request().query(`CREATE TABLE dbo.bigt (id INT IDENTITY(1,1) PRIMARY KEY, val NVARCHAR(32))`);
  await db.request().query(
    `INSERT INTO dbo.bigt (val)
       SELECT TOP (${BIG_ROWS}) CONCAT('row-', ROW_NUMBER() OVER (ORDER BY (SELECT NULL)))
         FROM sys.all_objects a CROSS JOIN sys.all_objects b`,
  );
  await db.close();
}

async function main() {
  console.log(`\nCustos ↔ real SQL Server @ ${HOST}:${PORT}/${DATABASE}\n`);
  await seed();
  ok('seed', `dbo.bigt with ${BIG_ROWS} rows`);

  const registry = new DriverRegistry();
  registry.register(new AzureSqlDriver());
  const manager = new ConnectionManager(registry, new InMemoryConnectionStore(), new InMemorySecretStore());

  const params = { server: HOST, port: PORT, database: DATABASE, authMode: 'sql', user: USER, encrypt: false, trustServerCertificate: true };
  const secrets = { password: PASSWORD };

  // 1. testConnection through the real driver
  const test = await manager.testConnection({ driverId: 'azuresql', params, secrets });
  assert.equal(test.ok, true, 'testConnection should succeed');
  ok('testConnection', `${test.serverVersion} in ${test.latencyMs}ms`);

  // 2. Open a writable connection
  await manager.saveConnection({ config: { id: 'db', name: 'db', driverId: 'azuresql', readOnly: false, params }, secrets });
  await manager.openConnection('db');
  ok('openConnection');

  // 3. A plain SELECT (buffered — no cap) returns everything, typed
  const all = await manager.runQuery({ connectionId: 'db', queryId: 'q0', sql: 'SELECT TOP (7) id, val FROM dbo.bigt ORDER BY id' });
  assert.equal(all.resultSets[0].rows.length, 7);
  assert.equal(all.resultSets[0].columns[0].name, 'id');
  ok('SELECT (buffered)', `${all.resultSets[0].rows.length} rows, cols: ${all.resultSets[0].columns.map((c) => c.name).join(', ')}`);

  // 4. Streaming a capped SELECT stops fetching early. Compare against an
  // authoritative TOP(5) (ids may be non-contiguous if IDENTITY left gaps).
  const total = Number(
    (await manager.runQuery({ connectionId: 'db', queryId: 'ct', sql: 'SELECT COUNT(*) AS n FROM dbo.bigt' })).resultSets[0].rows[0][0],
  );
  const first5 = (
    await manager.runQuery({ connectionId: 'db', queryId: 'f5', sql: 'SELECT TOP (5) id FROM dbo.bigt ORDER BY id' })
  ).resultSets[0].rows.map((r) => Number(r[0]));
  const capped = await manager.runQuery({ connectionId: 'db', queryId: 'sb', sql: 'SELECT id FROM dbo.bigt ORDER BY id', maxRows: 5 });
  assert.equal(capped.resultSets[0].rows.length, 5, 'streamed exactly maxRows (5)');
  assert.equal(capped.resultSets[0].truncated, true, 'truncated flag set');
  assert.deepEqual(capped.resultSets[0].rows.map((r) => Number(r[0])), first5, 'streamed the correct first 5 rows, in order');
  // The early cancel must not desync the pooled connection.
  const after = await manager.runQuery({ connectionId: 'db', queryId: 'af', sql: 'SELECT 123 AS x' });
  assert.equal(Number(after.resultSets[0].rows[0][0]), 123, 'connection healthy after early stop');
  ok('streaming cap + early stop', `capped 5 of ${total} rows, truncated, connection reused cleanly`);

  // 5. A streamed query under the cap ends normally (truncated=false)
  const under = await manager.runQuery({ connectionId: 'db', queryId: 'un', sql: 'SELECT TOP (3) id FROM dbo.bigt ORDER BY id', maxRows: 100 });
  assert.equal(under.resultSets[0].rows.length, 3);
  assert.equal(under.resultSets[0].truncated, false, 'under-cap is not truncated');
  ok('under-cap streaming ends normally', '3 rows, truncated=false');

  // 6. Repeated capped streams reuse the connection (stress the cancel path)
  for (let i = 0; i < 10; i++) {
    const r = await manager.runQuery({ connectionId: 'db', queryId: `r${i}`, sql: 'SELECT id FROM dbo.bigt ORDER BY id', maxRows: 3 });
    assert.equal(r.resultSets[0].rows.length, 3);
    assert.equal(r.resultSets[0].truncated, true);
  }
  const stillOk = await manager.runQuery({ connectionId: 'db', queryId: 'z', sql: 'SELECT 99 AS x' });
  assert.equal(Number(stillOk.resultSets[0].rows[0][0]), 99);
  ok('10× capped stream + reuse', 'connection healthy after repeated early cancels');

  // 7. Multi-statement batches still take the buffered path (two result sets)
  const multi = await manager.runQuery({ connectionId: 'db', queryId: 'ms', sql: 'SELECT 1 AS a; SELECT 2 AS b', maxRows: 10 });
  assert.equal(multi.resultSets.length, 2, 'two result sets');
  assert.equal(Number(multi.resultSets[0].rows[0][0]), 1);
  assert.equal(Number(multi.resultSets[1].rows[0][0]), 2);
  ok('multi-statement (buffered path)', 'two result sets: 1, 2');

  await manager.dispose();
  console.log(`\n${passed} checks passed against real SQL Server.\n`);
}

main().catch((err) => {
  console.error('\nINTEGRATION FAILED:', err);
  process.exit(1);
});
