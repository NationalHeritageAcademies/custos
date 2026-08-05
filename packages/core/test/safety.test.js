'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeStatement,
  analyzeBatch,
  splitStatements,
  stripSqlComments,
  firstKeyword,
  isReadOnlyBatch,
  firstMutatingKind,
} = require('../dist/index.js');

test('firstKeyword ignores leading comments and whitespace', () => {
  assert.equal(firstKeyword('  -- a comment\n  SELECT 1'), 'select');
  assert.equal(firstKeyword('/* block */ UPDATE t SET x=1'), 'update');
});

test('classifies statement kinds', () => {
  assert.equal(analyzeStatement('SELECT * FROM t').kind, 'read');
  assert.equal(analyzeStatement('INSERT INTO t VALUES (1)').kind, 'write');
  assert.equal(analyzeStatement('DROP TABLE t').kind, 'ddl');
  assert.equal(analyzeStatement('COMMIT').kind, 'tcl');
});

test('UPDATE without WHERE requires confirmation', () => {
  const a = analyzeStatement('UPDATE users SET active = 0');
  assert.equal(a.requiresConfirmation, true);
  assert.match(a.reason, /WHERE/);
});

test('UPDATE with WHERE does not require confirmation', () => {
  const a = analyzeStatement('UPDATE users SET active = 0 WHERE id = 5');
  assert.equal(a.requiresConfirmation, false);
});

test('DELETE without WHERE requires confirmation', () => {
  assert.equal(analyzeStatement('DELETE FROM users').requiresConfirmation, true);
});

test('TRUNCATE and DROP require confirmation', () => {
  assert.equal(analyzeStatement('TRUNCATE TABLE t').requiresConfirmation, true);
  assert.equal(analyzeStatement('DROP TABLE t').requiresConfirmation, true);
});

test('stripSqlComments leaves string literals intact', () => {
  const sql = "SELECT '-- not a comment' AS x -- real comment";
  assert.equal(stripSqlComments(sql).trim(), "SELECT '-- not a comment' AS x");
});

test('splitStatements respects semicolons inside string literals', () => {
  const parts = splitStatements("SELECT ';'; SELECT 2");
  assert.equal(parts.length, 2);
  assert.equal(parts[0], "SELECT ';'");
  assert.equal(parts[1], 'SELECT 2');
});

test('isReadOnlyBatch is true only when every statement reads', () => {
  assert.equal(isReadOnlyBatch('SELECT 1; SELECT 2'), true);
  assert.equal(isReadOnlyBatch('SELECT 1; DELETE FROM t'), false);
  assert.equal(isReadOnlyBatch(''), true);
});

test('firstMutatingKind finds the first write/ddl statement', () => {
  const hit = firstMutatingKind('SELECT 1; UPDATE t SET x = 1 WHERE id = 2');
  assert.ok(hit);
  assert.equal(hit.kind, 'write');
  assert.equal(firstMutatingKind('SELECT 1; SELECT 2'), null);
});

test('analyzeBatch analyzes each statement', () => {
  const analyses = analyzeBatch('SELECT 1; DROP TABLE t');
  assert.equal(analyses.length, 2);
  assert.equal(analyses[0].kind, 'read');
  assert.equal(analyses[1].kind, 'ddl');
});
