'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canStreamSelect } = require('../dist/index.js');

const CAP = 100;

test('streams a single capped SELECT', () => {
  assert.equal(canStreamSelect('SELECT * FROM products', CAP), true);
  assert.equal(canStreamSelect('  select id from t where x = 1', CAP), true);
});

test('streams other result-set statements (SHOW / DESCRIBE / EXPLAIN)', () => {
  assert.equal(canStreamSelect('SHOW TABLES', CAP), true);
  assert.equal(canStreamSelect('DESCRIBE products', CAP), true);
  assert.equal(canStreamSelect('desc products', CAP), true);
  assert.equal(canStreamSelect('EXPLAIN SELECT * FROM products', CAP), true);
});

test('sees through a leading comment', () => {
  assert.equal(canStreamSelect('/* note */ SELECT 1', CAP), true);
  assert.equal(canStreamSelect('-- c\nSELECT 1', CAP), true);
});

test('does not stream without a row cap', () => {
  assert.equal(canStreamSelect('SELECT * FROM products', undefined), false);
  assert.equal(canStreamSelect('SELECT * FROM products', 0), false);
});

test('does not stream writes or DDL (no result set — would hang a stream)', () => {
  assert.equal(canStreamSelect("UPDATE products SET price = 1 WHERE id = 1", CAP), false);
  assert.equal(canStreamSelect('INSERT INTO products (sku) VALUES ("x")', CAP), false);
  assert.equal(canStreamSelect('DELETE FROM products WHERE id = 1', CAP), false);
  assert.equal(canStreamSelect('CREATE TABLE t (id INT)', CAP), false);
  assert.equal(canStreamSelect('SET @x = 1', CAP), false);
});

test('does not stream multi-statement batches', () => {
  assert.equal(canStreamSelect('SELECT 1; SELECT 2', CAP), false);
  assert.equal(canStreamSelect("SELECT 1; UPDATE t SET x = 1 WHERE id = 1", CAP), false);
});

test('does not stream SELECT … INTO (no result set — would hang a stream)', () => {
  assert.equal(canStreamSelect('SELECT id INTO @x FROM products LIMIT 1', CAP), false);
  assert.equal(canStreamSelect('SELECT * INTO OUTFILE "/tmp/x" FROM products', CAP), false);
});

test('does not stream WITH/CTE (could front a writing statement)', () => {
  assert.equal(canStreamSelect('WITH c AS (SELECT 1 AS n) SELECT * FROM c', CAP), false);
});
