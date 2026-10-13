# CSV to SQL Server

<img src="media/icon.png" alt="CSV to SQL Server logo" width="128" height="128">

A VS Code extension that imports CSV files into SQL Server or Azure SQL using validated mappings and atomic database transactions.

## Requirements

- VS Code 1.101 or later.
- The **SQL Server (mssql)** extension, installed automatically as a dependency.
- Permission to read target metadata, create temporary staging tables, and perform the selected target operation.
- SQL Server 2016 or later, or Azure SQL. The importer uses `TRY_CONVERT` and generated-column metadata.

## How to use

### 1. Install the extension

If the extension is available on the Marketplace, open **Extensions** in VS Code, search for `@id:Shakibstu69.csv-to-sqlserver`, and select **Install**.

To install a downloaded `.vsix` file:

1. Open the Command Palette with **Ctrl+Shift+P** on Windows/Linux or **Cmd+Shift+P** on macOS.
2. Run **Extensions: Install from VSIX...** and select `csv-to-sqlserver-0.2.1.vsix`.
3. Reload VS Code if prompted. Check that **SQL Server (mssql)** is installed and enabled too.

You can also install from a terminal in the folder containing the package:

```sh
code --install-extension csv-to-sqlserver-0.2.1.vsix
```

See the [VS Code extension installation guide](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#install-from-a-vsix) for more installation options.

### 2. Prepare your CSV

Use a local CSV file with a header row and at least one data row. Every header must be nonempty and unique, including when compared without regard to case. Empty fields are imported as SQL `NULL`.

For a first import, save this as `customers.csv`:

```csv
id,name,balance,joined_on
1,Ada,125.50,2026-01-15
2,Omar,49.95,2026-01-16
```

### 3. Open the import wizard

Open the folder containing your CSV in VS Code. Right-click the file in **Explorer** and choose **Import CSV to SQL Server...**.

Alternatively, open the Command Palette, run **SQL Server: Import CSV...**, and choose the file.

### 4. Preview the file

Choose the matching **Delimiter**: comma, semicolon, tab, or pipe. For the example above, use comma. Select **Sample & Infer Columns** to display the column mappings and preview the first 20 rows.

If all fields appear in one column, select the correct delimiter and sample again. Changing the file or delimiter requires a new sample.

### 5. Connect to SQL Server

Select **Pick SQL Server connection...** and choose either a saved SQL Server profile or **New connection...**.

For a new SQL Login connection, enter your server (for example, `your-server,1433`), choose **SQL Login**, enter the database if known, then provide your username and password. For Azure SQL, use the server hostname and an authentication method supported by your environment; interactive sign-in also asks for your directory tenant ID.

Missing credentials for saved profiles are requested privately. Passwords entered here are used only while the wizard is open. The supported sign-in methods are listed under [Connections and authentication](#connections-and-authentication).

### 6. Choose the target and map columns

Select the **Database**, enter the **Schema** and **Table** separately, and choose the **Mode**. For the example, use an existing database you can write to, schema `dbo`, table `Customers`, and **Create new table**. The table must not already exist in this mode.

Review each column before importing:

| Control | What to do |
| --- | --- |
| Include | Keep the columns you want to import checked. Uncheck unwanted columns and identity or computed target columns. |
| Target name | Enter the destination column name. For an existing table, it must match an actual target column. |
| SQL type | In Create mode, choose a type that fits every row. Existing tables use their actual SQL types. |
| Nullable | In Create mode, check this if the column may contain empty values. Existing tables use their actual nullability. |
| Key (MERGE) | For Upsert, check one or more included columns that uniquely identify a row. |

For `customers.csv`, set `id` to `INT`, `name` to `NVARCHAR(100)`, `balance` to `DECIMAL(10,2)`, and `joined_on` to `DATE`. Keep all four columns included. The default **Batch size** of 1000 is a suitable starting point.

### 7. Run and check the result

Select **Run Import** and wait for the completion notification. It reports the imported row count and target table. You can cancel using the progress notification. **Truncate + load existing table** asks you to confirm the target before replacing its contents.

To verify the example, run this query using your SQL Server query editor in the same database:

```sql
SELECT id, name, balance, joined_on
FROM dbo.Customers
ORDER BY id;
```

You should see two rows, with balances `125.50` and `49.95`.

### Update existing rows with Upsert

To update Ada's balance and add a new customer to the example table, save and open another CSV:

```csv
id,name,balance,joined_on
1,Ada,200.00,2026-01-15
3,Grace,80.25,2026-01-17
```

Sample the file, connect to the same database, and choose schema `dbo`, table `Customers`, and **Upsert (MERGE on key)**. Map the four columns and check **Key (MERGE)** for `id`. Select **Run Import**. The table will contain Ada with the new balance, Omar unchanged, and the new row for Grace.

### Troubleshooting

| Problem | What to check |
| --- | --- |
| Run Import is disabled | Finish sampling, select a connection, and include at least one column. Wait for any sampling or connection request to finish. |
| Preview has the wrong columns | Match the delimiter to the file and select Sample & Infer Columns again. |
| Connection fails | Check the host, port, authentication method, credentials, database access, and network access. New connections require a trusted server certificate. |
| A value cannot be imported | Use the record and column named in the error to correct the value. In Create mode, review the SQL type and Nullable setting; in other modes, check the existing table schema. |
| Create reports an existing table | Choose another table name, or select an existing-table mode. |
| Upsert rejects the keys | Select keys that uniquely identify rows. Included key values must be nonempty, and both the source and target must have unique key combinations. |

Parsing, conversion, constraint, and cancellation failures roll back target changes. If an error says rollback or commit could not be confirmed, inspect the target table before retrying.

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
