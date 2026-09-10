'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseStatement,
  parseBatch,
  parseLiteral,
  splitStatements,
} = require('../dist/index.js');
const { ObjectId, Long, Decimal128, Int32 } = require('mongodb');

test('parses a collection method call', () => {
  const stmt = parseStatement('db.users.find({ age: { $gt: 30 } })');
  assert.equal(stmt.kind, 'collection');
  assert.equal(stmt.collection, 'users');
  assert.equal(stmt.method, 'find');
  assert.deepEqual(stmt.args, [{ age: { $gt: 30 } }]);
  assert.deepEqual(stmt.chain, []);
});

test('parses a cursor chain', () => {
  const stmt = parseStatement('db.users.find({}).sort({ name: 1 }).limit(10)');
  assert.deepEqual(
    stmt.chain.map((c) => [c.method, c.args]),
    [
      ['sort', [{ name: 1 }]],
      ['limit', [10]],
    ],
  );
});

test('parses a database method call', () => {
  const stmt = parseStatement('db.runCommand({ ping: 1 })');
  assert.equal(stmt.kind, 'database');
  assert.equal(stmt.method, 'runCommand');
  assert.deepEqual(stmt.args, [{ ping: 1 }]);
});

test('getCollection() names collections that are not identifiers', () => {
  const stmt = parseStatement('db.getCollection("orders 2024").countDocuments({})');
  assert.equal(stmt.kind, 'collection');
  assert.equal(stmt.collection, 'orders 2024');
  assert.equal(stmt.method, 'countDocuments');
});

test('parses use and show', () => {
  assert.deepEqual(parseStatement('use analytics'), {
    kind: 'use',
    source: 'use analytics',
    database: 'analytics',
  });
  assert.equal(parseStatement('show dbs').target, 'databases');
  assert.equal(parseStatement('show collections').target, 'collections');
});

test('accepts relaxed JSON: unquoted keys, single quotes, trailing commas', () => {
  const stmt = parseStatement("db.users.find({ name: 'ada', tags: ['x', 'y',], })");
  assert.deepEqual(stmt.args[0], { name: 'ada', tags: ['x', 'y'] });
});

test('accepts dotted and $-prefixed field names', () => {
  const stmt = parseStatement('db.users.find({ "address.city": "GR", $or: [{ a: 1 }] })');
  assert.deepEqual(stmt.args[0], { 'address.city': 'GR', $or: [{ a: 1 }] });
});

test('parses regex literals', () => {
  const value = parseStatement('db.users.find({ name: /^ad/i })').args[0].name;
  assert.ok(value instanceof RegExp);
  assert.equal(value.source, '^ad');
  assert.equal(value.flags, 'i');
});

test('parses BSON constructors', () => {
  const filter = parseStatement(
    'db.users.find({ _id: ObjectId("507f1f77bcf86cd799439011"), n: NumberLong("9007199254740993") })',
  ).args[0];
  assert.ok(filter._id instanceof ObjectId);
  assert.equal(filter._id.toHexString(), '507f1f77bcf86cd799439011');
  assert.ok(filter.n instanceof Long);
  assert.equal(String(filter.n), '9007199254740993');
});

test('parses ISODate, NumberDecimal, NumberInt and new-prefixed constructors', () => {
  assert.deepEqual(parseLiteral('ISODate("2026-01-02T03:04:05Z")'), new Date('2026-01-02T03:04:05Z'));
  assert.ok(parseLiteral('NumberDecimal("10.25")') instanceof Decimal128);
  assert.ok(parseLiteral('NumberInt(7)') instanceof Int32);
  assert.ok(parseLiteral('new ObjectId("507f1f77bcf86cd799439011")') instanceof ObjectId);
});

test('parses keywords and negative/exponent numbers', () => {
  assert.deepEqual(parseLiteral('{ a: true, b: false, c: null, d: -1.5e3 }'), {
    a: true,
    b: false,
    c: null,
    d: -1500,
  });
});

test('strips // and /* */ comments without eating strings or regexes', () => {
  const stmt = parseStatement('db.users.find({ /* pick */ url: "http://x/y" }) // trailing');
  assert.deepEqual(stmt.args[0], { url: 'http://x/y' });
  const withRegex = parseStatement('db.users.find({ p: /a\\/b/ }) // note');
  assert.equal(withRegex.args[0].p.source, 'a\\/b');
});

test('splits a batch on semicolons and newlines', () => {
  assert.deepEqual(splitStatements('use shop; db.orders.countDocuments({})'), [
    'use shop',
    'db.orders.countDocuments({})',
  ]);
  assert.deepEqual(splitStatements('show dbs\nshow collections'), ['show dbs', 'show collections']);
});

test('a newline inside brackets or before a chained call continues the statement', () => {
  assert.deepEqual(splitStatements('db.users.find({\n  a: 1\n})'), ['db.users.find({\n  a: 1\n})']);
  const chained = splitStatements('db.users.find({})\n  .limit(5)');
  assert.equal(chained.length, 1);
  assert.equal(parseBatch(chained[0])[0].chain[0].method, 'limit');
});

test('a semicolon inside a string does not split', () => {
  assert.deepEqual(splitStatements('db.users.find({ s: "a;b" })'), ['db.users.find({ s: "a;b" })']);
});

test('rejects anything that is not a shell statement', () => {
  assert.throws(() => parseStatement('for (;;) {}'), /must start with "db"/);
  assert.throws(() => parseStatement('db.users.find({ a: someVariable })'), /Unsupported value/);
  assert.throws(() => parseStatement('db.users'), /Expected a method call/);
  assert.throws(() => parseStatement('db.users.find({}) extra'), /trailing input/);
  assert.throws(() => parseStatement('show indexes'), /Unsupported "show indexes"/);
});
