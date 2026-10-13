import * as fs from 'fs';
import { parse } from 'csv-parse';
import { finished } from 'stream/promises';

export interface InferredColumn {
  name: string;
  sqlType: string;
  nullable: boolean;
  maxLen: number;
  sawInt: boolean;
  sawFloat: boolean;
  sawBool: boolean;
  sawDate: boolean;
  sawDateTime: boolean;
  sawString: boolean;
  sawEmpty: boolean;
}

export interface ReadHeaderResult {
  columns: InferredColumn[];
  sampleRows: Record<string, string>[];
}

const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(\d+\.\d*|\.\d+|\d+)(e[+-]?\d+)?$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(?:Z|([+-])(\d{2}):?(\d{2}))?$/;
const BOOL_VALUES = new Set(['true', 'false', '0', '1', 'yes', 'no']);
const BIGINT_MIN = -9223372036854775808n;
const BIGINT_MAX = 9223372036854775807n;

interface InferenceState {
  column: InferredColumn;
  booleanWords: boolean;
  nonBinaryNumber: boolean;
  integerDigits: number;
  scale: number;
}

function newCol(name: string): InferredColumn {
  return {
    name,
    sqlType: 'NVARCHAR(255)',
    nullable: false,
    maxLen: 0,
    sawInt: false,
    sawFloat: false,
    sawBool: false,
    sawDate: false,
    sawDateTime: false,
    sawString: false,
    sawEmpty: false,
  };
}

function validDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function validDateTime(value: string): boolean {
  const match = DATETIME_RE.exec(value);
  if (!match || !validDate(match[1])) return false;
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) return false;
  if (match[6]) {
    const hours = Number(match[7]);
    const minutes = Number(match[8]);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return false;
  }
  return true;
}

/** Compute SQL decimal dimensions from digits, without converting the value to Number. */
function numericDimensions(value: string): { integerDigits: number; scale: number } | undefined {
  const match = /^[+-]?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match) return undefined;
  const integer = match[1];
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent)) return undefined;
  const digits = integer + fraction;
  const firstNonzero = digits.search(/[1-9]/);
  const integerDigits = firstNonzero === -1 ? 0 : Math.max(0, integer.length + exponent - firstNonzero);
  const scale = Math.max(0, fraction.length - exponent);
  if (integerDigits + scale > 38) return undefined;
  return { integerDigits, scale };
}

function classify(state: InferenceState, value: string | undefined): void {
  const col = state.column;
  if (value === undefined || value === null || value === '') {
    col.sawEmpty = true;
    col.nullable = true;
    return;
  }
  if (value.length > col.maxLen) col.maxLen = value.length;
  const v = value.trim();
  if (BOOL_VALUES.has(v.toLowerCase())) {
    col.sawBool = true;
    if (v === '0' || v === '1') {
      col.sawInt = true;
      state.integerDigits = Math.max(state.integerDigits, v === '1' ? 1 : 0);
    } else {
      state.booleanWords = true;
    }
    return;
  }
  if (INT_RE.test(v)) {
    col.sawInt = true;
    state.nonBinaryNumber = true;
    const integer = BigInt(v);
    if (integer < BIGINT_MIN || integer > BIGINT_MAX) col.sawString = true;
    const dimensions = numericDimensions(v);
    if (dimensions) state.integerDigits = Math.max(state.integerDigits, dimensions.integerDigits);
    return;
  }
  if (FLOAT_RE.test(v)) {
    col.sawFloat = true;
    state.nonBinaryNumber = true;
    const dimensions = numericDimensions(v);
    if (!dimensions) {
      col.sawString = true;
    } else {
      state.integerDigits = Math.max(state.integerDigits, dimensions.integerDigits);
      state.scale = Math.max(state.scale, dimensions.scale);
    }
    return;
  }
  if (validDateTime(v)) {
    col.sawDateTime = true;
    return;
  }
  if (DATE_RE.test(v) && validDate(v)) {
    col.sawDate = true;
    return;
  }
  col.sawString = true;
}

function textType(col: InferredColumn): string {
  const len = Math.max(col.maxLen, 1);
  if (len > 4000) return 'NVARCHAR(MAX)';
  const raw = Math.pow(2, Math.ceil(Math.log2(Math.max(len * 2, 50))));
  return `NVARCHAR(${Math.min(4000, Math.max(50, raw))})`;
}

function resolveType(state: InferenceState): string {
  const col = state.column;
  const temporal = col.sawDate || col.sawDateTime;
  const numeric = col.sawInt || col.sawFloat;
  if (
    col.sawString ||
    (temporal && (numeric || col.sawBool)) ||
    (state.booleanWords && state.nonBinaryNumber)
  ) return textType(col);
  if (col.sawDateTime) return 'DATETIME2';
  if (col.sawDate) return 'DATE';
  if (state.booleanWords || (col.sawBool && !state.nonBinaryNumber)) return 'BIT';
  if (col.sawFloat) {
    const precision = Math.max(1, state.integerDigits + state.scale);
    return precision > 38 ? textType(col) : `DECIMAL(${precision}, ${state.scale})`;
  }
  if (col.sawInt) return 'BIGINT';
  return `NVARCHAR(${Math.max(col.maxLen || 50, 50)})`;
}

interface CsvOptions {
  delimiter?: string;
  signal?: AbortSignal;
  maxRows?: number;
}

function cancellationError(): Error {
  const error = new Error('CSV processing cancelled');
  error.name = 'AbortError';
  return error;
}

/** Keep one callback in flight and close both streams on every exit path. */
async function consumeCsv(
  filePath: string,
  onHeader: (names: string[]) => void,
  onRow: (row: Record<string, string>, rowNumber: number) => void | Promise<void>,
  opts: CsvOptions,
): Promise<void> {
  if (opts.signal?.aborted) throw cancellationError();
  let sawHeader = false;
  const parser = parse({
    delimiter: opts.delimiter ?? ',',
    columns: (names: string[]) => {
      const seen = new Set<string>();
      for (const name of names) {
        const key = name.trim().toLowerCase();
        if (!key) throw new Error('CSV contains a blank header');
        if (seen.has(key)) throw new Error(`CSV contains duplicate header: ${name}`);
        seen.add(key);
      }
      sawHeader = true;
      onHeader(names);
      return names;
    },
    relax_quotes: true,
    skip_empty_lines: true,
    bom: true,
    ...(opts.maxRows === undefined ? {} : { to: opts.maxRows }),
  });
  const source = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
  let failed = false;
  let failure: unknown;
  let pendingReject: ((error: unknown) => void) | undefined;
  const awaitStep = <T>(step: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    // Attach handlers even when already stopped, to observe late rejections.
    step.then(
      (value) => {
        if (pendingReject === reject) pendingReject = undefined;
        resolve(value);
      },
      (error) => {
        if (pendingReject === reject) pendingReject = undefined;
        reject(error);
      },
    );
    if (failed) reject(failure);
    else pendingReject = reject;
  });
  const stop = (error: unknown) => {
    if (failed) return;
    failed = true;
    failure = error;
    pendingReject?.(error);
    pendingReject = undefined;
    source.destroy();
    parser.destroy();
  };
  const abort = () => stop(cancellationError());
  source.on('error', stop);
  parser.on('error', stop);
  opts.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (opts.signal?.aborted) abort();
    source.pipe(parser);
    const iterator = parser[Symbol.asyncIterator]();
    let rowNumber = 1;
    while (true) {
      const next = await awaitStep(iterator.next());
      if (next.done) break;
      rowNumber++;
      await awaitStep(Promise.resolve().then(() => {
        if (failed) throw failure;
        return onRow(next.value, rowNumber);
      }));
      if (opts.maxRows !== undefined && rowNumber - 1 >= opts.maxRows) break;
    }
    if (!sawHeader) throw new Error('CSV file is empty or contains no header');
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    source.unpipe(parser);
    const closed = [finished(source, { cleanup: true }), finished(parser, { cleanup: true })];
    source.destroy();
    parser.destroy();
    await Promise.allSettled(closed);
    source.removeListener('error', stop);
    parser.removeListener('error', stop);
  }
}

/**
 * Read the header and up to `sampleSize` rows, inferring a SQL type for each
 * column. Also returns up to 25 rows for UI preview.
 */
export async function readHeaderAndSample(
  filePath: string,
  sampleSize: number,
  delimiter = ',',
  opts: { signal?: AbortSignal } = {},
): Promise<ReadHeaderResult> {
  if (!Number.isFinite(sampleSize)) throw new Error('CSV sample size must be finite');
  const states: InferenceState[] = [];
  const sampleRows: Record<string, string>[] = [];
  await consumeCsv(
    filePath,
    (names) => {
      for (const name of names) {
        states.push({ column: newCol(name), booleanWords: false, nonBinaryNumber: false, integerDigits: 0, scale: 0 });
      }
    },
    (row) => {
      for (const state of states) classify(state, row[state.column.name]);
      if (sampleRows.length < 25) sampleRows.push(row);
    },
    { delimiter, signal: opts.signal, maxRows: Math.max(1, Math.floor(sampleSize)) },
  );
  return {
    columns: states.map((state) => {
      state.column.sqlType = resolveType(state);
      return state.column;
    }),
    sampleRows,
  };
}

/**
 * Await `onRow` for each record, bounding read-ahead through stream backpressure.
 * `rowNumber` counts CSV records including the header, rather than physical lines.
 */
export async function streamCsv(
  filePath: string,
  onRow: (row: Record<string, string>, rowNumber: number) => void | Promise<void>,
  opts: { delimiter?: string; signal?: AbortSignal } = {},
): Promise<void> {
  await consumeCsv(filePath, () => {}, onRow, opts);
}
