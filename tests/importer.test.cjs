const test = require('node:test');
const assert = require('node:assert/strict');
const sql = require('mssql');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./helpers.cjs');
class CancellationError extends Error { constructor() { super('Cancelled'); this.name = 'CancellationError'; } }
const request = {
  csvPath: '/irrelevant.csv', driverConfig: { server: 'fake', database: 'test' },
  mode: 'truncateLoad', target: { schema: 'dbo', name: 'Target' },
  columns: [{ sourceName: 'id', targetName: 'id', sqlType: 'BIGINT', nullable: false }], batchSize: 1000,
};

test('an already-cancelled import never connects or changes a database', async () => {
  const effects = [];
  class Pool {
    async connect() { effects.push('connect'); return this; }
    request() { return { batch: async () => effects.push('batch') }; }
    async close() { effects.push('close'); }
  }
  const importer = loadSource('src/importer.ts', {
    vscode: { CancellationError }, mssql: { ...sql, ConnectionPool: Pool },
    './csv': { streamCsv: async (_path, onRow) => onRow({ id: '1' }, 2) },
  });
  await assert.rejects(importer.runImport(request, { report() {} }, { isCancellationRequested: true }), /cancel/i);
  assert.deepEqual(effects, []);
});

test('invalid batch sizes fail before connecting', async () => {
  let connected = false;
  class Pool { async connect() { connected = true; throw new Error('Must not connect'); } }
  const importer = loadSource('src/importer.ts', { vscode: { CancellationError }, mssql: { ...sql, ConnectionPool: Pool } });
  await assert.rejects(importer.runImport({ ...request, batchSize: 1.5 }, { report() {} }, { isCancellationRequested: false }), /batch size/i);
  assert.equal(connected, false);
});

test('cancellation waits for the active bulk request to settle before rollback and pool close', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'csv-bulk-cancel-'));
  const csvPath = path.join(directory, 'input.csv');
  await fs.writeFile(csvPath, 'id\n1\n');
  const events = [];
  let busy = false, acknowledge;
  const handlers = new Set();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(fn) { handlers.add(fn); return { dispose() { handlers.delete(fn); } }; },
    cancel() { this.isCancellationRequested = true; handlers.forEach(fn => fn()); },
  };
  class Pool { async connect() { return this; } async close() { assert.equal(busy,false,'pool closes while bulk is busy');events.push('close'); } }
  class Transaction {
    on() {} async begin() {}
    async rollback() { assert.equal(busy,false,'rollback while bulk is busy');events.push('rollback'); }
  }
  class Request {
    input() { return this; }
    async batch() {}
    async query() { return {recordset:[{name:'id',typeName:'bigint',maxLength:8,precision:19,scale:0,nullable:false,identity:false,computed:false,generated:0,hasDefault:false}]}; }
    bulk() {
      busy = true; events.push('bulk');
      const promise = new Promise((_resolve,reject) => { acknowledge = () => { busy=false;events.push('ack');reject(new CancellationError()); }; });
      queueMicrotask(() => token.cancel());
      return promise;
    }
    cancel() { if(busy)setTimeout(acknowledge,40); }
  }
  const importer = loadSource('src/importer.ts', {vscode:{CancellationError},mssql:{...sql,ConnectionPool:Pool,Transaction,Request}});
  try {
    await assert.rejects(importer.runImport({...request,csvPath,batchSize:1},{report(){}},token), error => error.name === 'CancellationError');
    assert.deepEqual(events,['bulk','ack','rollback','close']);
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});
