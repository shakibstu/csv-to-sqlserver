const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./helpers.cjs');
const { parseSqlType, normalizeValue } = loadSource('src/sqlTypes.ts');

test('only complete supported SQL types with valid bounds are accepted', () => {
  assert.equal(parseSqlType(' decimal ( 38, 10 ) ').sqlType, 'DECIMAL(38,10)');
  assert.equal(parseSqlType('DATETIME2').sqlType, 'DATETIME2(7)');
  assert.equal(parseSqlType('DATETIME2(3)').sqlType, 'DATETIME2(3)');
  for (const input of ['INT; DELETE FROM x', 'VARBINARY(9000)', 'NVARCHAR(4001)', 'DECIMAL(39,0)', 'DECIMAL(2,3)', 'TIME(8)', 'ROWVERSION']) {
    assert.throws(() => parseSqlType(input), /type|precision|length|scale/i);
  }
});

test('BIGINT and decimal values preserve every digit and reject overflow/rounding', () => {
  assert.equal(normalizeValue('9223372036854775807', parseSqlType('BIGINT')), '9223372036854775807');
  assert.equal(normalizeValue('12345678901234567890.1234567890', parseSqlType('DECIMAL(38,10)')), '12345678901234567890.1234567890');
  assert.equal(normalizeValue('1.23e-3', parseSqlType('DECIMAL(8,5)')), '0.00123');
  assert.throws(() => normalizeValue('9223372036854775808', parseSqlType('BIGINT')), /range|overflow/i);
  assert.throws(() => normalizeValue('1.234', parseSqlType('DECIMAL(8,2)')), /scale|precision/i);
});

test('invalid values fail instead of becoming NULL or an adjusted calendar date', () => {
  assert.throws(() => normalizeValue('abc', parseSqlType('INT')), /integer/i);
  assert.throws(() => normalizeValue('2025-02-30', parseSqlType('DATE')), /date/i);
  assert.equal(normalizeValue('', parseSqlType('INT')), null);
  assert.equal(normalizeValue(' true ', parseSqlType('BIT')), '1');
  assert.equal(normalizeValue('12:30:00.1234567', parseSqlType('TIME(7)')), '12:30:00.1234567');
  assert.equal(normalizeValue('2024-02-29', {base:'DATETIME2',scale:7,sqlType:'DATETIME2(7)'}), '2024-02-29T00:00:00');
  assert.equal(normalizeValue('2024-02-29T12:00:00+0100', {base:'DATETIMEOFFSET',scale:7,sqlType:'DATETIMEOFFSET(7)'}), '2024-02-29T12:00:00+01:00');
  assert.throws(() => normalizeValue('25:00', parseSqlType('TIME')), /time/i);
});

test('bounded text and binary values cannot be silently truncated', () => {
  assert.throws(() => normalizeValue('abcd', parseSqlType('NVARCHAR(3)')), /length/i);
  assert.equal(normalizeValue('0x00FF', parseSqlType('VARBINARY(2)')), '0x00FF');
  assert.throws(() => normalizeValue('0x00FFAA', parseSqlType('VARBINARY(2)')), /length/i);
});
