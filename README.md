# CSV to SQL Server

<img src="media/icon.png" alt="CSV to SQL Server logo" width="128" height="128">

A VS Code extension that imports CSV files into SQL Server or Azure SQL using validated mappings and atomic database transactions.

## Requirements

- VS Code 1.101 or later.
- The **SQL Server (mssql)** extension, installed automatically as a dependency.
- Permission to read target metadata, create temporary staging tables, and perform the selected target operation.
- SQL Server 2016 or later, or Azure SQL. The importer uses `TRY_CONVERT` and generated-column metadata.

## Import a file

1. Right-click a local `.csv` in Explorer and select **Import CSV to SQL Server...**, or run **SQL Server: Import CSV...** from the command palette.
2. Choose the delimiter and select **Sample & Infer Columns**. Changing the file or delimiter invalidates the previous sample.
3. Select **Pick SQL Server connection...**. Choose a profile from `mssql.connections`, or enter a new connection. Missing credentials are requested privately and retained only while this wizard is open.
4. Choose the database, schema, table, and import mode.
5. Review the preview and mappings. Uncheck **Include** for unwanted CSV columns, including identity or computed target columns. For a new table, review the inferred SQL types and nullability. Existing tables always use their actual SQL schema.
6. Select **Run Import**. Truncate-and-load asks you to confirm the complete target before proceeding. The progress notification supports cancellation.

The importer reads records with backpressure, stages raw text on one connection, validates every value, and applies changes in a transaction. Parsing, conversion, constraint, and cancellation failures roll back target changes. Error messages identify CSV record and column where possible. An error saying rollback or commit could not be confirmed requires inspecting the target before retrying.

## Import modes

| Mode | Behaviour |
| --- | --- |
| Create new table | Creates a table and inserts all validated rows. An existing table is an error. |
| Append | Inserts into an existing table. A failure cannot leave earlier batches appended. |
| Truncate + load | Replaces the target contents atomically. Empty files and invalid records cannot empty the target. SQL Server's usual TRUNCATE restrictions still apply. |
| Upsert | Updates matching rows and inserts new rows using the selected keys. Empty or duplicate source keys, or duplicate target keys, are rejected. Equality follows the target column collation. |

Generated target columns must be excluded. Unmapped required columns need a SQL default. If the target schema changes during staging, the import stops before publishing rows.

## Connections and authentication

Connection selection reads saved profile settings; it does not call private or assumed APIs on the mssql extension. Saved passwords in another extension's credential store are not accessible, so a missing SQL password is prompted for rather than guessed or extracted.

| Authentication | Support |
| --- | --- |
| SQL Login | Explicit username and password, including correctly parsed quoted connection strings. |
| Windows / NTLM | Explicit domain, username, and password. Automatic integrated Windows credentials are not supported. |
| Azure MFA / interactive | VS Code's Microsoft authentication provider, with an explicitly selected account and directory tenant ID. Tokens are requested again before importing and checked for account, tenant, resource, and expiry. Public Azure SQL scope only. |
| Azure managed identity | Driver-native VM or App Service identity flow. Requires an Azure-hosted environment with that identity enabled. Optional client ID selects a user-assigned identity. |
| Azure service principal | Driver-native client ID, client secret, and tenant ID. |

Unsupported authentication modes fail explicitly. `Encrypt=Mandatory` and `Encrypt=Optional` are mapped deliberately; `Strict` is rejected because the selected driver does not provide that connection-string mode. New connections enable encryption and certificate validation by default. TCP prefixes and explicit server ports are supported.

Passwords and access tokens are not written to settings or sent to the wizard webview.

## Data handling

- CSV input must contain a header. Blank or duplicate headers, including names that differ only by case, are rejected. Empty CSV fields mean SQL `NULL`.
- Inference uses a sample and is conservative for mixed kinds. Review types before creating a table; incompatible later rows abort the import.
- BIGINT and DECIMAL values remain text until SQL-side conversion, preserving exact digits. Out-of-range values and decimal values that would lose nonzero fractional digits are rejected.
- Dates and times use ISO forms. Invalid calendar dates fail instead of being adjusted by JavaScript. Date-only values in datetime columns become midnight. Choose `DATETIMEOFFSET` when offsets must be retained.
- Supported types: BIT, integer types, DECIMAL/NUMERIC, MONEY/SMALLMONEY, FLOAT/REAL, DATE, DATETIME/SMALLDATETIME, DATETIME2/DATETIMEOFFSET, TIME, character types, BINARY/VARBINARY hex values, UNIQUEIDENTIFIER, and XML. Type parameters are validated; arbitrary SQL fragments are rejected.
- Character length and encoding are checked against the target collation. Unrepresentable VARCHAR text fails instead of becoming question marks.
- Virtual/non-file sources are not supported. Imports use tempdb and transaction-log space and lock the target while applying rows.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `csvToSqlServer.defaultBatchSize` | 1000 | Staging batch size, from 1 to 10,000. |
| `csvToSqlServer.inferSampleSize` | 1000 | Number of records sampled for inference. |
| `csvToSqlServer.defaultSchema` | dbo | Default target schema. |

## Build and verify

Use Node.js 22 or later:

```sh
npm ci
npm test
npm run check
npm audit
npm run package
```

Press **F5** in VS Code to launch the extension development host. `npm run package` creates a local VSIX and runs the regression suite first.

The normal suite exercises the CSV reader, SQL types/builders, importer cancellation, authentication configuration, and executable wizard JavaScript. SQL integration tests are skipped unless `TEST_SQL_CONFIG` is set. To run them against a local development SQL Server:

```sh
TEST_SQL_CONFIG='{"server":"127.0.0.1","port":1433,"user":"sa","password":"YOUR_LOCAL_TEST_PASSWORD","options":{"encrypt":false,"trustServerCertificate":true}}' npm run test:integration
```

The integration suite creates uniquely named temporary databases and drops them afterward. The test login needs CREATE/DROP DATABASE permissions. It checks exact values, rollback after truncate/constraint failures, merge keys, target encodings and case sensitivity, schema changes, and in-flight cancellation.

## License

MIT; see the LICENSE file included with the extension.
