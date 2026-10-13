import * as vscode from 'vscode';
import * as sql from 'mssql';
import { randomUUID } from 'crypto';
import { streamCsv } from './csv';
import { normalizeValue, parseSqlType } from './sqlTypes';
import {
  buildCreateStaging, buildCreateTable, buildInsertFromStaging, buildMergeFromStaging,
  buildTruncate, ColumnSpec, convertedColumn, qualified, quoteIdent, stagingColumn, TableRef, typedSource,
} from './sqlBuilder';

export type ImportMode = 'create' | 'append' | 'truncateLoad' | 'merge';
export interface ImportRequest {
  csvPath: string;
  driverConfig: sql.config;
  database?: string;
  mode: ImportMode;
  target: TableRef;
  columns: ColumnSpec[];
  batchSize: number;
  delimiter?: string;
}

interface TargetColumn {
  name: string; typeName: string; maxLength: number; precision: number; scale: number;
  nullable: boolean; identity: boolean; computed: boolean; generated: number; hasDefault: boolean;
  collationName?: string; objectId?: number; modified?: Date; defaultObjectId?: number;
}

function validateRequest(request: ImportRequest): void {
  if (!['create', 'append', 'truncateLoad', 'merge'].includes(request.mode)) throw new Error('Invalid import mode.');
  if (!Number.isInteger(request.batchSize) || request.batchSize < 1 || request.batchSize > 10000) throw new Error('Batch size must be an integer between 1 and 10000.');
  if (!request.csvPath || !request.driverConfig || !(request.database || request.driverConfig.database)) throw new Error('Select a CSV file, connection, and target database.');
  quoteIdent(request.target.schema);
  quoteIdent(request.target.name);
  if (request.target.name.startsWith('#')) throw new Error('Temporary tables cannot be import targets.');
  if (!Array.isArray(request.columns) || !request.columns.length || request.columns.length > 1023) throw new Error('Select between 1 and 1023 columns.');
  const targets = new Set<string>();
  for (const column of request.columns) {
    if (!column || typeof column.sourceName !== 'string' || !column.sourceName.trim()) throw new Error('Each mapping requires a CSV column name.');
    quoteIdent(column.targetName);
    const name = column.targetName;
    if (targets.has(name)) throw new Error(`Duplicate target column: ${column.targetName}`);
    targets.add(name);
    parseSqlType(column.sqlType);
    if (typeof column.nullable !== 'boolean' || (column.isKey !== undefined && typeof column.isKey !== 'boolean')) throw new Error('Invalid column mapping.');
  }
  if (request.mode === 'merge' && !request.columns.some(c => c.isKey)) throw new Error('Upsert requires at least one key column.');
}

function typeFromMetadata(column: TargetColumn): string {
  const base = column.typeName.toUpperCase();
  if (['CHAR', 'NCHAR', 'VARCHAR', 'NVARCHAR', 'BINARY', 'VARBINARY'].includes(base)) {
    const length = column.maxLength === -1 ? 'MAX' : column.maxLength / (base.startsWith('N') ? 2 : 1);
    return parseSqlType(`${base}(${length})`).sqlType;
  }
  if (base === 'DECIMAL' || base === 'NUMERIC') return parseSqlType(`${base}(${column.precision},${column.scale})`).sqlType;
  if (['DATETIME2', 'DATETIMEOFFSET', 'TIME'].includes(base)) return parseSqlType(`${base}(${column.scale})`).sqlType;
  if (base === 'FLOAT') return parseSqlType(`FLOAT(${column.precision})`).sqlType;
  return parseSqlType(base).sqlType;
}

function rawBulkTable(staging: TableRef, columns: ColumnSpec[]): sql.Table {
  const table = new sql.Table(qualified(staging));
  table.create = false;
  table.columns.add('__csv_row', sql.Int, { nullable: false });
  columns.forEach((_, i) => table.columns.add(stagingColumn(i), sql.NVarChar(sql.MAX), { nullable: true }));
  return table;
}

/** Stages and validates first, then publishes atomically on one pinned connection. */
export async function runImport(
  request: ImportRequest,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<{ rowsLoaded: number }> {
  const checkCancelled = () => { if (token.isCancellationRequested) throw new vscode.CancellationError(); };
  checkCancelled();
  validateRequest(request);
  const controller = new AbortController();
  let activeRequest: sql.Request | undefined;
  let activeOperation: Promise<unknown> | undefined;
  let committing = false;
  const cancellation = token.onCancellationRequested?.(() => {
    if (committing) return;
    controller.abort();
    try { activeRequest?.cancel(); } catch { /* The operation may have just finished. */ }
  });
  const pool = new sql.ConnectionPool({ ...request.driverConfig, database: request.database || request.driverConfig.database });
  let transaction: sql.Transaction | undefined;
  let begun = false;
  let rolledBack = false;
  let committed = false;
  const execute = async <T>(operation: (statement: sql.Request) => Promise<T>): Promise<T> => {
    checkCancelled();
    const statement = new sql.Request(transaction!);
    activeRequest = statement;
    try {
      const pending = operation(statement);
      activeOperation = pending;
      return await pending;
    } finally {
      if (activeRequest === statement) { activeRequest = undefined; activeOperation = undefined; }
    }
  };
  try {
    await pool.connect();
    checkCancelled();
    transaction = new sql.Transaction(pool);
    transaction.on('rollback', () => { rolledBack = true; });
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    begun = true;
    await execute(statement => statement.batch('SET XACT_ABORT ON;'));
    const readMetadata = () => execute(statement => statement
      .input('schema', sql.NVarChar(128), request.target.schema)
      .input('table', sql.NVarChar(128), request.target.name)
      .query<TargetColumn>(`SELECT c.name, bt.name AS typeName, c.max_length AS maxLength,
        c.precision, c.scale, c.is_nullable AS nullable, c.is_identity AS [identity],
        c.is_computed AS computed, c.generated_always_type AS generated,
        c.collation_name AS collationName, t.object_id AS objectId, t.modify_date AS modified,
        c.default_object_id AS defaultObjectId,
        CAST(CASE WHEN c.default_object_id <> 0 THEN 1 ELSE 0 END AS bit) AS hasDefault
        FROM sys.tables AS t JOIN sys.schemas AS s ON s.schema_id = t.schema_id
        JOIN sys.columns AS c ON c.object_id = t.object_id
        JOIN sys.types AS bt ON bt.user_type_id = c.system_type_id AND bt.user_type_id = bt.system_type_id
        WHERE s.name = @schema AND t.name = @table ORDER BY c.column_id;`));
    const metadata = await readMetadata();
    const existing = metadata.recordset;
    if (request.mode === 'create' && existing.length) throw new Error('Target table already exists. Choose Append or a new table name.');
    if (request.mode !== 'create' && !existing.length) throw new Error('Target table does not exist or its metadata is not accessible.');
    let columns: ColumnSpec[] = request.columns.map(c => ({ ...c, collation: undefined, sqlType: parseSqlType(c.sqlType).sqlType }));
    if (existing.length) {
      columns = columns.map(mapping => {
        const exact = existing.find(c => c.name === mapping.targetName);
        const matches = existing.filter(c => c.name.toLowerCase() === mapping.targetName.toLowerCase());
        if (!exact && matches.length > 1) throw new Error(`Target column name is ambiguous; use its exact case: ${mapping.targetName}`);
        const target = exact || matches[0];
        if (!target) throw new Error(`Target column does not exist: ${mapping.targetName}`);
        if (target.identity || target.computed || target.generated || ['timestamp', 'rowversion'].includes(target.typeName.toLowerCase())) throw new Error(`Target column is generated and cannot be imported: ${target.name}`);
        return { ...mapping, targetName: target.name, sqlType: typeFromMetadata(target), nullable: !!target.nullable, collation: target.collationName || undefined };
      });
      const resolvedNames = new Set<string>();
      for (const column of columns) {
        if (resolvedNames.has(column.targetName)) throw new Error(`Duplicate target column after resolving metadata: ${column.targetName}`);
        resolvedNames.add(column.targetName);
      }
      const omittedRequired = existing.find(c => !c.nullable && !c.identity && !c.computed && !c.generated && !c.hasDefault && !['timestamp', 'rowversion'].includes(c.typeName.toLowerCase()) && !columns.some(m => m.targetName === c.name));
      if (omittedRequired) throw new Error(`Required target column is not mapped: ${omittedRequired.name}`);
    }
    const staging = { schema: '', name: `#csv_stage_${randomUUID().replace(/-/g, '')}` };
    await execute(statement => statement.batch(buildCreateStaging(staging, columns)));
    const types = columns.map(c => parseSqlType(c.sqlType));
    let batch = rawBulkTable(staging, columns);
    let rowsLoaded = 0;
    const flush = async () => {
      if (!batch.rows.length) return;
      await execute(statement => statement.bulk(batch));
      rowsLoaded += batch.rows.length;
      progress.report({ message: `Validated and staged ${rowsLoaded.toLocaleString()} rows...` });
      batch = rawBulkTable(staging, columns);
    };
    await streamCsv(request.csvPath, async (row, rowNumber) => {
      checkCancelled();
      const values = columns.map((column, i) => {
        try {
          if (!Object.prototype.hasOwnProperty.call(row, column.sourceName)) throw new Error('Mapped CSV column is missing. Resample the file.');
          const value = normalizeValue(row[column.sourceName], types[i]);
          if (value === null && (!column.nullable || (request.mode === 'merge' && column.isKey))) throw new Error(column.isKey ? 'Upsert keys cannot be empty.' : 'Column does not allow empty values.');
          return value;
        } catch (error) { throw new Error(`CSV record ${rowNumber}, column "${column.sourceName}": ${error instanceof Error ? error.message : String(error)}`); }
      });
      batch.rows.add(rowNumber, ...values);
      if (batch.rows.length >= request.batchSize) await flush();
    }, { delimiter: request.delimiter, signal: controller.signal });
    await flush();
    checkCancelled();
    if (!rowsLoaded) throw new Error('The CSV contains no data rows. No target changes were made.');

    const badValues = columns.map((column, i) => {
      const type = types[i];
      const raw = `raw.${quoteIdent(stagingColumn(i))}`;
      const encoded = `CONVERT(VARCHAR(MAX), ${raw})`;
      const tooLong = ['VARCHAR', 'CHAR'].includes(type.base) && type.length !== -1 ? ` OR DATALENGTH(${encoded}) > ${type.length}` : '';
      const lossy = ['VARCHAR', 'CHAR'].includes(type.base)
        ? ` OR CONVERT(VARBINARY(MAX), CONVERT(NVARCHAR(MAX), ${encoded})) <> CONVERT(VARBINARY(MAX), ${raw})` : '';
      return `(N'${column.targetName.replace(/'/g, "''")}', CASE WHEN ${raw} IS NOT NULL AND (${convertedColumn(column, i)} IS NULL${tooLong}${lossy}) THEN 1 ELSE 0 END)`;
    });
    const invalid = await execute(statement => statement.query<{ rowNumber: number; columnName: string }>(
      `SELECT TOP (1) raw.[__csv_row] AS rowNumber, failures.columnName
       FROM ${qualified(staging)} AS raw CROSS APPLY (VALUES ${badValues.join(', ')}) AS failures(columnName, invalid)
       WHERE failures.invalid = 1 ORDER BY raw.[__csv_row];`));
    if (invalid.recordset.length) {
      const failure = invalid.recordset[0];
      throw new Error(`CSV record ${failure.rowNumber}, target column "${failure.columnName}": value cannot be converted without truncation or encoding loss.`);
    }
    if (existing.length) {
      // Staging can take minutes. Lock before rechecking metadata so a concurrent
      // ALTER/DROP cannot change the conversion contract between check and commit.
      await execute(statement => statement.query(`SELECT TOP (1) 1 AS locked FROM ${qualified(request.target)} WITH (TABLOCKX, HOLDLOCK);`));
      const current = await readMetadata();
      if (JSON.stringify(current.recordset) !== JSON.stringify(existing)) throw new Error('Target schema changed during the import. Resample and review its mappings before retrying.');
    }
    if (request.mode === 'merge') {
      const keyNames = columns.filter(c => c.isKey).map(c => quoteIdent(c.targetName)).join(', ');
      const duplicates = await execute(statement => statement.query(
        `SELECT TOP (1) 1 AS duplicate FROM (${typedSource(staging, columns)}) AS src GROUP BY ${keyNames} HAVING COUNT_BIG(*) > 1;`));
      if (duplicates.recordset.length) throw new Error('CSV contains duplicate upsert keys after conversion. No target changes were made.');
      const targetDuplicates = await execute(statement => statement.query(
        `SELECT TOP (1) 1 AS duplicate FROM ${qualified(request.target)} WITH (UPDLOCK, HOLDLOCK) GROUP BY ${keyNames} HAVING COUNT_BIG(*) > 1;`));
      if (targetDuplicates.recordset.length) throw new Error('Target contains duplicate upsert keys. Choose columns that uniquely identify target rows.');
    }
    checkCancelled();
    progress.report({ message: 'Applying validated rows...' });
    if (request.mode === 'create') await execute(statement => statement.batch(buildCreateTable(request.target, columns)));
    if (request.mode === 'truncateLoad') await execute(statement => statement.batch(buildTruncate(request.target)));
    await execute(statement => statement.batch(request.mode === 'merge'
      ? buildMergeFromStaging(request.target, staging, columns)
      : buildInsertFromStaging(request.target, staging, columns)));
    await execute(statement => statement.batch(`DROP TABLE ${qualified(staging)};`));
    checkCancelled();
    // Commit is the linearization point: once started it must be allowed to
    // finish so cancellation cannot report failure after changes were committed.
    committing = true;
    await transaction.commit();
    committed = true;
    return { rowsLoaded };
  } catch (error) {
    // CSV abort/error settles promptly while an async callback may still be in
    // flight. A transaction cannot roll back until its TDS request acknowledges.
    if (activeOperation) {
      try { activeRequest?.cancel(); } catch { /* It may already have settled. */ }
      await activeOperation.catch(() => {});
    }
    if (begun && !committed && !rolledBack) {
      try { await transaction!.rollback(); }
      catch (rollbackError) {
        throw new Error(`Import failed and rollback could not be confirmed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, { cause: error });
      }
    }
    if (token.isCancellationRequested && !committing) throw new vscode.CancellationError();
    throw error;
  } finally {
    cancellation?.dispose();
    // Cleanup cannot turn a confirmed commit into an apparent failed import or
    // replace an error about an uncertain transaction outcome.
    await pool.close().catch(() => {});
  }
}
