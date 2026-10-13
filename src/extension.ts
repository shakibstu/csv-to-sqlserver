import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  // Lazy-load the wizard so that a failure to require() its transitive deps
  // (e.g. the mssql driver) doesn't kill activation outright. The command
  // itself is ALWAYS registered; any startup errors are surfaced in the UI
  // when a command is invoked.
  // eslint-disable-next-line no-console
  console.log('[csv-to-sqlserver] activating');

  const openWizard = async (uri: vscode.Uri) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { WizardPanel } = require('./wizard/wizardPanel') as typeof import('./wizard/wizardPanel');
      WizardPanel.show(context, uri);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[csv-to-sqlserver] failed to open wizard:', err);
      vscode.window.showErrorMessage(
        `CSV to SQL Server: failed to open wizard — ${msg}`,
      );
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('csvToSqlServer.importCsv', async () => {
      const picks = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'CSV files': ['csv'], 'All files': ['*'] },
        openLabel: 'Import CSV',
      });
      if (!picks || picks.length === 0) return;
      await openWizard(picks[0]);
    }),
    vscode.commands.registerCommand(
      'csvToSqlServer.importCsvFromExplorer',
      async (uri?: vscode.Uri) => {
        if (!uri) {
          await vscode.commands.executeCommand('csvToSqlServer.importCsv');
          return;
        }
        await openWizard(uri);
      },
    ),
  );

  // eslint-disable-next-line no-console
  console.log('[csv-to-sqlserver] commands registered');
}

export function deactivate(): void {
  /* no-op */
}
