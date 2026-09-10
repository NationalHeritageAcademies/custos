'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { documentsToResultSet, toSqlValue, typeLabel } = require('../dist/index.js');
const { ObjectId, Long, Decimal128, Int32, Binary, MinKey, Timestamp } = require('mongodb');

test('columns are the union of top-level fields, in first-seen order', () => {
  const rs = documentsToResultSet([
    { _id: 1, name: 'ada' },
    { _id: 2, city: 'GR' },
  ]);
  assert.deepEqual(rs.columns.map((c) => c.name), ['_id', 'name', 'city']);
  // A field a document does not have reads as null.
  assert.deepEqual(rs.rows, [
    [1, 'ada', null],
    [2, null, 'GR'],
  ]);
});

test('a field with more than one type is labelled mixed', () => {
  const rs = documentsToResultSet([{ v: 1 }, { v: 'one' }]);
  assert.equal(rs.columns[0].dataType, 'mixed');
  // A null in the first document does not lock the column to "null".
  assert.equal(documentsToResultSet([{ v: null }, { v: 'one' }]).columns[0].dataType, 'string');
});

test('BSON values are normalized to values that survive IPC', () => {
  const id = new ObjectId('507f1f77bcf86cd799439011');
  assert.equal(toSqlValue(id), '507f1f77bcf86cd799439011');
  assert.equal(toSqlValue(new Int32(7)), 7);
  assert.equal(toSqlValue(Decimal128.fromString('10.25')), '10.25');
  assert.equal(toSqlValue(new MinKey()), 'MinKey');
  assert.equal(toSqlValue(Timestamp.fromBits(1, 2)), String(Timestamp.fromBits(1, 2)));
  assert.equal(toSqlValue(/ab/gi), '/ab/gi');
  assert.equal(toSqlValue(new Binary(Buffer.from('hi'))), Buffer.from('hi').toString('base64'));
  assert.equal(toSqlValue(undefined), null);
});

test('a Long keeps its exact value when it cannot be a safe number', () => {
  assert.equal(toSqlValue(Long.fromString('42')), 42);
  assert.equal(toSqlValue(Long.fromString('9007199254740993')), '9007199254740993');
});

test('dates stay dates and nested structures stay structured', () => {
  const when = new Date('2026-01-02T03:04:05Z');
  const value = toSqlValue({ when, tags: ['a'], inner: { id: new ObjectId('507f1f77bcf86cd799439011') } });
  assert.deepEqual(value, {
    when,
    tags: ['a'],
    inner: { id: '507f1f77bcf86cd799439011' },
  });
});

test('type labels name the BSON type', () => {
  assert.equal(typeLabel(new ObjectId()), 'objectId');
  assert.equal(typeLabel(Long.fromString('1')), 'long');
  assert.equal(typeLabel(Decimal128.fromString('1.5')), 'decimal');
  assert.equal(typeLabel(new Date()), 'date');
  assert.equal(typeLabel(1), 'int');
  assert.equal(typeLabel(1.5), 'double');
  assert.equal(typeLabel([1]), 'array');
  assert.equal(typeLabel({ a: 1 }), 'object');
  assert.equal(typeLabel(null), 'null');
});

test('truncation is carried through to the result set', () => {
  assert.equal(documentsToResultSet([{ a: 1 }], true).truncated, true);
  assert.equal(documentsToResultSet([{ a: 1 }]).truncated, false);
});
