import * as vscode from 'vscode';
import * as sql from 'mssql';
import type { config as MssqlConfig } from 'mssql';

/** Supported fields in mssql.connections and this importer's ephemeral connections. */
export interface ConnectionInfo {
  server?: string;
  profileName?: string;
  database?: string;
  user?: string;
  password?: string;
  emptyPasswordInput?: boolean;
  port?: number;
  authenticationType?: string;
  encrypt?: boolean | string;
  trustServerCertificate?: boolean;
  hostNameInCertificate?: string;
  applicationName?: string;
  connectTimeout?: number;
  commandTimeout?: number;
  connectionString?: string;
  domain?: string;
  accountId?: string;
  tenantId?: string;
  email?: string;
  azureAccount?: string;
  azureTenantId?: string;
  azureAccountToken?: string;
  clientId?: string;
  clientSecret?: string;
  managedIdentityType?: 'vm' | 'app-service';
}

const MSSQL_EXTENSION_ID = 'ms-mssql.mssql';

/** Extension exports are version dependent; connection selection does not use them. */
export async function getMssqlApi(): Promise<unknown> {
  const extension = vscode.extensions.getExtension(MSSQL_EXTENSION_ID);
  if (!extension) {
    throw new Error(`The SQL Server (mssql) extension (${MSSQL_EXTENSION_ID}) is required.`);
  }
  return extension.isActive ? extension.exports : await extension.activate();
}

/** Compatibility wrapper for the wizard. No private mssql API is called. */
export async function promptForConnection(_api?: unknown, token?: vscode.CancellationToken): Promise<ConnectionInfo | undefined> {
  return pickConnectionInfo(token);
}

function authMode(value = 'SqlLogin'): 'sql' | 'ntlm' | 'interactive' | 'managed' | 'principal' {
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  if (['sql', 'sqllogin', 'sqlpassword'].includes(normalized)) return 'sql';
  if (['integrated', 'windows', 'ntlm'].includes(normalized)) return 'ntlm';
  if (['azuremfa', 'azureactivedirectoryinteractive', 'azureactivedirectoryuniversal', 'activedirectoryinteractive', 'activedirectoryuniversalwithmfasupport'].includes(normalized)) return 'interactive';
  if (['azuremanagedidentity', 'azuremi', 'activedirectorymanagedidentity', 'activedirectorymsi', 'azureactivedirectorymsivm', 'azureactivedirectorymsiappservice'].includes(normalized)) return 'managed';
  if (['azureserviceprincipal', 'activedirectoryserviceprincipal', 'azureactivedirectoryserviceprincipalsecret'].includes(normalized)) return 'principal';
  throw new Error(`Unsupported authentication type "${value}". Choose SQL Login, explicit NTLM credentials, Azure MFA, managed identity, or a service principal.`);
}

async function input(prompt: string, value?: string, password = false, optional = false, token?: vscode.CancellationToken): Promise<string | undefined> {
  if (token?.isCancellationRequested) return undefined;
  const entered = await vscode.window.showInputBox({
    prompt, value: password ? undefined : value, password, ignoreFocusOut: true,
    validateInput: optional ? undefined : text => text.trim() ? undefined : 'A value is required.',
  }, token);
  return token?.isCancellationRequested ? undefined : entered;
}

/** Read saved settings only. Secrets entered here stay in this connection object. */
export async function pickConnectionInfo(token?: vscode.CancellationToken): Promise<ConnectionInfo | undefined> {
  if (token?.isCancellationRequested) return undefined;
  const ask = (prompt: string, value?: string, password = false, optional = false) => input(prompt, value, password, optional, token);
  const saved = vscode.workspace.getConfiguration('mssql').get<ConnectionInfo[]>('connections', []);
  const choices = saved.filter(profile => profile && (profile.server || profile.connectionString)).map(profile => ({
    label: profile.profileName || profile.server || 'Saved connection',
    description: profile.authenticationType || 'SQL Login',
    detail: profile.database,
    profile,
  }));
  const selected = await vscode.window.showQuickPick([
    ...choices,
    { label: 'New connection...', description: 'Use a connection for this import', profile: undefined },
  ], { title: 'SQL Server connection', ignoreFocusOut: true }, token);
  if (!selected || token?.isCancellationRequested) return undefined;

  let info: ConnectionInfo;
  if (selected.profile) {
    info = expandConnectionInfo({ ...selected.profile });
  } else {
    const server = await ask('SQL Server (host, host,port, or host\\instance)');
    if (server === undefined) return undefined;
    normalizeServer(server);
    const method = await vscode.window.showQuickPick([
      { label: 'SQL Login', value: 'SqlLogin' },
      { label: 'Windows / NTLM (explicit credentials)', value: 'Integrated' },
      { label: 'Azure MFA / interactive', value: 'AzureMFA' },
      { label: 'Azure managed identity (Azure-hosted environments)', value: 'AzureManagedIdentity' },
      { label: 'Azure service principal', value: 'ActiveDirectoryServicePrincipal' },
    ], { title: 'Authentication method', ignoreFocusOut: true }, token);
    if (!method || token?.isCancellationRequested) return undefined;
    const database = await ask('Database (optional)', undefined, false, true);
    if (database === undefined) return undefined;
    info = { server, authenticationType: method.value, database: database || undefined, encrypt: true, trustServerCertificate: false };
  }

  const mode = authMode(info.authenticationType);
  if (mode === 'sql' || mode === 'ntlm') {
    if (!info.user) {
      info.user = await ask(mode === 'ntlm' ? 'NTLM user (DOMAIN\\username)' : 'SQL login');
      if (info.user === undefined) return undefined;
    }
    if (mode === 'ntlm' && !info.domain && !info.user.includes('\\')) {
      info.domain = await ask('NTLM domain');
      if (info.domain === undefined) return undefined;
    }
    const explicitBlankPassword = info.connectionString && sql.ConnectionPool.parseConnectionString(info.connectionString).password === '';
    if (!info.password && !info.emptyPasswordInput && !explicitBlankPassword) {
      info.password = await ask(mode === 'ntlm' ? 'NTLM password' : 'SQL login password (used only for this import)', undefined, true, true);
      if (info.password === undefined) return undefined;
    }
    if (info.emptyPasswordInput && info.password === undefined) info.password = '';
  } else if (mode === 'principal') {
    if (!(info.clientId || info.user)) {
      info.clientId = await ask('Service principal application (client) ID');
      if (info.clientId === undefined) return undefined;
    }
    if (!(info.clientSecret || info.password)) {
      info.clientSecret = await ask('Service principal client secret', undefined, true);
      if (info.clientSecret === undefined) return undefined;
    }
  } else if (mode === 'managed' && !info.clientId && !info.user) {
    info.clientId = await ask('Managed identity client ID (empty for system-assigned)', undefined, false, true);
    if (info.clientId === undefined) return undefined;
  }

  if (mode === 'principal' || mode === 'interactive') {
    if (!info.tenantId) {
      info.tenantId = await ask('Azure directory (tenant) ID for this connection');
      if (info.tenantId === undefined) return undefined;
    }
  }
  if (mode === 'interactive' && !info.accountId && !(info.email || info.user)) {
    const accounts = await vscode.authentication.getAccounts('microsoft');
    if (token?.isCancellationRequested) return undefined;
    const account = await vscode.window.showQuickPick([
      ...accounts.map(value => ({ label: value.label, value })),
      { label: 'Sign in with another Microsoft account...', value: undefined },
    ], { title: 'Microsoft account for Azure SQL', ignoreFocusOut: true }, token);
    if (!account || token?.isCancellationRequested) return undefined;
    if (account.value) {
      info.accountId = account.value.id;
      info.email = account.value.label;
    } else {
      info.email = await ask('Microsoft account email for Azure SQL');
      if (info.email === undefined) return undefined;
    }
  }
  return info;
}

function validPort(value: unknown): number {
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error('SQL Server port must be an integer between 1 and 65535.');
  }
  return number;
}

export function normalizeServer(server: string): { host: string; port?: number; instanceName?: string } {
  let host = (server || '').trim().replace(/^tcp:/i, '');
  if (/^(np|lpc):/i.test(host)) throw new Error('Only TCP SQL Server connections are supported.');
  let port: number | undefined;
  const comma = host.lastIndexOf(',');
  if (comma !== -1) {
    port = validPort(host.slice(comma + 1));
    host = host.slice(0, comma).trim();
  }
  let instanceName: string | undefined;
  const slash = host.indexOf('\\');
  if (slash !== -1) {
    instanceName = host.slice(slash + 1).trim();
    host = host.slice(0, slash).trim();
    if (!instanceName || instanceName.includes('\\')) throw new Error('SQL Server instance name is invalid.');
  }
  if (['.', '(local)', 'local', '(.)'].includes(host.toLowerCase())) host = 'localhost';
  if (!host) throw new Error('A SQL Server host is required.');
  return { host, port, instanceName };
}

/** Metadata that the driver's parser omits/coerces. The driver parses credentials. */
function connectionStringFields(value: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /(?:^|;)\s*([^=;]+)\s*=\s*("(?:[^"]|"")*"|'(?:[^']|'')*'|\{(?:[^}]|}})*\}|[^;]*)/g;
  for (const match of value.matchAll(pattern)) {
    const quoted = match[2].trim();
    const delimiter = quoted[0];
    const decoded = (delimiter === '"' || delimiter === "'") && quoted.endsWith(delimiter)
      ? quoted.slice(1, -1).split(delimiter + delimiter).join(delimiter)
      : delimiter === '{' && quoted.endsWith('}') ? quoted.slice(1, -1).replace(/}}/g, '}') : quoted;
    fields[match[1].trim().toLowerCase().replace(/\s/g, '')] = decoded;
  }
  return fields;
}

function expandConnectionInfo(info: ConnectionInfo): ConnectionInfo {
  if (!info.connectionString) return { ...info, accountId: info.accountId || info.azureAccount, tenantId: info.tenantId || info.azureTenantId };
  const parsed = sql.ConnectionPool.parseConnectionString(info.connectionString) as MssqlConfig & { domain?: string; clientId?: string; clientSecret?: string; tenantId?: string; authentication_type?: string };
  const fields = connectionStringFields(info.connectionString);
  const source = fields.server ?? fields.datasource ?? fields.address ?? fields.addr ?? fields.networkaddress;
  let authenticationType = fields.authentication;
  if (/^active directory integrated$/i.test(authenticationType || '') && parsed.authentication_type && parsed.authentication_type !== 'azure-active-directory-default') {
    authenticationType = parsed.authentication_type;
  }
  if (!authenticationType && /^(true|yes|sspi)$/i.test(fields.integratedsecurity || fields.trustedconnection || '')) authenticationType = 'Integrated';
  if (!authenticationType && parsed.domain) authenticationType = 'NTLM';
  return {
    ...info,
    server: source || parsed.server || info.server,
    database: info.database ?? parsed.database,
    user: parsed.user ?? info.user,
    password: parsed.password ?? info.password,
    domain: parsed.domain ?? info.domain,
    authenticationType: authenticationType || info.authenticationType || 'SqlLogin',
    encrypt: fields.encrypt ?? info.encrypt ?? parsed.options?.encrypt,
    trustServerCertificate: parsed.options?.trustServerCertificate ?? info.trustServerCertificate,
    hostNameInCertificate: fields.hostnameincertificate ?? info.hostNameInCertificate,
    applicationName: fields.applicationname ?? info.applicationName,
    connectTimeout: parsed.connectionTimeout === undefined ? info.connectTimeout : parsed.connectionTimeout / 1000,
    commandTimeout: parsed.requestTimeout === undefined ? info.commandTimeout : parsed.requestTimeout / 1000,
    accountId: info.accountId || info.azureAccount,
    tenantId: parsed.tenantId || info.tenantId || info.azureTenantId,
    clientId: parsed.clientId || info.clientId,
    clientSecret: parsed.clientSecret || info.clientSecret,
  };
}

function encryptOption(value: boolean | string | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (['optional', 'false', 'no'].includes(normalized)) return false;
  if (['mandatory', 'true', 'yes'].includes(normalized)) return true;
  if (normalized === 'strict') throw new Error('Strict encryption is not supported by this importer; choose Mandatory or Optional explicitly.');
  throw new Error(`Unsupported encryption setting "${value}".`);
}

export function buildDriverConfig(info: ConnectionInfo): Promise<MssqlConfig>;
export function buildDriverConfig(api: unknown, info: ConnectionInfo): Promise<MssqlConfig>;
export async function buildDriverConfig(apiOrInfo: unknown, suppliedInfo?: ConnectionInfo): Promise<MssqlConfig> {
  const info = expandConnectionInfo(suppliedInfo ?? apiOrInfo as ConnectionInfo);
  const parsed = info.connectionString ? sql.ConnectionPool.parseConnectionString(info.connectionString) : {} as MssqlConfig;
  const address = normalizeServer(info.server || '');
  const profilePort = info.port === undefined ? undefined : validPort(info.port);
  const port = address.port ?? profilePort;
  const config: MssqlConfig = {
    ...parsed,
    server: address.host,
    database: info.database,
    ...(port === undefined ? {} : { port }),
    options: {
      ...parsed.options,
      encrypt: encryptOption(info.encrypt),
      trustServerCertificate: info.trustServerCertificate ?? false,
      appName: info.applicationName || 'csvToSqlServer',
      ...(port === undefined && address.instanceName ? { instanceName: address.instanceName } : {}),
      ...(info.hostNameInCertificate ? { serverName: info.hostNameInCertificate } : {}),
    },
    connectionTimeout: (info.connectTimeout ?? 30) * 1000,
    requestTimeout: (info.commandTimeout ?? 300) * 1000,
  };
  // Parsed flat credentials must not enable another driver's authentication branch.
  for (const key of ['user', 'password', 'domain', 'clientId', 'clientSecret', 'tenantId', 'token', 'msiEndpoint', 'msiSecret', 'authentication_type', 'authentication']) {
    delete (config as unknown as Record<string, unknown>)[key];
  }
  if (port === undefined) delete config.port;
  if (port !== undefined || !address.instanceName) delete config.options!.instanceName;
  const mode = authMode(info.authenticationType);
  if (mode === 'sql') {
    if (!info.user || info.password === undefined) throw new Error('SQL Login requires a user and password. Select the connection again to enter credentials.');
    config.user = info.user;
    config.password = info.password;
  } else if (mode === 'ntlm') {
    const separator = info.user?.indexOf('\\') ?? -1;
    const domain = info.domain || (separator >= 0 ? info.user!.slice(0, separator) : undefined);
    const userName = separator >= 0 ? info.user!.slice(separator + 1) : info.user;
    if (!domain || !userName || !info.password) throw new Error('NTLM requires explicit domain, user and password; automatic Windows integrated authentication is unavailable.');
    config.authentication = { type: 'ntlm', options: { domain, userName, password: info.password } };
  } else if (mode === 'principal') {
    const clientId = info.clientId || info.user;
    const clientSecret = info.clientSecret || info.password;
    if (!clientId || !clientSecret || !info.tenantId) throw new Error('Service principal authentication requires client ID, client secret and tenant ID.');
    config.authentication = { type: 'azure-active-directory-service-principal-secret', options: { clientId, clientSecret, tenantId: info.tenantId } };
  } else if (mode === 'managed') {
    const type = info.managedIdentityType === 'app-service' || /app.?service/i.test(info.authenticationType || '')
      ? 'azure-active-directory-msi-app-service' : 'azure-active-directory-msi-vm';
    const clientId = info.clientId || info.user;
    config.authentication = { type, options: clientId ? { clientId } : {} };
  } else {
    // Always ask the provider again. An earlier database lookup may precede a long wizard delay.
    config.authentication = { type: 'azure-active-directory-access-token', options: { token: await resolveInteractiveToken(info) } };
  }
  return config;
}

function tokenClaims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('Microsoft sign-in returned an invalid Azure SQL token.');
  }
}

async function resolveInteractiveToken(info: ConnectionInfo): Promise<string> {
  if (!info.tenantId) throw new Error('Azure MFA requires an explicit tenant ID. Select the connection again to enter it.');
  const email = info.email || info.user;
  if (!info.accountId && !email) throw new Error('Azure MFA requires a selected Microsoft account. Select the connection again.');
  const accounts = await vscode.authentication.getAccounts('microsoft');
  const account = info.accountId
    ? accounts.find(value => value.id === info.accountId)
    : email ? accounts.find(value => value.label.toLowerCase() === email.toLowerCase()) : undefined;
  if (info.accountId && !account) throw new Error('The saved Microsoft account is unavailable. Use New connection to select the intended Microsoft account again.');
  const scopes = ['https://database.windows.net/.default', `VSCODE_TENANT:${info.tenantId}`];
  let session = account ? await vscode.authentication.getSession('microsoft', scopes, { silent: true, account }) : undefined;
  if (!session) {
    session = account
      ? await vscode.authentication.getSession('microsoft', scopes, { createIfNone: true, account })
      : await vscode.authentication.getSession('microsoft', scopes, { forceNewSession: true });
  }
  if (!session?.accessToken) throw new Error('Microsoft sign-in did not return an Azure SQL session.');
  if (account && session.account.id !== account.id) throw new Error('Microsoft sign-in returned a different account than the selected account.');
  const claims = tokenClaims(session.accessToken);
  const audience = claims.aud;
  if (audience !== 'https://database.windows.net/' && audience !== 'https://database.windows.net' && audience !== '022907d3-0f1b-48f7-badc-1ba6abab6d66') {
    throw new Error('Microsoft sign-in returned a token for a different resource than Azure SQL.');
  }
  if (typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000 + 120) throw new Error('The Azure SQL token has expired or will expire shortly. Sign in again.');
  if (typeof claims.tid !== 'string' || claims.tid.toLowerCase() !== info.tenantId.toLowerCase()) throw new Error('Microsoft sign-in returned a different tenant than the connection tenant. Use the directory tenant ID.');
  if (email) {
    const tokenEmail = claims.preferred_username ?? claims.upn ?? claims.unique_name;
    if (typeof tokenEmail !== 'string' || tokenEmail.toLowerCase() !== email.toLowerCase()) throw new Error('Microsoft sign-in returned a different account email than the connection account.');
  }
  return session.accessToken;
}

export async function fetchDatabasesWithConfig(config: MssqlConfig): Promise<string[]> {
  const probeConfig = { ...config, database: config.database || 'master' };
  const pool = new sql.ConnectionPool(probeConfig);
  try {
    await pool.connect();
    try {
      const result = await pool.request().query<{ name: string }>(
        `SELECT name FROM sys.databases
         WHERE state_desc = 'ONLINE' AND (database_id > 4 OR database_id = 1)
         ORDER BY name`,
      );
      const names = (result.recordset || []).map(row => row.name).filter((name): name is string => typeof name === 'string');
      return names.length ? names : [probeConfig.database];
    } catch {
      // Contained Azure SQL users can connect to their DB without permission to list others.
      return [probeConfig.database];
    }
  } finally {
    try { await pool.close(); } catch { /* Preserve a failed connection/query over cleanup. */ }
  }
}
