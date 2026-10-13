const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sql = require('mssql');
const { loadSource } = require('./helpers.cjs');
class CancellationError extends Error { constructor() { super('Cancelled'); this.name = 'CancellationError'; } }
const live = process.env.TEST_SQL_CONFIG;

function cancellationToken() {
  const callbacks = new Set();
  return {
    isCancellationRequested: false,
    onCancellationRequested(fn) { callbacks.add(fn); return { dispose() { callbacks.delete(fn); } }; },
    cancel() { this.isCancellationRequested = true; for (const fn of callbacks) fn(); },
  };
}

test('SQL Server transactional import integration', { skip: !live, timeout: 120000 }, async t => {
  const config = JSON.parse(live);
  const database = 'csv_import_tests_' + randomUUID().replaceAll('-', '');
  const master = await new sql.ConnectionPool({ ...config, database: 'master' }).connect();
  let pool;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'csv-import-integration-'));
  const importerPath = 'out/importer.js';
  const importer = loadSource(importerPath, { vscode: { CancellationError } });
  let counter = 0;
  const column = (sourceName, sqlType, extra = {}) => ({ sourceName, targetName: sourceName, sqlType, nullable: false, ...extra });
  const ref = name => `[dbo].[${name.replaceAll(']', ']]')}]`;
  const run = async (name, content, columns, mode = 'create', options = {}) => {
    const csvPath = path.join(directory, 'input-' + counter++ + '.csv');
    await fs.writeFile(csvPath, content);
    return importer.runImport({ csvPath, driverConfig: { ...config, database }, database, target: { schema: 'dbo', name }, columns, mode, batchSize: 1 }, options.progress || { report() {} }, options.token || cancellationToken());
  };
  const rows = async name => (await pool.request().query(`SELECT CONVERT(NVARCHAR(MAX), id) AS id FROM ${ref(name)} ORDER BY id;`)).recordset.map(r => r.id);
  try {
    await master.request().batch(`CREATE DATABASE [${database}] COLLATE Latin1_General_100_CS_AS;`);
    pool = await new sql.ConnectionPool({ ...config, database }).connect();

    await t.test('create preserves full BIGINT, DECIMAL, TIME and identifiers containing dots/brackets', async () => {
      const name = 'Orders.2026]';
      await run(name, 'id,amount,time\n9223372036854775807,12345678901234567890.1234567890,12:30:00.1234567\n', [column('id','BIGINT'), column('amount','DECIMAL(38,10)'),column('time','TIME(7)')]);
      const result = (await pool.request().query(`SELECT CONVERT(NVARCHAR(MAX),id) AS id, CONVERT(NVARCHAR(MAX),amount) AS amount, CONVERT(NVARCHAR(MAX),time) AS time FROM ${ref(name)};`)).recordset[0];
      assert.deepEqual(result, { id:'9223372036854775807',amount:'12345678901234567890.1234567890',time:'12:30:00.1234567' });
    });

    await t.test('create refuses an existing table without appending', async () => {
      await pool.request().batch('CREATE TABLE dbo.Existing (id BIGINT NOT NULL); INSERT dbo.Existing VALUES (7);');
      await assert.rejects(run('Existing','id\n8\n',[column('id','BIGINT')]), /already exists|already an object/i);
      assert.deepEqual(await rows('Existing'), ['7']);
    });

    await t.test('late invalid values preserve the entire truncate target', async () => {
      await pool.request().batch('CREATE TABLE dbo.Invalid (id BIGINT NOT NULL); INSERT dbo.Invalid VALUES (7);');
      await assert.rejects(run('Invalid','id\n1\nnot-an-integer\n',[column('id','BIGINT')],'truncateLoad'), /record 3.*id.*integer/i);
      assert.deepEqual(await rows('Invalid'), ['7']);
    });

    await t.test('constraint failure after TRUNCATE rolls back original contents', async () => {
      await pool.request().batch('CREATE TABLE dbo.Constrained (id BIGINT NOT NULL CHECK (id < 10)); INSERT dbo.Constrained VALUES (7);');
      await assert.rejects(run('Constrained','id\n1\n50\n',[column('id','BIGINT')],'truncateLoad'), /CHECK|constraint/i);
      assert.deepEqual(await rows('Constrained'), ['7']);
    });

    await t.test('append failure cannot leave earlier batches inserted', async () => {
      await pool.request().batch('CREATE TABLE dbo.AppendTarget (id BIGINT NOT NULL CHECK (id < 10)); INSERT dbo.AppendTarget VALUES (7);');
      await assert.rejects(run('AppendTarget','id\n1\n50\n',[column('id','BIGINT')],'append'), /CHECK|constraint/i);
      assert.deepEqual(await rows('AppendTarget'), ['7']);
    });

    await t.test('cancellation after staging leaves truncate target intact', async () => {
      await pool.request().batch('CREATE TABLE dbo.CancelTarget (id BIGINT NOT NULL); INSERT dbo.CancelTarget VALUES (7);');
      const token = cancellationToken();
      await assert.rejects(run('CancelTarget','id\n1\n',[column('id','BIGINT')],'truncateLoad', { token, progress:{report(value){if(/staged/.test(value.message))token.cancel();}} }), /cancel/i);
      assert.deepEqual(await rows('CancelTarget'), ['7']);
    });

    await t.test('cancellation after actual TRUNCATE rolls back before final insert', async () => {
      await pool.request().batch('CREATE TABLE dbo.CancelAfterTruncate (id BIGINT NOT NULL); INSERT dbo.CancelAfterTruncate VALUES (7);');
      const token = cancellationToken();
      class ObservedRequest extends sql.Request { async batch(text) { const result = await super.batch(text); if(/^TRUNCATE/.test(text))token.cancel();return result; } }
      const observed = loadSource(importerPath, { vscode:{CancellationError},mssql:{...sql,Request:ObservedRequest} });
      const csvPath = path.join(directory,'cancel-after-truncate.csv'); await fs.writeFile(csvPath,'id\n1\n');
      await assert.rejects(observed.runImport({csvPath,driverConfig:{...config,database},mode:'truncateLoad',target:{schema:'dbo',name:'CancelAfterTruncate'},columns:[column('id','BIGINT')],batchSize:1},{report(){}},token),/cancel/i);
      assert.deepEqual(await rows('CancelAfterTruncate'), ['7']);
    });

    await t.test('existing target types override CSV inference and reject invalid conversion', async () => {
      await pool.request().batch('CREATE TABLE dbo.RealTypes (id INT NOT NULL); INSERT dbo.RealTypes VALUES (7);');
      await assert.rejects(run('RealTypes','id\nabc\n',[column('id','NVARCHAR(128)')],'append'), /record 2.*id.*integer/i);
      assert.deepEqual(await rows('RealTypes'), ['7']);
    });

    await t.test('varchar length is validated without silently truncating', async () => {
      await pool.request().batch("CREATE TABLE dbo.TextTarget (id INT NOT NULL, value VARCHAR(3) NOT NULL); INSERT dbo.TextTarget VALUES (7,'old');");
      await assert.rejects(run('TextTarget','id,value\n1,abcd\n',[column('id','INT'),column('value','VARCHAR(3)')],'truncateLoad'), /record 2.*value.*truncation/i);
      assert.deepEqual(await rows('TextTarget'), ['7']);
    });

    await t.test('empty imports cannot truncate a target', async () => {
      await pool.request().batch('CREATE TABLE dbo.EmptyTarget (id BIGINT NOT NULL); INSERT dbo.EmptyTarget VALUES (7);');
      await assert.rejects(run('EmptyTarget','id\n',[column('id','BIGINT')],'truncateLoad'), /no data rows/i);
      assert.deepEqual(await rows('EmptyTarget'), ['7']);
    });

    await t.test('duplicate converted merge keys are rejected atomically', async () => {
      await pool.request().batch('CREATE TABLE dbo.MergeDup (id BIGINT NOT NULL, value INT NOT NULL); INSERT dbo.MergeDup VALUES (1,7);');
      await assert.rejects(run('MergeDup','id,value\n1,8\n01,9\n',[column('id','BIGINT',{isKey:true}),column('value','INT')],'merge'), /duplicate upsert keys/i);
      assert.equal((await pool.request().query('SELECT value FROM dbo.MergeDup;')).recordset[0].value,7);
    });

    await t.test('null merge keys are rejected atomically', async () => {
      await pool.request().batch('CREATE TABLE dbo.MergeNull (id BIGINT NULL, value INT NOT NULL); INSERT dbo.MergeNull VALUES (1,7);');
      await assert.rejects(run('MergeNull','id,value\n,8\n',[column('id','BIGINT',{isKey:true,nullable:true}),column('value','INT')],'merge'), /keys cannot be empty/i);
      assert.equal((await pool.request().query('SELECT COUNT(*) AS n FROM dbo.MergeNull;')).recordset[0].n,1);
    });

    await t.test('merge updates matches and inserts new rows with exact decimals', async () => {
      await pool.request().batch('CREATE TABLE dbo.MergeGood (id BIGINT NOT NULL PRIMARY KEY, amount DECIMAL(38,10) NOT NULL); INSERT dbo.MergeGood VALUES (1,7);');
      assert.equal((await run('MergeGood','id,amount\n1,12345678901234567890.1234567890\n2,0.0000000001\n',[column('id','BIGINT',{isKey:true}),column('amount','DECIMAL(38,10)')],'merge')).rowsLoaded,2);
      const result=(await pool.request().query('SELECT CONVERT(NVARCHAR(MAX),amount) AS amount FROM dbo.MergeGood ORDER BY id;')).recordset.map(r=>r.amount);
      assert.deepEqual(result,['12345678901234567890.1234567890','0.0000000001']);
    });

    await t.test('identity/computed columns fail preflight without touching the target', async () => {
      await pool.request().batch('CREATE TABLE dbo.Generated (id INT IDENTITY NOT NULL, value INT NOT NULL, calculated AS (value * 2)); INSERT dbo.Generated(value) VALUES (7);');
      await assert.rejects(run('Generated','id,value\n8,9\n',[column('id','INT'),column('value','INT')],'truncateLoad'), /generated/i);
      assert.deepEqual(await rows('Generated'),['1']);
      await run('Generated','value\n8\n',[column('value','INT')],'append');
      assert.deepEqual((await pool.request().query('SELECT value FROM dbo.Generated ORDER BY id;')).recordset.map(r=>r.value),[7,8]);
    });

    await t.test('UTF8 varchar target text and merge keys retain the target collation', async () => {
      await pool.request().batch('CREATE TABLE dbo.Utf8Target (id INT NOT NULL, value VARCHAR(100) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NOT NULL);');
      await run('Utf8Target','id,value\n1,日本語\n',[column('id','INT'),column('value','VARCHAR(100)')],'append');
      assert.equal((await pool.request().query('SELECT value FROM dbo.Utf8Target;')).recordset[0].value,'日本語');
      await pool.request().batch("CREATE TABLE dbo.SensitiveKeys (id INT NOT NULL, value NVARCHAR(20) COLLATE Latin1_General_100_CS_AS NOT NULL); INSERT dbo.SensitiveKeys VALUES (1,N'A');");
      await run('SensitiveKeys','id,value\n2,A\n3,a\n',[column('id','INT'),column('value','NVARCHAR(20)',{isKey:true})],'merge');
      assert.deepEqual((await pool.request().query('SELECT id,value FROM dbo.SensitiveKeys ORDER BY id;')).recordset,[{id:2,value:'A'},{id:3,value:'a'}]);
    });

    await t.test('varchar values unrepresentable in the target code page fail without loss', async () => {
      await pool.request().batch("CREATE TABLE dbo.AnsiTarget (id INT NOT NULL, value VARCHAR(100) COLLATE Latin1_General_100_CI_AS NOT NULL); INSERT dbo.AnsiTarget VALUES (7,'old');");
      await assert.rejects(run('AnsiTarget','id,value\n1,日本語\n',[column('id','INT'),column('value','VARCHAR(100)')],'truncateLoad'), /record 2.*value.*convert|encoding/i);
      assert.equal((await pool.request().query('SELECT value FROM dbo.AnsiTarget;')).recordset[0].value,'old');
    });

    await t.test('case-sensitive metadata maps the exact column name instead of a different case', async () => {
      await pool.request().batch('CREATE TABLE dbo.CaseColumns (foo INT NULL, Foo INT NULL);');
      await run('CaseColumns','id\n7\n',[column('id','INT',{targetName:'Foo',nullable:true})],'append');
      assert.deepEqual((await pool.request().query('SELECT foo,Foo FROM dbo.CaseColumns;')).recordset[0],{foo:null,Foo:7});
      await run('CaseColumns','a,b\n10,20\n',[column('a','INT',{targetName:'foo',nullable:true}),column('b','INT',{targetName:'Foo',nullable:true})],'append');
      assert.deepEqual((await pool.request().query('SELECT foo,Foo FROM dbo.CaseColumns WHERE foo IS NOT NULL;')).recordset[0],{foo:10,Foo:20});
    });

    await t.test('different spelling cannot map two source columns to the same resolved target', async () => {
      await pool.request().batch('CREATE TABLE dbo.ResolvedDuplicate (foo INT NULL);');
      await assert.rejects(run('ResolvedDuplicate','a,b\n1,2\n',[column('a','INT',{targetName:'foo',nullable:true}),column('b','INT',{targetName:'FOO',nullable:true})],'append'),/duplicate target column/i);
      assert.equal((await pool.request().query('SELECT COUNT(*) AS n FROM dbo.ResolvedDuplicate;')).recordset[0].n,0);
    });

    await t.test('a target schema change during staging cannot bypass exact numeric validation', async () => {
      await pool.request().batch('CREATE TABLE dbo.SchemaRace (id BIGINT NOT NULL); INSERT dbo.SchemaRace VALUES (7);');
      let attempted = false, altered = false;
      class AlteringRequest extends sql.Request {
        async bulk(table) {
          const result = await super.bulk(table);
          if (!attempted) {
            attempted = true;
            const change = pool.request(); change.timeout = 1000;
            try { await change.batch('ALTER TABLE dbo.SchemaRace ALTER COLUMN id FLOAT NOT NULL;'); altered = true; }
            catch(error) { if(error.code !== 'ETIMEOUT')throw error; }
          }
          return result;
        }
      }
      const observed = loadSource(importerPath, {vscode:{CancellationError},mssql:{...sql,Request:AlteringRequest}});
      const csvPath = path.join(directory,'schema-race.csv');await fs.writeFile(csvPath,'id\n9223372036854775807\n');
      const result = observed.runImport({csvPath,driverConfig:{...config,database},mode:'append',target:{schema:'dbo',name:'SchemaRace'},columns:[column('id','BIGINT')],batchSize:1},{report(){}},cancellationToken());
      // Catalog locks may already block ALTER; otherwise the pre-publish
      // metadata check must reject the changed conversion contract.
      if (altered) await assert.rejects(result,/schema changed/i);
      else {
        try { await result; } catch(error) { if(!/schema changed/i.test(error.message))throw error; }
      }
      assert.equal(attempted,true);
      const values = await rows('SchemaRace');
      assert.ok(values.every(value=>value === '7' || value === '9223372036854775807'));
      if(altered)assert.deepEqual(values,['7']);
    });

    await t.test('cancellation of an in-flight SQL request drains it before rollback', async () => {
      await pool.request().batch('CREATE TABLE dbo.PendingCancel (id BIGINT NOT NULL); INSERT dbo.PendingCancel VALUES (7);');
      const token = cancellationToken();
      class WaitingRequest extends sql.Request {
        async bulk(table) {
          const wait = this.query("WAITFOR DELAY '00:00:02';");
          const timer=setTimeout(()=>token.cancel(),100);
          try { await wait; } finally { clearTimeout(timer); }
          return super.bulk(table);
        }
      }
      const observed = loadSource(importerPath,{vscode:{CancellationError},mssql:{...sql,Request:WaitingRequest}});
      const csvPath=path.join(directory,'pending-cancel.csv');await fs.writeFile(csvPath,'id\n1\n');
      await assert.rejects(observed.runImport({csvPath,driverConfig:{...config,database},mode:'truncateLoad',target:{schema:'dbo',name:'PendingCancel'},columns:[column('id','BIGINT')],batchSize:1},{report(){}},token),error=>error.name==='CancellationError');
      assert.deepEqual(await rows('PendingCancel'),['7']);
    });

    await t.test('pool cleanup cannot report failure after a confirmed commit', async () => {
      class FailingCleanupPool extends sql.ConnectionPool { async close() { await super.close(); throw new Error('Synthetic cleanup failure'); } }
      const observed=loadSource(importerPath,{vscode:{CancellationError},mssql:{...sql,ConnectionPool:FailingCleanupPool}});
      const csvPath=path.join(directory,'cleanup.csv');await fs.writeFile(csvPath,'id\n7\n');
      const result=await observed.runImport({csvPath,driverConfig:{...config,database},mode:'create',target:{schema:'dbo',name:'CleanupCommit'},columns:[column('id','BIGINT')],batchSize:1},{report(){}},cancellationToken());
      assert.equal(result.rowsLoaded,1);assert.deepEqual(await rows('CleanupCommit'),['7']);
    });
  } finally {
    if(pool)await pool.close();
    await master.request().batch(`IF DB_ID(N'${database}') IS NOT NULL BEGIN ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; END;`);
    await master.close();
    await fs.rm(directory,{recursive:true,force:true});
  }
});
