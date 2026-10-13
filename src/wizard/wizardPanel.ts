import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  buildDriverConfig,
  fetchDatabasesWithConfig,
  getMssqlApi,
  promptForConnection,
  ConnectionInfo,
} from '../mssql';
import { readHeaderAndSample, ReadHeaderResult } from '../csv';
import { ImportMode, runImport } from '../importer';
import type { ColumnSpec } from '../sqlBuilder';

interface ConnectionState {
  api: unknown;
  info: ConnectionInfo;
}

interface WizardDefaults {
  batchSize: number;
  sampleSize: number;
  schema: string;
}

interface WizardState {
  csvPath: string;
  delimiter: string;
  resetRevision: number;
  sourceRevision: number;
  sampleRevision?: number;
  operation: 'idle' | 'sampling' | 'connecting' | 'importing';
  defaults: WizardDefaults;
  connection?: {
    revision: number;
    server: string;
    database: string;
    authenticationType: string;
    databases?: string[];
  };
  inferred?: ReadHeaderResult;
}

interface RunPayload {
  mode: ImportMode;
  database: string;
  schema: string;
  table: string;
  batchSize: number;
  columns: ColumnSpec[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  return value;
}

function isCancelled(error: unknown): boolean {
  return error instanceof vscode.CancellationError ||
    (error instanceof Error && (error.name === 'CancellationError' || error.name === 'AbortError'));
}

export class WizardPanel {
  public static current?: WizardPanel;

  public static show(context: vscode.ExtensionContext, csvUri: vscode.Uri) {
    if (csvUri.scheme !== 'file') {
      throw new Error('CSV imports require a file URI. Save this virtual resource as a file and choose it again.');
    }
    const column = vscode.ViewColumn.Active;
    if (WizardPanel.current) {
      WizardPanel.current.panel.reveal(column);
      WizardPanel.current.reset(csvUri.fsPath);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'csvToSqlServerWizard',
      'Import CSV to SQL Server',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );
    WizardPanel.current = new WizardPanel(context, panel, csvUri.fsPath);
  }

  private state: WizardState;
  private connection?: ConnectionState;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];
  private sourceRevision = 0;
  private resetRevision = 0;
  private sampleRevision = 0;
  private connectionRevision = 0;
  private sampleController?: AbortController;
  private importCancellation?: vscode.CancellationTokenSource;
  private connectionCancellation?: vscode.CancellationTokenSource;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    csvPath: string,
  ) {
    this.state = this.initialState(csvPath);
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.onMessage(message).catch((error: unknown) => this.postError(error));
      }),
    );
    context.subscriptions.push(panel);
  }

  private initialState(csvPath: string): WizardState {
    const config = vscode.workspace.getConfiguration('csvToSqlServer');
    const configuredInteger = (key: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number => {
      const value = config.get<unknown>(key, fallback);
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : fallback;
    };
    const schema = config.get<unknown>('defaultSchema', 'dbo');
    return {
      csvPath,
      delimiter: ',',
      resetRevision: ++this.resetRevision,
      sourceRevision: ++this.sourceRevision,
      operation: 'idle',
      defaults: {
        batchSize: configuredInteger('defaultBatchSize', 1000, 10000),
        sampleSize: configuredInteger('inferSampleSize', 1000),
        schema: typeof schema === 'string' && schema.trim() ? schema.trim() : 'dbo',
      },
    };
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sampleController?.abort();
    this.importCancellation?.cancel();
    this.connectionCancellation?.cancel();
    ++this.connectionRevision;
    if (WizardPanel.current === this) WizardPanel.current = undefined;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private reset(csvPath: string): void {
    if (this.state.operation === 'importing') {
      void vscode.window.showInformationMessage('Wait for the current import to finish or cancel it before selecting another CSV.');
      return;
    }
    this.sampleController?.abort();
    this.sampleController = undefined;
    ++this.connectionRevision;
    this.connectionCancellation?.cancel();
    this.connection = undefined;
    this.state = this.initialState(csvPath);
    this.postState();
  }

  private postState(): void {
    if (!this.disposed) void this.panel.webview.postMessage({ type: 'state', state: this.state });
  }

  private postError(error: unknown): void {
    if (this.disposed) return;
    this.postState();
    const message = error instanceof Error ? error.message : String(error);
    void this.panel.webview.postMessage({ type: 'error', message });
  }

  private async onMessage(message: unknown): Promise<void> {
    if (this.disposed || !isRecord(message) || typeof message.type !== 'string') return;
    if (message.type === 'ready') {
      this.postState();
      return;
    }
    // This covers confirmation, credential refresh and queued progress callbacks too.
    if (this.state.operation === 'importing') return;
    switch (message.type) {
      case 'pickConnection':
        if (this.state.operation !== 'connecting') await this.pickConnection();
        return;
      case 'setDelimiter': {
        const delimiter = message.delimiter;
        if (typeof delimiter !== 'string' || ![',', ';', '\t', '|'].includes(delimiter)) {
          throw new Error('Choose a supported CSV delimiter.');
        }
        if (delimiter === this.state.delimiter) { this.postState(); return; }
        this.sampleController?.abort();
        this.sampleController = undefined;
        this.state.delimiter = delimiter;
        this.state.sourceRevision = ++this.sourceRevision;
        this.state.inferred = undefined;
        this.state.sampleRevision = undefined;
        if (this.state.operation === 'sampling') this.state.operation = 'idle';
        this.postState();
        return;
      }
      case 'sample':
        if (this.state.operation === 'connecting') return;
        await this.sample(positiveInteger(message.sampleSize ?? this.state.defaults.sampleSize, 'Sample size'));
        return;
      case 'run':
        await this.run(message.payload, message.sourceRevision, message.sampleRevision);
        return;
    }
  }

  private async pickConnection(): Promise<void> {
    this.sampleController?.abort();
    this.sampleController = undefined;
    this.connectionCancellation?.cancel();
    const cancellation = new vscode.CancellationTokenSource();
    this.connectionCancellation = cancellation;
    const revision = ++this.connectionRevision;
    const isCurrent = () => !this.disposed && revision === this.connectionRevision;
    // Clear both sides together so cancellation cannot leave a hidden old connection.
    this.connection = undefined;
    this.state.connection = undefined;
    this.state.operation = 'connecting';
    this.postState();
    try {
      const api = await getMssqlApi();
      if (!isCurrent()) return;
      const selected = await promptForConnection(api, cancellation.token);
      if (!isCurrent()) return;
      if (!selected) return;
      if (typeof selected.server !== 'string' || !selected.server.trim()) {
        throw new Error('The picked connection has no server address.');
      }
      const info = { ...selected, server: selected.server };
      const driverConfig = await buildDriverConfig(api, info);
      if (!isCurrent()) return;
      let databases: string[] = [];
      let listError: unknown;
      try {
        databases = await fetchDatabasesWithConfig(driverConfig);
      } catch (error) {
        listError = error;
      }
      if (!isCurrent()) return;
      this.connection = { api, info };
      this.state.connection = {
        revision,
        server: info.server,
        database: typeof info.database === 'string' ? info.database : '',
        authenticationType: typeof info.authenticationType === 'string' ? info.authenticationType : 'SqlLogin',
        databases,
      };
      if (listError) {
        this.postError(new Error('Connection selected, but listing databases failed. Type a database name manually. ' +
          (listError instanceof Error ? listError.message : String(listError))));
      }
    } catch (error) {
      if (isCurrent() && !isCancelled(error)) this.postError(error);
    } finally {
      cancellation.dispose();
      if (this.connectionCancellation === cancellation) this.connectionCancellation = undefined;
      if (isCurrent()) {
        this.state.operation = 'idle';
        this.postState();
      }
    }
  }

  private async sample(sampleSize: number): Promise<void> {
    this.sampleController?.abort();
    const controller = new AbortController();
    this.sampleController = controller;
    const sourceRevision = this.state.sourceRevision;
    const isCurrent = () => !this.disposed && !controller.signal.aborted &&
      this.sampleController === controller && this.state.sourceRevision === sourceRevision;
    this.state.inferred = undefined;
    this.state.sampleRevision = undefined;
    this.state.operation = 'sampling';
    this.postState();
    try {
      const inferred = await readHeaderAndSample(this.state.csvPath, sampleSize, this.state.delimiter, { signal: controller.signal });
      if (!isCurrent()) return;
      this.state.inferred = inferred;
      this.state.sampleRevision = ++this.sampleRevision;
    } catch (error) {
      if (isCurrent() && !isCancelled(error)) this.postError(error);
    } finally {
      if (isCurrent()) {
        this.sampleController = undefined;
        this.state.operation = 'idle';
        this.postState();
      }
    }
  }

  private validatePayload(value: unknown): RunPayload {
    if (!isRecord(value)) throw new Error('Invalid import request.');
    if (typeof value.mode !== 'string' || !['create', 'append', 'truncateLoad', 'merge'].includes(value.mode)) {
      throw new Error('Choose a supported import mode.');
    }
    for (const key of ['database', 'schema', 'table'] as const) {
      if (typeof value[key] !== 'string') throw new Error(`Invalid target ${key}.`);
    }
    const table = (value.table as string).trim();
    if (!table) throw new Error('Enter a target table name.');
    const batchSize = positiveInteger(value.batchSize, 'Batch size');
    if (batchSize > 10000) throw new Error('Batch size must be between 1 and 10000.');
    if (!Array.isArray(value.columns) || value.columns.length === 0) throw new Error('Sample the CSV first so columns can be mapped.');
    const sourceNames = new Set(this.state.inferred!.columns.map(column => column.name));
    const columns = value.columns.map((column: unknown): ColumnSpec => {
      if (!isRecord(column) || typeof column.sourceName !== 'string' || !sourceNames.has(column.sourceName) ||
        typeof column.targetName !== 'string' || !column.targetName.trim() ||
        typeof column.sqlType !== 'string' || !column.sqlType.trim() ||
        typeof column.nullable !== 'boolean' || (column.isKey !== undefined && typeof column.isKey !== 'boolean')) {
        throw new Error('Invalid column mapping. Sample the current CSV again and check the mapped columns.');
      }
      return { sourceName: column.sourceName, targetName: column.targetName.trim(), sqlType: column.sqlType.trim(), nullable: column.nullable, isKey: column.isKey === true };
    });
    if (value.mode === 'merge' && !columns.some(column => column.isKey)) {
      throw new Error('Upsert (MERGE) requires at least one key column.');
    }
    return { mode: value.mode as ImportMode, database: (value.database as string).trim(), schema: (value.schema as string).trim() || this.state.defaults.schema, table, batchSize, columns };
  }

  private async run(value: unknown, sourceRevision: unknown, sampleRevision: unknown): Promise<void> {
    if (!this.connection || this.state.operation === 'connecting') throw new Error('Pick a SQL Server connection first.');
    if (!this.state.inferred || !this.state.sampleRevision || this.state.operation === 'sampling' ||
      sourceRevision !== this.state.sourceRevision || sampleRevision !== this.state.sampleRevision) {
      throw new Error('Sample the current CSV before running the import.');
    }
    const payload = this.validatePayload(value);
    const connection = this.connection;
    const info = { ...connection.info, database: payload.database || connection.info.database };
    const snapshot = {
      csvPath: this.state.csvPath,
      database: info.database || undefined,
      mode: payload.mode,
      target: { schema: payload.schema, name: payload.table },
      columns: payload.columns,
      batchSize: payload.batchSize,
      delimiter: this.state.delimiter,
    };
    const cancellation = new vscode.CancellationTokenSource();
    this.importCancellation = cancellation;
    this.state.operation = 'importing';
    this.postState();
    try {
      if (payload.mode === 'truncateLoad') {
        const action = 'Truncate and load';
        const confirmed = await vscode.window.showWarningMessage(
          `Replace every row in ${info.server} / ${snapshot.database || '(connection default)'} / ${payload.schema}.${payload.table}?`,
          { modal: true, detail: 'The existing rows will be removed when this import commits.' },
          action,
        );
        if (confirmed !== action || cancellation.token.isCancellationRequested) return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Importing ${path.basename(snapshot.csvPath)}`, cancellable: true },
        async (progress, token) => {
          const registration = token.onCancellationRequested(() => cancellation.cancel());
          if (token.isCancellationRequested) cancellation.cancel();
          try {
            if (cancellation.token.isCancellationRequested) throw new vscode.CancellationError();
            const driverConfig = await buildDriverConfig(connection.api, info);
            if (cancellation.token.isCancellationRequested) throw new vscode.CancellationError();
            const result = await runImport({ ...snapshot, driverConfig }, progress, cancellation.token);
            // A successful return means the transaction committed; late cancellation must not hide that result.
            if (!this.disposed) {
              void vscode.window.showInformationMessage(`Imported ${result.rowsLoaded.toLocaleString()} rows into ${payload.schema}.${payload.table}.`);
              void this.panel.webview.postMessage({ type: 'done', rowsLoaded: result.rowsLoaded });
            }
          } finally {
            registration.dispose();
          }
        },
      );
    } catch (error) {
      if (isCancelled(error)) {
        if (!this.disposed) void this.panel.webview.postMessage({ type: 'cancelled' });
      } else {
        throw error;
      }
    } finally {
      cancellation.dispose();
      if (this.importCancellation === cancellation) this.importCancellation = undefined;
      this.state.operation = 'idle';
      this.postState();
    }
  }

  private html(): string {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const scriptUri = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'wizard.js'))
      .toString();
    const styleUri = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'wizard.css'))
      .toString();
    const nonce = Math.random().toString(36).slice(2);
    const csp = [
      `default-src 'none'`,
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${this.panel.webview.cspSource} data:`,
      `font-src ${this.panel.webview.cspSource}`,
    ].join('; ');
    const htmlPath = path.join(
      this.context.extensionPath,
      'media',
      'wizard.html',
    );
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html
      .replace(/%%CSP%%/g, csp)
      .replace(/%%NONCE%%/g, nonce)
      .replace(/%%SCRIPT%%/g, scriptUri)
      .replace(/%%STYLE%%/g, styleUri);
    return html;
  }
}
