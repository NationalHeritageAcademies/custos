'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mongoAnalyzer } = require('../dist/index.js');

const one = (source) => mongoAnalyzer.analyzeBatch(source)[0];

test('reads are classified as reads', () => {
  for (const source of [
    'db.users.find({})',
    'db.users.findOne({ a: 1 })',
    'db.users.countDocuments({})',
    'db.users.distinct("city")',
    'db.users.getIndexes()',
    'db.getCollectionNames()',
    'show dbs',
    'use shop',
  ]) {
    assert.equal(one(source).kind, 'read', source);
  }
});

test('writes are classified as writes', () => {
  for (const source of [
    'db.users.insertOne({ a: 1 })',
    'db.users.updateOne({ a: 1 }, { $set: { b: 2 } })',
    'db.users.deleteOne({ a: 1 })',
    'db.users.bulkWrite([])',
    'db.users.findOneAndUpdate({ a: 1 }, { $set: { b: 2 } })',
  ]) {
    assert.equal(one(source).kind, 'write', source);
  }
});

test('structure changes are classified as DDL', () => {
  for (const source of [
    'db.users.createIndex({ email: 1 })',
    'db.users.drop()',
    'db.createCollection("audit")',
    'db.dropDatabase()',
  ]) {
    assert.equal(one(source).kind, 'ddl', source);
  }
});

test('an unfiltered deleteMany needs confirmation', () => {
  const analysis = one('db.users.deleteMany({})');
  assert.equal(analysis.kind, 'write');
  assert.equal(analysis.requiresConfirmation, true);
  assert.match(analysis.reason, /every document in "users"/);
  // A filter makes it ordinary.
  assert.equal(one('db.users.deleteMany({ active: false })').requiresConfirmation, false);
});

test('an unfiltered updateMany needs confirmation', () => {
  assert.equal(one('db.users.updateMany({}, { $set: { seen: true } })').requiresConfirmation, true);
  assert.equal(
    one('db.users.updateMany({ a: 1 }, { $set: { seen: true } })').requiresConfirmation,
    false,
  );
});

test('drops need confirmation', () => {
  assert.equal(one('db.users.drop()').requiresConfirmation, true);
  assert.equal(one('db.dropDatabase()').requiresConfirmation, true);
  assert.equal(one('db.users.dropIndexes()').requiresConfirmation, true);
  assert.equal(one('db.runCommand({ dropDatabase: 1 })').requiresConfirmation, true);
});

test('an aggregation that writes is a write, and $out needs confirmation', () => {
  const merge = one('db.orders.aggregate([{ $match: { a: 1 } }, { $merge: "totals" }])');
  assert.equal(merge.kind, 'write');
  const out = one('db.orders.aggregate([{ $out: "totals" }])');
  assert.equal(out.kind, 'write');
  assert.equal(out.requiresConfirmation, true);
  // A read-only pipeline stays a read.
  assert.equal(one('db.orders.aggregate([{ $match: { a: 1 } }])').kind, 'read');
});

test('runCommand is classified by its command name', () => {
  assert.equal(one('db.runCommand({ find: "users" })').kind, 'read');
  assert.equal(one('db.runCommand({ delete: "users", deletes: [] })').kind, 'write');
  assert.equal(one('db.runCommand({ createIndexes: "users" })').kind, 'ddl');
  assert.equal(one('db.runCommand({ somethingNew: 1 })').kind, 'unknown');
});

test('a batch is analyzed statement by statement', () => {
  const analyses = mongoAnalyzer.analyzeBatch('use shop; db.users.find({}); db.users.drop()');
  assert.deepEqual(analyses.map((a) => a.kind), ['read', 'read', 'ddl']);
  assert.deepEqual(analyses.map((a) => a.requiresConfirmation), [false, false, true]);
});

test('a statement that will not parse is unknown, not an exception', () => {
  const analysis = one('db.users.find({ unclosed: ');
  assert.equal(analysis.kind, 'unknown');
  assert.equal(analysis.requiresConfirmation, false);
});
