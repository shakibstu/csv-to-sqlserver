const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./helpers.cjs');
const sql = loadSource('src/sqlBuilder.ts');
const column = { sourceName: 'id', targetName: 'id', sqlType: 'BIGINT', nullable: false };

test('create mode emits CREATE, so an existing target fails instead of silently appending', () => {
  assert.match(sql.buildCreateTable({ schema: 'dbo', name: 'Target' }, [column]), /^CREATE TABLE \[dbo\]\.\[Target\]/);
});

test('SQL type input cannot inject a second statement', () => {
  assert.throws(() => sql.buildCreateTable({ schema: 'dbo', name: 'Target' }, [
    { ...column, sqlType: 'INT NULL); DROP TABLE dbo.Target; --' },
  ]), /SQL type|Unsupported/i);
});

test('invalid identifiers are rejected before building SQL', () => {
  assert.throws(() => sql.quoteIdent(''), /identifier/i);
  assert.throws(() => sql.quoteIdent('x'.repeat(129)), /identifier/i);
});

test('literal dots and closing brackets remain a single table identifier', () => {
  assert.equal(sql.qualified({ schema: 'sales.data', name: 'Orders.2026]' }), '[sales.data].[Orders.2026]]]');
});
