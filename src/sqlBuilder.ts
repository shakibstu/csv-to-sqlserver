import { parseSqlType } from './sqlTypes';

export interface TableRef { schema: string; name: string }
export interface ColumnSpec {
  sourceName: string;
  targetName: string;
  sqlType: string;
  nullable: boolean;
  isKey?: boolean;
  /** Populated from SQL metadata, never from the webview. */
  collation?: string;
}

export function quoteIdent(name: string): string {
  if (typeof name !== 'string' || !name.trim() || name.length > 128 || name.includes('\0')) {
    throw new Error('SQL identifier must contain 1 to 128 characters and no NUL characters.');
  }
  return `[${name.replace(/\]/g, ']]')}]`;
}

export function qualified(table: TableRef): string {
  return !table.schema || table.name.startsWith('#') ? quoteIdent(table.name)
    : `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
}

export function buildCreateTable(table: TableRef, columns: ColumnSpec[]): string {
  if (!columns.length) throw new Error('At least one column is required.');
  const definitions = columns.map(c => `  ${quoteIdent(c.targetName)} ${parseSqlType(c.sqlType).sqlType} ${c.nullable ? 'NULL' : 'NOT NULL'}`);
  return `CREATE TABLE ${qualified(table)} (\n${definitions.join(',\n')}\n);`;
}

export function buildTruncate(table: TableRef): string { return `TRUNCATE TABLE ${qualified(table)};`; }
export function stagingColumn(index: number): string { return `__csv_${index}`; }

export function buildCreateStaging(staging: TableRef, columns: ColumnSpec[]): string {
  const definitions = columns.map((column, i) => {
    const collation = column.collation || 'DATABASE_DEFAULT';
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(collation)) throw new Error('Invalid SQL collation name.');
    return `  ${quoteIdent(stagingColumn(i))} NVARCHAR(MAX) COLLATE ${collation} NULL`;
  });
  return `CREATE TABLE ${qualified(staging)} ([__csv_row] INT NOT NULL,\n${definitions.join(',\n')}\n);`;
}

export function convertedColumn(column: ColumnSpec, index: number, alias = 'raw'): string {
  const type = parseSqlType(column.sqlType);
  const style = type.base === 'BINARY' || type.base === 'VARBINARY' ? ', 1'
    : ['DATE', 'DATETIME', 'SMALLDATETIME', 'DATETIME2', 'DATETIMEOFFSET', 'TIME'].includes(type.base) ? ', 126' : '';
  return `TRY_CONVERT(${type.sqlType}, ${alias}.${quoteIdent(stagingColumn(index))}${style})`;
}

export function typedSource(staging: TableRef, columns: ColumnSpec[]): string {
  return `SELECT ${columns.map((c, i) => `${convertedColumn(c, i)} AS ${quoteIdent(c.targetName)}`).join(', ')} FROM ${qualified(staging)} AS raw`;
}

export function buildInsertFromStaging(target: TableRef, staging: TableRef, columns: ColumnSpec[]): string {
  return `INSERT INTO ${qualified(target)} (${columns.map(c => quoteIdent(c.targetName)).join(', ')})\n${typedSource(staging, columns)};`;
}

export function buildMergeFromStaging(target: TableRef, staging: TableRef, columns: ColumnSpec[]): string {
  const keys = columns.filter(c => c.isKey);
  if (!keys.length) throw new Error('Upsert (MERGE) requires at least one key column.');
  const nonKeys = columns.filter(c => !c.isKey);
  const on = keys.map(c => `tgt.${quoteIdent(c.targetName)} = src.${quoteIdent(c.targetName)}`).join(' AND ');
  const update = nonKeys.length ? `WHEN MATCHED THEN UPDATE SET ${nonKeys.map(c => `tgt.${quoteIdent(c.targetName)} = src.${quoteIdent(c.targetName)}`).join(', ')}\n` : '';
  return `MERGE ${qualified(target)} WITH (HOLDLOCK) AS tgt\nUSING (${typedSource(staging, columns)}) AS src\nON (${on})\n${update}` +
    `WHEN NOT MATCHED BY TARGET THEN INSERT (${columns.map(c => quoteIdent(c.targetName)).join(', ')}) VALUES (${columns.map(c => `src.${quoteIdent(c.targetName)}`).join(', ')});`;
}
