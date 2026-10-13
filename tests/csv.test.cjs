const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { parse } = require('csv-parse');
const { loadSource } = require('./helpers.cjs');

function fixture(t, content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-safety-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'input.csv');
  fs.writeFileSync(filename, content);
  return filename;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, ms = 500) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('CSV operation did not settle promptly')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function trackedCsv(t, sourceFactory) {
  const state = { source: undefined, parser: undefined, rowsRead: 0 };
  t.after(() => {
    state.source?.destroy();
    state.parser?.destroy();
  });
  const csv = loadSource('src/csv.ts', {
    fs: {
      ...fs,
      createReadStream(filename, options) {
        state.source = sourceFactory ? sourceFactory(filename, options) : fs.createReadStream(filename, options);
        // Keep the original broken implementation's missing error handler from
        // crashing the runner, so its unsettled operation is the observed bug.
        state.source.on('error', () => {});
        return state.source;
      },
    },
    'csv-parse': {
      parse(options) {
        state.parser = parse(options);
        const read = state.parser.read;
        state.parser.read = function (...args) {
          const value = read.apply(this, args);
          if (value !== null) state.rowsRead++;
          return value;
        };
        return state.parser;
      },
    },
  });
  return { csv, state };
}

for (const header of ['name,name', 'Name,name', 'name, name ', 'name,', 'name,   ']) {
  test(`rejects ambiguous header ${JSON.stringify(header)}`, async (t) => {
    const filename = fixture(t, `${header}\na,b\n`);
    const { readHeaderAndSample, streamCsv } = loadSource('src/csv.ts');
    await assert.rejects(readHeaderAndSample(filename, 10), /duplicate|blank|empty.*header/i);
    await assert.rejects(streamCsv(filename, () => {}), /duplicate|blank|empty.*header/i);
  });
}

test('discovers columns in a header-only CSV', async (t) => {
  const filename = fixture(t, 'id,name\n');
  const { readHeaderAndSample } = loadSource('src/csv.ts');
  const result = await readHeaderAndSample(filename, 10);
  assert.deepEqual(result.columns.map((column) => column.name), ['id', 'name']);
  assert.deepEqual(result.sampleRows, []);
});

test('preserves headers that share JavaScript object property names', async (t) => {
  const filename = fixture(t, '__proto__,constructor,toString\nexact,owner,label\n');
  const { readHeaderAndSample, streamCsv } = loadSource('src/csv.ts');
  const result = await readHeaderAndSample(filename, 10);
  assert.equal(Object.hasOwn(result.sampleRows[0], '__proto__'), true);
  assert.equal(result.sampleRows[0].__proto__, 'exact');
  assert.equal(result.sampleRows[0].constructor, 'owner');
  const rows = [];
  await streamCsv(filename, (row) => { rows.push(row); });
  assert.equal(Object.hasOwn(rows[0], '__proto__'), true);
  assert.equal(rows[0].__proto__, 'exact');
  assert.equal(rows[0].toString, 'label');
});

test('rejects a CSV without a header', async (t) => {
  const filename = fixture(t, '\n\n');
  const { readHeaderAndSample, streamCsv } = loadSource('src/csv.ts');
  await assert.rejects(readHeaderAndSample(filename, 10), /empty|header/i);
  await assert.rejects(streamCsv(filename, () => {}), /empty|header/i);
});

const typeCases = [
  ['binary booleans', ['0', '1'], 'BIT'],
  ['boolean spellings', ['true', 'false', 'yes', 'no', '0', '1'], 'BIT'],
  ['integers with binary values', ['0', '1', '2', '-12'], 'BIGINT'],
  ['boolean words with numbers', ['false', '2'], 'NVARCHAR(64)'],
  ['integers with dates', ['25', '2024-02-29'], 'NVARCHAR(64)'],
  ['decimals with booleans', ['1.25', 'yes'], 'NVARCHAR(64)'],
  ['invalid leap date', ['2025-02-29'], 'NVARCHAR(64)'],
  ['valid leap date', ['2024-02-29'], 'DATE'],
  ['invalid timestamp date', ['2024-02-30T10:00:00'], 'NVARCHAR(64)'],
  ['invalid timestamp time', ['2024-02-29T25:00:00'], 'NVARCHAR(64)'],
  ['compatible date and timestamp', ['2024-02-29', '2024-02-29T10:00:00Z'], 'DATETIME2'],
  ['signed64 limits', ['9223372036854775807', '-9223372036854775808'], 'BIGINT'],
  ['integer outside signed64', ['9223372036854775808'], 'NVARCHAR(64)'],
  ['small decimals', ['12345.67', '999'], 'DECIMAL(7, 2)'],
  ['high decimal scale', ['0.00000000000000000001'], 'DECIMAL(20, 20)'],
  ['positive exponent', ['1.2e5'], 'DECIMAL(6, 0)'],
  ['negative exponent', ['1.2e-5'], 'DECIMAL(6, 6)'],
  ['decimal outside SQL precision', ['1e39'], 'NVARCHAR(64)'],
  ['combined decimal outside SQL precision', ['999999999999999999', '0.000000000000000000001'], 'NVARCHAR(64)'],
];

for (const [name, values, expected] of typeCases) {
  test(`infers ${name} without destructive conversion`, async (t) => {
    const filename = fixture(t, `value\n${values.join('\n')}\n`);
    const { readHeaderAndSample } = loadSource('src/csv.ts');
    const result = await readHeaderAndSample(filename, 100);
    assert.equal(result.columns[0].sqlType, expected);
    assert.deepEqual(result.sampleRows.map((row) => row.value), values);
  });
}

test('keeps large BIGINT sample values exact', async (t) => {
  const filename = fixture(t, 'value\n9007199254740993\n');
  const { readHeaderAndSample } = loadSource('src/csv.ts');
  const result = await readHeaderAndSample(filename, 10);
  assert.equal(result.columns[0].sqlType, 'BIGINT');
  assert.equal(result.sampleRows[0].value, '9007199254740993');
});

for (const operation of ['readHeaderAndSample', 'streamCsv']) {
  test(`${operation} propagates a source error`, async (t) => {
    const { csv } = trackedCsv(t);
    const missing = path.join(os.tmpdir(), `missing-csv-${process.pid}-${Date.now()}`);
    const promise = operation === 'streamCsv' ? csv.streamCsv(missing, () => {}) : csv.readHeaderAndSample(missing, 10);
    await assert.rejects(within(promise), /ENOENT/);
  });
}

test('streams row numbers and rejects malformed records', async (t) => {
  const filename = fixture(t, 'id,name\n1,first\n2,second\n3\n');
  const { streamCsv } = loadSource('src/csv.ts');
  const rows = [];
  await assert.rejects(streamCsv(filename, (row, rowNumber) => { rows.push([row.id, rowNumber]); }), /columns|record/i);
  // Parse errors can arrive before already-buffered rows are consumed. Their
  // ordering is intentionally not promised; successful files have stable indexes.
  const valid = fixture(t, 'id\n1\n2\n');
  const indexes = [];
  await streamCsv(valid, (_, rowNumber) => { indexes.push(rowNumber); });
  assert.deepEqual(indexes, [2, 3]);
});

test('does not drain parsed records while a row callback is blocked', async (t) => {
  const filename = fixture(t, `id\n${Array.from({ length: 20000 }, (_, index) => index + 1).join('\n')}\n`);
  const { csv, state } = trackedCsv(t);
  const entered = deferred();
  const release = deferred();
  let callbacks = 0;
  const promise = csv.streamCsv(filename, async () => {
    callbacks++;
    if (callbacks === 1) {
      entered.resolve();
      await release.promise;
    }
  });
  t.after(() => release.resolve());
  await within(entered.promise);
  // Two event-loop turns let all immediately available stream work run.
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  const readWhileBlocked = state.rowsRead;
  release.resolve();
  await within(promise, 3000);
  assert.equal(readWhileBlocked, 1);
  assert.equal(callbacks, 20000);
});

test('sampling destroys its source after the requested row limit', async (t) => {
  const source = new Readable({ read() {} });
  const { csv, state } = trackedCsv(t, () => source);
  const promise = csv.readHeaderAndSample('synthetic.csv', 1);
  // Keep the source open, with enough trailing bytes for csv-parse's lookahead.
  source.push('id\n1\n2\n3\n4\n');
  const result = await within(promise);
  assert.deepEqual(result.sampleRows, [{ id: '1' }]);
  assert.equal(state.source.destroyed, true);
  assert.equal(state.parser.destroyed, true);
});

test('callback rejection promptly stops the source and parser', async (t) => {
  const source = new Readable({ read() {} });
  const { csv, state } = trackedCsv(t, () => source);
  const failure = new Error('cannot write row');
  const promise = csv.streamCsv('synthetic.csv', () => { throw failure; });
  source.push('id\n1\n2\n3\n4\n');
  await assert.rejects(within(promise), (error) => error === failure);
  assert.equal(state.source.destroyed, true);
  assert.equal(state.parser.destroyed, true);
});

test('abort promptly rejects while awaiting a row callback', async (t) => {
  const source = new Readable({ read() {} });
  const { csv, state } = trackedCsv(t, () => source);
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  let callbacks = 0;
  const promise = csv.streamCsv('synthetic.csv', async () => {
    callbacks++;
    entered.resolve();
    await release.promise;
  }, { signal: controller.signal });
  t.after(() => release.resolve());
  source.push('id\n1\n2\n3\n4\n');
  await within(entered.promise);
  controller.abort();
  await assert.rejects(within(promise), (error) => error.name === 'AbortError');
  assert.equal(state.source.destroyed, true);
  assert.equal(state.parser.destroyed, true);
  assert.equal(callbacks, 1);
  release.resolve();
});

test('sampling honours an already-aborted signal', async (t) => {
  const filename = fixture(t, 'id\n1\n');
  const { readHeaderAndSample } = loadSource('src/csv.ts');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readHeaderAndSample(filename, 10, ',', { signal: controller.signal }), (error) => error.name === 'AbortError');
});
