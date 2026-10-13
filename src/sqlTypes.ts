export interface ParsedSqlType {
  sqlType: string;
  base: string;
  length?: number;
  precision?: number;
  scale?: number;
}

const SIMPLE = new Set(['BIT', 'TINYINT', 'SMALLINT', 'INT', 'BIGINT', 'MONEY', 'SMALLMONEY', 'REAL', 'DATE', 'DATETIME', 'SMALLDATETIME', 'UNIQUEIDENTIFIER', 'XML']);
const LENGTH = new Set(['CHAR', 'NCHAR', 'VARCHAR', 'NVARCHAR', 'BINARY', 'VARBINARY']);
const TEMPORAL = new Set(['TIME', 'DATETIME2', 'DATETIMEOFFSET']);

export function parseSqlType(input: string): ParsedSqlType {
  if (typeof input !== 'string') throw new Error('SQL type must be text.');
  const match = /^\s*([a-z][a-z0-9]*)\s*(?:\(\s*(MAX|\d+)\s*(?:,\s*(\d+)\s*)?\))?\s*$/i.exec(input);
  if (!match) throw new Error(`Unsupported SQL type: ${input}`);
  const base = match[1].toUpperCase();
  const first = match[2]?.toUpperCase();
  const second = match[3];
  if (SIMPLE.has(base) && first === undefined) return { base, sqlType: base };
  if (LENGTH.has(base) && second === undefined) {
    if (first === 'MAX' && ['VARCHAR', 'NVARCHAR', 'VARBINARY'].includes(base)) return { base, length: -1, sqlType: `${base}(MAX)` };
    const length = first === undefined ? 1 : Number(first);
    if (Number.isInteger(length) && length >= 1 && length <= (base.startsWith('N') ? 4000 : 8000)) return { base, length, sqlType: `${base}(${length})` };
    throw new Error(`Invalid length for SQL type ${input}.`);
  }
  if ((base === 'DECIMAL' || base === 'NUMERIC') && first !== 'MAX') {
    const precision = first === undefined ? 18 : Number(first);
    const scale = second === undefined ? 0 : Number(second);
    if (precision >= 1 && precision <= 38 && scale >= 0 && scale <= precision) return { base, precision, scale, sqlType: `${base}(${precision},${scale})` };
    throw new Error(`Invalid precision or scale for SQL type ${input}.`);
  }
  if (TEMPORAL.has(base) && second === undefined && first !== 'MAX') {
    const scale = first === undefined ? 7 : Number(first);
    if (scale >= 0 && scale <= 7) return { base, scale, sqlType: `${base}(${scale})` };
    throw new Error(`Invalid time precision for SQL type ${input}.`);
  }
  if (base === 'FLOAT' && second === undefined && first !== 'MAX') {
    const precision = first === undefined ? 53 : Number(first);
    if (precision >= 1 && precision <= 53) return { base, precision, sqlType: `FLOAT(${precision})` };
  }
  throw new Error(`Unsupported SQL type: ${input}`);
}

export function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function decimalText(value: string): string {
  const match = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new Error('Invalid decimal value.');
  const exponent = Number(match[3] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) throw new Error('Decimal precision overflow.');
  const [whole, fraction = ''] = match[2].split('.');
  const digits = whole + fraction;
  const point = whole.length + exponent;
  let text = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? digits + '0'.repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  text = text.replace(/^0+(?=\d)/, '');
  return (match[1] === '-' ? '-' : '') + text;
}

function validateTime(value: string, scale: number): void {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] || 0) > 59) throw new Error('Invalid time value; expected HH:mm:ss.');
  if ((match[4] || '').length > scale) throw new Error('Time value exceeds the selected precision.');
}

/** Preserve exact CSV text for SQL-side conversion; invalid values never become NULL. */
export function normalizeValue(raw: string | undefined, type: ParsedSqlType): string | null {
  if (raw === undefined) throw new Error('Mapped CSV column is missing.');
  if (raw === '') return null;
  const { base, length } = type;
  if (['CHAR', 'NCHAR', 'VARCHAR', 'NVARCHAR', 'XML'].includes(base)) {
    if (base.startsWith('N') && length !== undefined && length !== -1 && raw.length > length) throw new Error(`Text length exceeds ${type.sqlType}.`);
    return raw;
  }
  const value = raw.trim();
  if (base === 'BIT') {
    if (['1', 'true', 'yes'].includes(value.toLowerCase())) return '1';
    if (['0', 'false', 'no'].includes(value.toLowerCase())) return '0';
    throw new Error('Invalid boolean value.');
  }
  const integerRanges: Record<string, [bigint, bigint]> = {
    TINYINT: [0n, 255n], SMALLINT: [-32768n, 32767n], INT: [-2147483648n, 2147483647n], BIGINT: [-9223372036854775808n, 9223372036854775807n],
  };
  if (integerRanges[base]) {
    if (!/^[+-]?\d+$/.test(value)) throw new Error('Invalid integer value.');
    const number = BigInt(value);
    const [min, max] = integerRanges[base];
    if (number < min || number > max) throw new Error(`Integer is outside the ${base} range.`);
    return number.toString();
  }
  if (['DECIMAL', 'NUMERIC', 'MONEY', 'SMALLMONEY'].includes(base)) {
    const text = decimalText(value);
    const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
    const precision = type.precision ?? (base === 'MONEY' ? 19 : 10);
    const scale = type.scale ?? 4;
    if (whole.replace(/^0+/, '').length > precision - scale || fraction.replace(/0+$/, '').length > scale) throw new Error(`Decimal exceeds the precision or scale of ${type.sqlType}.`);
    return fraction.length > scale ? `${text.split('.')[0]}${scale ? '.' + fraction.slice(0, scale) : ''}` : text;
  }
  if (['FLOAT', 'REAL'].includes(base)) {
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value))) throw new Error('Invalid floating point value.');
    return value;
  }
  if (base === 'DATE') {
    if (!validIsoDate(value)) throw new Error('Invalid date; expected a valid YYYY-MM-DD date.');
    return value;
  }
  if (base === 'TIME') { validateTime(value, type.scale ?? 7); return value; }
  if (['DATETIME', 'SMALLDATETIME', 'DATETIME2', 'DATETIMEOFFSET'].includes(base)) {
    if (validIsoDate(value)) return `${value}T00:00:00`;
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
    if (!match || !validIsoDate(match[1])) throw new Error('Invalid date/time; expected ISO 8601.');
    validateTime(match[2], type.scale ?? (base === 'DATETIME' ? 3 : 7));
    if (match[3] && match[3] !== 'Z') {
      const offset = match[3].replace(':', '');
      const hours = Number(offset.slice(1, 3));
      const minutes = Number(offset.slice(3, 5));
      if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) throw new Error('Invalid date/time offset.');
    }
    return value.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  }
  if (base === 'UNIQUEIDENTIFIER') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid uniqueidentifier.');
    return value;
  }
  if (base === 'BINARY' || base === 'VARBINARY') {
    if (!/^0x(?:[0-9a-f]{2})*$/i.test(value)) throw new Error('Invalid binary value; expected 0x followed by hexadecimal byte pairs.');
    if (length !== -1 && length !== undefined && (value.length - 2) / 2 > length) throw new Error(`Binary length exceeds ${type.sqlType}.`);
    return value;
  }
  throw new Error(`Unsupported SQL type: ${type.sqlType}`);
}
