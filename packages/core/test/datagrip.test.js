'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDataGripSources, parseJdbcUrl, toConnectionConfig } = require('../dist/index.js');

test('parses SQL Server via jTDS with a Windows domain', () => {
  const xml = `
    <data-source name="Reporting DB" read-only="true">
      <driver-ref>sqlserver.jtds</driver-ref>
      <jdbc-url>jdbc:jtds:sqlserver://sql-01.example.internal:1433/AppAuthorization</jdbc-url>
      <driver-properties><property name="Domain" value="CORP" /></driver-properties>
    </data-source>`;
  const [c] = parseDataGripSources(xml);
  assert.equal(c.name, 'Reporting DB');
  assert.equal(c.driverId, 'azuresql');
  assert.equal(c.params.server, 'sql-01.example.internal');
  assert.equal(c.params.port, 1433);
  assert.equal(c.params.database, 'AppAuthorization');
  assert.equal(c.readOnly, true);
  assert.ok(c.warnings.some((w) => /domain auth \(CORP\)/.test(w)));
});

test('parses native SQL Server url with databaseName', () => {
  const { driverId, params } = parseJdbcUrl('jdbc:sqlserver://myhost:1433;databaseName=analytics;encrypt=true');
  assert.equal(driverId, 'azuresql');
  assert.equal(params.server, 'myhost');
  assert.equal(params.database, 'analytics');
});

test('parses MySQL url with params', () => {
  const { driverId, params } = parseJdbcUrl('jdbc:mysql://db.internal:3307/shopdb?useSSL=false');
  assert.equal(driverId, 'mysql');
  assert.equal(params.host, 'db.internal');
  assert.equal(params.port, 3307);
  assert.equal(params.database, 'shopdb');
});

test('MariaDB maps to the mysql driver', () => {
  assert.equal(parseJdbcUrl('jdbc:mariadb://h/db').driverId, 'mysql');
});

test('unsupported engine is flagged, not dropped', () => {
  const { driverId, warnings } = parseJdbcUrl('jdbc:postgresql://h:5432/app');
  assert.equal(driverId, null);
  assert.ok(warnings.some((w) => /postgresql/i.test(w)));
});

test('captures user-name and applies default port', () => {
  const xml = `<data-source name="x"><jdbc-url>jdbc:mysql://h/db</jdbc-url><user-name>root</user-name></data-source>`;
  const [c] = parseDataGripSources(xml);
  assert.equal(c.user, 'root');
  assert.equal(c.params.user, 'root');
  assert.equal(c.params.port, 3306);
});

test('parses multiple data-sources', () => {
  const xml = `
    <data-source name="a"><jdbc-url>jdbc:mysql://h1/d1</jdbc-url></data-source>
    <data-source name="b"><jdbc-url>jdbc:sqlserver://h2:1433;database=d2</jdbc-url></data-source>`;
  const list = parseDataGripSources(xml);
  assert.equal(list.length, 2);
  assert.equal(list[0].driverId, 'mysql');
  assert.equal(list[1].driverId, 'azuresql');
});

test('toConnectionConfig returns null for unsupported engines', () => {
  const [c] = parseDataGripSources('<data-source name="pg"><jdbc-url>jdbc:postgresql://h/db</jdbc-url></data-source>');
  assert.equal(toConnectionConfig(c, 'id1'), null);
});

test('toConnectionConfig builds a persistable config', () => {
  const [c] = parseDataGripSources('<data-source name="m"><jdbc-url>jdbc:mysql://h:3306/db</jdbc-url></data-source>');
  const config = toConnectionConfig(c, 'id1');
  assert.equal(config.id, 'id1');
  assert.equal(config.driverId, 'mysql');
  assert.equal(config.params.host, 'h');
});
