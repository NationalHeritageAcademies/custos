'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toResultSet, toResultSetFromArrays, emptyResultSet } = require('../dist/index.js');

const columns = [
  { name: 'id', dataType: 'int' },
  { name: 'name', dataType: 'varchar' },
];

test('toResultSet maps keyed rows to positional rows', () => {
  const rs = toResultSet(columns, [
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
  ]);
  assert.deepEqual(rs.rows, [
    [1, 'a'],
    [2, 'b'],
  ]);
  assert.equal(rs.truncated, false);
});

test('toResultSet coerces missing values to null', () => {
  const rs = toResultSet(columns, [{ id: 1 }]);
  assert.deepEqual(rs.rows, [[1, null]]);
});

test('toResultSet applies maxRows and flags truncation', () => {
  const rs = toResultSet(columns, [{ id: 1 }, { id: 2 }, { id: 3 }], 2);
  assert.equal(rs.rows.length, 2);
  assert.equal(rs.truncated, true);
});

test('toResultSetFromArrays maps positional rows', () => {
  const rs = toResultSetFromArrays(columns, [
    [1, 'a'],
    [2, 'b'],
  ]);
  assert.deepEqual(rs.rows, [
    [1, 'a'],
    [2, 'b'],
  ]);
});

test('emptyResultSet has no columns or rows', () => {
  const rs = emptyResultSet();
  assert.deepEqual(rs.columns, []);
  assert.deepEqual(rs.rows, []);
  assert.equal(rs.truncated, false);
});
