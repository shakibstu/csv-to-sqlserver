const assert = require('node:assert/strict');
const { test } = require('node:test');
const realSql = require('mssql');
const { loadSource } = require('./helpers.cjs');

function jwt(claims = {}) {
  return `header.${Buffer.from(JSON.stringify({ aud: 'https://database.windows.net/', exp: Math.floor(Date.now() / 1000) + 3600, tid: 'tenant', preferred_username: 'user@example.com', ...claims })).toString('base64url')}.signature`;
}

function subject({ profiles = [], picks = [], inputs = [], authentication = {}, sql = realSql, extension = { connectionSharing: {}, uriOwnershipApi: {} } } = {}) {
  const prompts = [];
  const vscode = {
    extensions: { getExtension: () => ({ isActive: false, activate: async () => extension, exports: extension }) },
    workspace: { getConfiguration: (name) => { assert.equal(name, 'mssql'); return { get: () => profiles }; } },
    window: {
      showQuickPick: async (items, options) => { prompts.push({ items, options }); const next = picks.shift(); return typeof next === 'function' ? next(items) : next; },
      showInputBox: async (options) => { prompts.push({ options }); return inputs.shift(); },
    },
    authentication: { getAccounts: async () => [{ id: 'account', label: 'user@example.com' }], ...authentication },
  };
  return { ...loadSource('src/mssql.ts', { vscode, mssql: sql }), prompts };
}

test('current mssql extension exports can select a saved SQL profile and prompt privately without storing its password', async () => {
  const profile = { profileName: 'Local', server: 'localhost', user: 'sa', authenticationType: 'SqlLogin' };
  const api = subject({ profiles: [profile], picks: [items => items.find(item => item.label === 'Local')], inputs: ['secret;password'] });
  const exports = await api.getMssqlApi();
  const info = await api.promptForConnection(exports);
  const config = await api.buildDriverConfig(exports, info);
  assert.equal(config.user, 'sa');
  assert.equal(config.password, 'secret;password');
  assert.equal(profile.password, undefined);
  assert.equal(api.prompts.find(prompt => prompt.options.password).options.password, true);
});

test('connection selection exposes a new connection option and supports cancellation', async () => {
  const api = subject({ picks: [items => { assert.ok(items.some(item => /new connection/i.test(item.label))); return undefined; }] });
  assert.equal(await api.promptForConnection({}), undefined);
});

test('full connection strings preserve quoted semicolon credentials and certificate settings', async () => {
  const api = subject();
  const config = await api.buildDriverConfig({}, { connectionString: 'Server=tcp:sqlhost\\INSTANCE,1500;Database=demo;User ID=sa;Password="a;b";Encrypt=Optional;TrustServerCertificate=true;HostNameInCertificate=cert.example.com' });
  assert.equal(config.server, 'sqlhost');
  assert.equal(config.port, 1500);
  assert.equal(config.options.instanceName, undefined);
  assert.equal(config.database, 'demo');
  assert.equal(config.password, 'a;b');
  assert.equal(config.options.encrypt, false);
  assert.equal(config.options.serverName, 'cert.example.com');
});

test('server addresses normalize tcp and explicit ports override named instances', async () => {
  const api = subject();
  const config = await api.buildDriverConfig({}, { server: 'tcp:host\\INSTANCE,1444', authenticationType: 'SqlLogin', user: 'sa', password: 'pw', encrypt: 'Mandatory' });
  assert.equal(config.server, 'host');
  assert.equal(config.port, 1444);
  assert.equal(config.options.instanceName, undefined);
  assert.equal(config.options.encrypt, true);
  for (const server of ['host,0', 'host,65536', 'host,NaN', 'host,1.2', 'host,1433junk']) {
    assert.throws(() => api.normalizeServer(server), /port/i);
  }
  await assert.rejects(api.buildDriverConfig({}, { server: 'host', port: 0, user: 'sa', password: 'pw' }), /port/i);
});

test('Strict encryption is rejected explicitly rather than weakened to Mandatory', async () => {
  await assert.rejects(subject().buildDriverConfig({}, { server: 'host', user: 'sa', password: 'pw', encrypt: 'Strict' }), /Strict.*not supported/i);
});

test('managed identity and service principal retain their own credential modes', async () => {
  const api = subject({ authentication: { getSession: () => assert.fail('user session requested for a machine identity') } });
  const managed = await api.buildDriverConfig({}, { server: 'host', authenticationType: 'AzureManagedIdentity', clientId: 'identity' });
  assert.deepEqual(managed.authentication, { type: 'azure-active-directory-msi-vm', options: { clientId: 'identity' } });
  const principal = await api.buildDriverConfig({}, { server: 'host', authenticationType: 'ActiveDirectoryServicePrincipal', user: 'client', password: 'secret', tenantId: 'tenant' });
  assert.deepEqual(principal.authentication, { type: 'azure-active-directory-service-principal-secret', options: { clientId: 'client', clientSecret: 'secret', tenantId: 'tenant' } });
  assert.equal(principal.user, undefined);
});

test('integrated auth never fabricates operating-system credentials and requires explicit NTLM credentials', async () => {
  const api = subject();
  await assert.rejects(api.buildDriverConfig({}, { server: 'host', authenticationType: 'Integrated' }), /NTLM.*domain.*user.*password/i);
  const config = await api.buildDriverConfig({}, { server: 'host', authenticationType: 'Integrated', user: 'DOMAIN\\user', password: 'secret' });
  assert.deepEqual(config.authentication, { type: 'ntlm', options: { domain: 'DOMAIN', userName: 'user', password: 'secret' } });
  await assert.rejects(api.buildDriverConfig({}, { connectionString: 'Server=host;Integrated Security=true' }), /NTLM/i);
});

test('unsupported Azure auth cannot substitute an interactive user login', async () => {
  const api = subject({ authentication: { getSession: () => assert.fail('unsupported auth reached user login') } });
  for (const authenticationType of ['ActiveDirectoryDefault', 'AzureActiveDirectoryPassword', 'AzureActiveDirectoryIntegrated', 'SomethingUnknown']) {
    await assert.rejects(api.buildDriverConfig({}, { server: 'host', authenticationType }), /Unsupported authentication/i);
  }
  await assert.rejects(api.buildDriverConfig({}, { connectionString: 'Server=host;Authentication=Active Directory Default' }), /Unsupported authentication/i);
});

test('interactive Azure tokens use SQL scope and selected account and tenant, refreshed on each config build', async () => {
  let calls = 0;
  const api = subject({ authentication: { getSession: async (provider, scopes, options) => {
    assert.equal(provider, 'microsoft');
    assert.deepEqual(scopes, ['https://database.windows.net/.default', 'VSCODE_TENANT:tenant']);
    assert.equal(options.account.id, 'account');
    return { id: 'session', account: { id: 'account', label: 'user@example.com' }, scopes, accessToken: jwt({ nonce: ++calls }) };
  } } });
  const info = { server: 'host', authenticationType: 'AzureMFA', accountId: 'account', tenantId: 'tenant', azureAccountToken: jwt({ nonce: 'stale attached token' }) };
  const first = await api.buildDriverConfig({}, info);
  const second = await api.buildDriverConfig({}, info);
  assert.notEqual(first.authentication.options.token, second.authentication.options.token);
  assert.equal(calls, 2);
});

test('interactive Azure auth refuses a different account or tenant without falling back', async () => {
  for (const mismatch of [ { account: { id: 'another', label: 'other@example.com' } }, { token: jwt({ tid: 'another-tenant' }) }, { token: jwt({ aud: 'https://management.azure.com/' }) } ]) {
    const api = subject({ authentication: { getSession: async () => ({ account: mismatch.account || { id: 'account', label: 'user@example.com' }, accessToken: mismatch.token || jwt() }) } });
    await assert.rejects(api.buildDriverConfig({}, { server: 'host', authenticationType: 'AzureMFA', accountId: 'account', tenantId: 'tenant' }), /account|tenant|SQL/i);
  }
  const api = subject({ authentication: { getAccounts: async () => [{ id: 'different', label: 'other@example.com' }], getSession: () => assert.fail('unmatched saved account should fail') } });
  await assert.rejects(api.buildDriverConfig({}, { server: 'host', authenticationType: 'AzureMFA', accountId: 'missing', tenantId: 'tenant' }), /account/i);
});

test('database probing closes the pool and preserves the original connect error even when cleanup fails', async () => {
  let closed = false;
  const failure = new Error('login failed');
  class ConnectionPool { async connect() { throw failure; } async close() { closed = true; throw new Error('close failed'); } }
  const api = subject({ sql: { ConnectionPool } });
  await assert.rejects(api.fetchDatabasesWithConfig({ server: 'host' }), error => error === failure);
  assert.equal(closed, true);
});

test('new connections collect explicit credentials and do not persist configuration', async () => {
  const api = subject({ picks: [items => items.find(item => /new connection/i.test(item.label)), items => items.find(item => item.value === 'SqlLogin')], inputs: ['tcp:host,1444', 'demo', 'sa', 'pw'] });
  const info = await api.pickConnectionInfo();
  const config = await api.buildDriverConfig(info);
  assert.equal(config.server, 'host');
  assert.equal(config.port, 1444);
  assert.equal(config.database, 'demo');
  assert.equal(config.password, 'pw');
});

test('connection strings retain parsed pool and transport options without interpreting quoted passwords as options', async () => {
  const api = subject();
  const config = await api.buildDriverConfig({ connectionString: 'Server=host;User ID=sa;Password={a;Encrypt=Optional};Min Pool Size=2;Max Pool Size=3;Packet Size=8192;Encrypt=Mandatory' });
  assert.equal(config.password, 'a;Encrypt=Optional');
  assert.equal(config.options.encrypt, true);
  assert.equal(config.options.packetSize, 8192);
  assert.deepEqual(config.pool, { min: 2, max: 3 });
});

test('full connection strings with explicit service-principal credentials use the driver credential mode', async () => {
  const config = await subject().buildDriverConfig({ connectionString: 'Server=host;Authentication=Active Directory Integrated;Client ID=client;Client Secret=secret;Tenant ID=tenant' });
  assert.deepEqual(config.authentication, { type: 'azure-active-directory-service-principal-secret', options: { clientId: 'client', clientSecret: 'secret', tenantId: 'tenant' } });
});

test('profile port validation is not bypassed by a second port in the server name', async () => {
  await assert.rejects(subject().buildDriverConfig({ server: 'host,1444', port: 0, user: 'sa', password: 'pw' }), /port/i);
});

test('explicit authentication and encryption in a full connection string cannot be overridden by saved-profile defaults', async () => {
  const config = await subject().buildDriverConfig({ server: 'wrong-host', authenticationType: 'SqlLogin', encrypt: true, user: 'wrong-client', password: 'wrong-secret', connectionString: 'Server=correct-host;Authentication=Active Directory Service Principal;User ID=client;Password=secret;Tenant ID=tenant;Encrypt=Optional' });
  assert.equal(config.server, 'correct-host');
  assert.equal(config.options.encrypt, false);
  assert.deepEqual(config.authentication, { type: 'azure-active-directory-service-principal-secret', options: { clientId: 'client', clientSecret: 'secret', tenantId: 'tenant' } });
});

test('braced connection-string values decode server and metadata without leaking password fragments', async () => {
  const config = await subject().buildDriverConfig({ connectionString: 'Server={tcp:host,1444};User ID=sa;Password={pw;Encrypt=Optional;Authentication=Active Directory Default}' });
  assert.equal(config.server, 'host');
  assert.equal(config.port, 1444);
  assert.equal(config.password, 'pw;Encrypt=Optional;Authentication=Active Directory Default');
  assert.equal(config.options.encrypt, true);
});

test('empty saved SQL password placeholders still prompt unless the profile intentionally uses a blank password', async () => {
  const saved = { profileName: 'Saved', server: 'host', user: 'sa', password: '' };
  const api = subject({ profiles: [saved], picks: [items => items[0]], inputs: ['entered-secret'] });
  const info = await api.pickConnectionInfo();
  assert.equal(info.password, 'entered-secret');
  assert.equal(saved.password, '');
  const blank = subject({ profiles: [{ ...saved, emptyPasswordInput: true }], picks: [items => items[0]] });
  assert.equal((await blank.pickConnectionInfo()).password, '');
  assert.equal(blank.prompts.filter(prompt => prompt.options.password).length, 0);
});

test('requesting an unsigned-in Microsoft email opens a fresh session instead of reusing the preferred account', async () => {
  const api = subject({ authentication: { getSession: async (provider, scopes, options) => {
    assert.equal(options.forceNewSession, true);
    assert.equal(options.createIfNone, undefined);
    assert.equal(options.silent, undefined);
    return { account: { id: 'new-account', label: 'new@example.com' }, accessToken: jwt({ preferred_username: 'new@example.com' }) };
  } } });
  const config = await api.buildDriverConfig({ server: 'host', authenticationType: 'AzureMFA', email: 'new@example.com', tenantId: 'tenant' });
  assert.equal(config.authentication.type, 'azure-active-directory-access-token');
});

test('a missing explicit Microsoft account cannot fall back to another account with the profile email', async () => {
  const api = subject({ authentication: { getSession: async () => ({ account: { id: 'account', label: 'user@example.com' }, accessToken: jwt() }) } });
  await assert.rejects(api.buildDriverConfig({ server: 'host', authenticationType: 'AzureMFA', accountId: 'missing-account', email: 'user@example.com', tenantId: 'tenant' }), /account.*unavailable|account.*select/i);
});
