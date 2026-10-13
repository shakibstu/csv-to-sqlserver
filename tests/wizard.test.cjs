const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadSource } = require('./helpers.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const fixtureSample = () => ({ columns: [{ name: 'id', sqlType: 'BIGINT', nullable: false }], sampleRows: [{ id: '1' }] });
const fixtureConnection = () => ({ server: 'sql.example', database: 'app', authenticationType: 'SqlLogin', user: 'user', password: 'secret' });
const fixturePayload = () => ({ mode: 'create', database: 'app', schema: 'dbo', table: 'items', batchSize: 20, columns: [{ sourceName: 'id', targetName: 'itemId', sqlType: 'BIGINT', nullable: false, isKey: true }] });

function host(overrides = {}) {
  const messages = [], infos = [], warnings = [], requests = [], cleanups = [];
  let disposeCallback, messageCallback;
  const uri = (filePath) => ({ scheme: 'file', fsPath: filePath, toString: () => filePath });
  const panel = {
    reveal() {},
    onDidDispose(fn) { disposeCallback = fn; return { dispose() { cleanups.push('panel'); } }; },
    webview: {
      cspSource: 'vscode-resource:',
      postMessage(msg) { messages.push(structuredClone(msg)); return Promise.resolve(true); },
      onDidReceiveMessage(fn) { messageCallback = fn; return { dispose() { cleanups.push('message'); } }; },
      asWebviewUri(value) { return value; },
    },
  };
  class CancellationTokenSource {
    constructor() {
      const listeners = new Set();
      this.token = { isCancellationRequested: false, onCancellationRequested(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); cleanups.push('cancel-listener'); } }; } };
      this.cancel = () => { this.token.isCancellationRequested = true; listeners.forEach(fn => fn()); };
    }
    dispose() { cleanups.push('token'); }
  }
  const vscode = {
    Uri: { joinPath: (base, ...rest) => uri(path.join(base.fsPath, ...rest)) },
    ViewColumn: { Active: 1 }, ProgressLocation: { Notification: 15 },
    CancellationTokenSource,
    CancellationError: class CancellationError extends Error {},
    workspace: { getConfiguration: () => ({ get: (name, fallback) => overrides.defaults?.[name] ?? fallback }) },
    window: {
      createWebviewPanel: () => panel,
      showInformationMessage: (message) => { infos.push(message); return Promise.resolve(); },
      showWarningMessage: (message, options, ...actions) => { warnings.push({ message, options, actions }); return Promise.resolve(overrides.confirmation); },
      withProgress: overrides.withProgress || (async (_options, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested() { return { dispose() { cleanups.push('progress-cancel'); } }; } })),
    },
  };
  const mssql = {
    getMssqlApi: async () => ({}),
    promptForConnection: overrides.promptForConnection || (async () => fixtureConnection()),
    buildDriverConfig: overrides.buildDriverConfig || (async (_api, info) => ({ server: info.server, database: info.database, password: info.password })),
    fetchDatabasesWithConfig: async () => ['app', 'other'],
  };
  const { WizardPanel } = loadSource('src/wizard/wizardPanel.ts', {
    vscode,
    '../mssql': mssql,
    '../csv': { readHeaderAndSample: overrides.readHeaderAndSample || (async () => fixtureSample()) },
    '../importer': { runImport: overrides.runImport || (async req => { requests.push(req); return { rowsLoaded: 1 }; }) },
  });
  const context = { extensionUri: uri(path.resolve(__dirname, '..')), extensionPath: path.resolve(__dirname, '..'), subscriptions: [] };
  WizardPanel.show(context, uri('/tmp/first.csv'));
  const wizard = WizardPanel.current;
  const state = () => messages.filter(msg => msg.type === 'state').at(-1)?.state;
  const send = msg => wizard.onMessage(msg);
  const run = (payload = fixturePayload()) => send({ type: 'run', sourceRevision: state()?.sourceRevision, sampleRevision: state()?.sampleRevision, payload });
  return { wizard, WizardPanel, context, uri, messages, infos, warnings, requests, cleanups, state, send, run, receive: async (msg) => { messageCallback(msg); await new Promise(setImmediate); }, dispose: () => disposeCallback() };
}

// Omitting reset defaults or source revisions would let stale mappings/configuration survive a new CSV.
test('host reads configured defaults and uses configured sampling size', async () => {
  let sampleArgs;
  const h = host({ defaults: { defaultBatchSize: 37, inferSampleSize: 55, defaultSchema: 'imports' }, readHeaderAndSample: async (...args) => { sampleArgs = args; return fixtureSample(); } });
  await h.send({ type: 'ready' });
  assert.deepEqual(h.state().defaults, { batchSize: 37, sampleSize: 55, schema: 'imports' });
  await h.send({ type: 'sample' });
  assert.equal(sampleArgs[1], 55);
});

test('changing delimiter invalidates a sample and rejects a stale run', async () => {
  const h = host();
  await h.send({ type: 'pickConnection' });
  await h.send({ type: 'sample' });
  const before = h.state();
  await h.send({ type: 'setDelimiter', delimiter: ';' });
  assert.equal(h.state().inferred, undefined);
  assert.notEqual(h.state().sourceRevision, before.sourceRevision);
  await assert.rejects(h.send({ type: 'run', sourceRevision: before.sourceRevision, sampleRevision: before.sampleRevision, payload: fixturePayload() }), /sample/i);
  assert.equal(h.requests.length, 0);
});

test('cancelled connection picker clears the displayed and actual connection', async () => {
  let picks = 0;
  const h = host({ promptForConnection: async () => ++picks === 1 ? fixtureConnection() : undefined });
  await h.send({ type: 'pickConnection' });
  await h.send({ type: 'sample' });
  await h.send({ type: 'pickConnection' });
  assert.equal(h.state().connection, undefined);
  await assert.rejects(h.run(), /connection/i);
});

test('reset aborts sampling and ignores its late outcome', async () => {
  const sample = deferred();
  let signal;
  const h = host({ readHeaderAndSample: (_path, _size, _delimiter, abortSignal) => { signal = abortSignal?.signal; return sample.promise; } });
  const pending = h.send({ type: 'sample' });
  h.WizardPanel.show(h.context, h.uri('/tmp/second.csv'));
  sample.resolve(fixtureSample());
  await pending;
  assert.equal(h.state().csvPath, '/tmp/second.csv');
  assert.equal(h.state().inferred, undefined);
  assert.equal(signal?.aborted, true);
});

test('reset ignores an obsolete connection picker response', async () => {
  const pick = deferred();
  const h = host({ promptForConnection: () => pick.promise });
  const pending = h.send({ type: 'pickConnection' });
  await Promise.resolve();
  h.WizardPanel.show(h.context, h.uri('/tmp/second.csv'));
  pick.resolve(fixtureConnection());
  await pending;
  assert.equal(h.state().connection, undefined);
});

test('one active import locks source and connection while using a request snapshot', async () => {
  const progressReady = deferred(), continueProgress = deferred();
  const h = host({ withProgress: async (_options, callback) => { progressReady.resolve(); await continueProgress.promise; return callback({ report() {} }, { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } }); } });
  await h.send({ type: 'pickConnection' });
  await h.send({ type: 'sample' });
  const payload = fixturePayload();
  const active = h.run(payload);
  await progressReady.promise;
  const duplicate = h.run();
  await h.send({ type: 'setDelimiter', delimiter: ';' });
  await h.send({ type: 'pickConnection' });
  h.WizardPanel.show(h.context, h.uri('/tmp/second.csv'));
  payload.table = 'mutated';
  payload.columns[0].targetName = 'mutated';
  continueProgress.resolve();
  await Promise.all([active, duplicate]);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].csvPath, '/tmp/first.csv');
  assert.equal(h.requests[0].delimiter, ',');
  assert.equal(h.requests[0].target.name, 'items');
  assert.equal(h.requests[0].columns[0].targetName, 'itemId');
  assert.equal(h.state().operation, 'idle');
});

test('import refreshes credentials for the selected database without exposing credentials', async () => {
  let calls = 0;
  const h = host({ buildDriverConfig: async (_api, info) => ({ server: info.server, database: info.database, password: `fresh-${++calls}` }) });
  await h.send({ type: 'pickConnection' });
  await h.send({ type: 'sample' });
  await h.run({ ...fixturePayload(), database: 'other' });
  assert.equal(h.requests[0].driverConfig.password, 'fresh-2');
  assert.equal(h.requests[0].driverConfig.database, 'other');
  assert.doesNotMatch(JSON.stringify(h.messages), /fresh-|secret/);
});

test('malformed run payloads fail before importing', async () => {
  const h = host();
  await h.send({ type: 'pickConnection' });
  await h.send({ type: 'sample' });
  for (const patch of [{ mode: 'drop' }, { batchSize: 0 }, { batchSize: 1.5 }, { batchSize: '20' }, { table: 5 }, { columns: null }, { columns: [{ sourceName: 'missing', targetName: 'id', sqlType: 'BIGINT', nullable: false }] }]) {
    await assert.rejects(h.run({ ...fixturePayload(), ...patch }));
  }
  assert.equal(h.requests.length, 0);
});

test('truncate load requires a modal confirmation naming the actual target', async () => {
  const h = host();
  await h.send({ type: 'pickConnection' });
  await h.send({ type: 'sample' });
  await h.run({ ...fixturePayload(), mode: 'truncateLoad' });
  assert.equal(h.requests.length, 0);
  assert.equal(h.warnings[0].options.modal, true);
  assert.match(h.warnings[0].message, /sql\.example/);
  assert.match(h.warnings[0].message, /app/);
  assert.match(h.warnings[0].message, /dbo.*items/);
});

test('import cancellation emits cancelled without success or error and releases resources', async () => {
  const h = host({ runImport: async () => { const error = new Error('cancelled'); error.name = 'CancellationError'; throw error; }, withProgress: async (_options, callback) => callback({ report() {} }, { isCancellationRequested: true, onCancellationRequested() { return { dispose() {} }; } }) });
  await h.send({ type: 'pickConnection' });
  await h.send({ type: 'sample' });
  await h.run();
  assert.equal(h.infos.length, 0);
  assert.equal(h.messages.filter(msg => msg.type === 'done' || msg.type === 'error').length, 0);
  assert.ok(h.messages.some(msg => msg.type === 'cancelled'));
  assert.equal(h.state().operation, 'idle');
  assert.ok(h.cleanups.includes('token'));
});

test('dispose aborts outstanding sampling and disposes registered callbacks', async () => {
  const sample = deferred();
  let signal;
  const h = host({ readHeaderAndSample: (_path, _size, _delimiter, abortSignal) => { signal = abortSignal?.signal; return sample.promise; } });
  const pending = h.send({ type: 'sample' });
  h.dispose();
  const count = h.messages.length;
  sample.resolve(fixtureSample());
  await pending;
  assert.equal(signal?.aborted, true);
  assert.equal(h.messages.length, count);
  assert.ok(h.cleanups.includes('message'));
});

class Element {
  constructor(tagName = 'div') { this.tagName = tagName; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; this.className = ''; this.textContent = ''; this.classes = new Set(); this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) }; }
  set innerHTML(value) { this.children = []; this._innerHTML = value; }
  get innerHTML() { return this._innerHTML || ''; }
  get rows() { return this.children; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  emit(type) { if (!this.disabled) this.listeners[type]?.({ target: this }); }
  querySelector(selector) { const wanted = selector.slice(1); for (const child of this.children) { if (child.className === wanted) return child; const descendant = child.querySelector(selector); if (descendant) return descendant; } return null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector === 'input' && child.tagName === 'input' ? [child] : []), ...child.querySelectorAll(selector)]); }
}
function webview() {
  const ids = ['csvPath','delimiter','sampleBtn','pickConnBtn','connSummary','mappingSection','databaseSelect','databaseInput','mode','schema','table','batchSize','preview','runBtn','errors','status'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const body = new Element('tbody'), messages = [];
  let onMessage;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../media/wizard.js'), 'utf8'), {
    acquireVsCodeApi: () => ({ postMessage: msg => messages.push(structuredClone(msg)) }),
    document: { getElementById: id => elements[id], querySelector: () => body, createElement: tag => new Element(tag) },
    window: { addEventListener: (_event, fn) => { onMessage = fn; } },
    console,
  });
  return { elements, body, messages, state: state => onMessage({ data: { type: 'state', state } }) };
}
const viewState = () => ({ csvPath: '/tmp/first.csv', delimiter: ',', sourceRevision: 1, sampleRevision: 1, resetRevision: 1, operation: 'idle', defaults: { batchSize: 37, sampleSize: 55, schema: 'imports' }, connection: { server: 'sql.example', database: 'app', authenticationType: 'SqlLogin', databases: ['app'] }, inferred: fixtureSample() });

test('real webview preserves edited mappings and target controls on unrelated state renders', () => {
  const w = webview();
  const state = viewState();
  w.state(state);
  w.body.rows[0].querySelector('.colTarget').value = 'editedId';
  w.body.rows[0].querySelector('.colType').value = 'INT';
  w.body.rows[0].querySelector('.colKey').checked = true;
  w.elements.table.value = 'editedTable';
  w.state({ ...state, connecting: true });
  assert.equal(w.body.rows[0].querySelector('.colTarget').value, 'editedId');
  assert.equal(w.body.rows[0].querySelector('.colType').value, 'INT');
  assert.equal(w.body.rows[0].querySelector('.colKey').checked, true);
  assert.equal(w.elements.table.value, 'editedTable');
});

test('real webview resets controls and clears mappings for a new CSV', () => {
  const w = webview();
  w.state(viewState());
  w.elements.mode.value = 'merge';
  w.elements.delimiter.value = ';';
  w.elements.table.value = 'edited';
  w.elements.schema.value = 'edited';
  w.elements.batchSize.value = '5';
  w.state({ ...viewState(), csvPath: '/tmp/new.csv', sourceRevision: 2, sampleRevision: undefined, resetRevision: 2, inferred: undefined, connection: undefined });
  assert.equal(w.elements.mappingSection.hidden, true);
  assert.equal(w.body.rows.length, 0);
  assert.equal(w.elements.table.value, '');
  assert.equal(w.elements.mode.value, 'create');
  assert.equal(w.elements.delimiter.value, ',');
  assert.equal(w.elements.schema.value, 'imports');
  assert.equal(Number(w.elements.batchSize.value), 37);
  assert.equal(w.elements.runBtn.disabled, true);
});

test('real webview invalidates mappings immediately when delimiter changes', () => {
  const w = webview();
  w.state(viewState());
  w.elements.delimiter.value = ';';
  w.elements.delimiter.emit('change');
  assert.equal(w.body.rows.length, 0);
  assert.equal(w.elements.mappingSection.hidden, true);
  assert.equal(w.elements.runBtn.disabled, true);
});

test('real webview locks repeat run clicks and posts sampling revisions', () => {
  const w = webview();
  w.state(viewState());
  w.elements.runBtn.emit('click');
  w.elements.runBtn.emit('click');
  const runs = w.messages.filter(msg => msg.type === 'run');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].sourceRevision, 1);
  assert.equal(runs[0].sampleRevision, 1);
  assert.equal(w.elements.sampleBtn.disabled, true);
  assert.equal(w.elements.pickConnBtn.disabled, true);
});

test('real webview keeps a pending delimiter invalidation locked through an older queued state', () => {
  const w = webview();
  const original = viewState();
  w.state(original);
  w.elements.delimiter.value = ';';
  w.elements.delimiter.emit('change');
  w.state({ ...original, operation: 'idle' });
  assert.equal(w.elements.mappingSection.hidden, true);
  assert.equal(w.elements.runBtn.disabled, true);
  w.state({ ...original, delimiter: ';', sourceRevision: 2, inferred: undefined, sampleRevision: undefined });
  assert.equal(w.elements.sampleBtn.disabled, false);
});

test('real webview retains its pending import lock through an older queued idle state', () => {
  const w = webview();
  const original = viewState();
  w.state(original);
  w.elements.runBtn.emit('click');
  w.state(original);
  w.elements.runBtn.emit('click');
  assert.equal(w.messages.filter(msg => msg.type === 'run').length, 1);
});

test('resampling rejects a run from an older completed sample', async () => {
  const h = host();
  await h.send({ type: 'pickConnection' });
  await h.send({ type: 'sample' });
  const original = h.state();
  await h.send({ type: 'sample' });
  await assert.rejects(h.send({ type: 'run', sourceRevision: original.sourceRevision, sampleRevision: original.sampleRevision, payload: fixturePayload() }), /sample/i);
});

test('dispose cancels an active import token and suppresses later success messages', async () => {
  const started = deferred(), finished = deferred();
  let activeToken;
  const h = host({ runImport: async (_req, _progress, token) => { activeToken = token; started.resolve(); await finished.promise; return { rowsLoaded: 1 }; } });
  await h.send({ type: 'pickConnection' });
  await h.send({ type: 'sample' });
  const pending = h.run();
  await started.promise;
  h.dispose();
  const count = h.messages.length;
  finished.resolve();
  await pending;
  assert.equal(activeToken.isCancellationRequested, true);
  assert.equal(h.messages.length, count);
  assert.equal(h.infos.length, 0);
});

test('a failed fresh credential refresh releases the import lock', async () => {
  let calls = 0;
  const h = host({ buildDriverConfig: async () => { if (++calls > 1) throw new Error('Sign in required'); return { server: 'sql.example', database: 'app' }; } });
  await h.send({ type: 'pickConnection' });
  await h.send({ type: 'sample' });
  await assert.rejects(h.run(), /Sign in required/);
  assert.equal(h.state().operation, 'idle');
  assert.equal(h.requests.length, 0);
  assert.ok(h.cleanups.includes('token'));
});

test('reset cancels the connection picker token and disposes it after completion', async () => {
  const pick = deferred();
  let token;
  const h = host({ promptForConnection: (_api, cancellationToken) => { token = cancellationToken; return pick.promise; } });
  const pending = h.send({ type: 'pickConnection' });
  await Promise.resolve();
  h.WizardPanel.show(h.context, h.uri('/tmp/second.csv'));
  pick.resolve(undefined);
  await pending;
  assert.equal(token?.isCancellationRequested, true);
  assert.ok(h.cleanups.includes('token'));
});

test('real webview includes every column by default and excludes unchecked columns from the request', () => {
  const w = webview();
  const state = viewState();
  state.inferred.columns.push({ name: 'name', sqlType: 'NVARCHAR(50)', nullable: false });
  state.inferred.sampleRows = [{ id: '1', name: 'one' }];
  w.state(state);
  const includeId = w.body.rows[0].querySelector('.colInclude');
  const includeName = w.body.rows[1].querySelector('.colInclude');
  assert.ok(includeId, 'Each mapped column needs an Include checkbox');
  assert.equal(includeId.checked, true);
  assert.equal(includeName.checked, true);
  includeId.checked = false;
  includeId.emit('change');
  w.elements.runBtn.emit('click');
  const payload = w.messages.find(msg => msg.type === 'run').payload;
  assert.deepEqual(payload.columns.map(column => column.sourceName), ['name']);
});

test('real webview disables Run when no mapped column is included and preserves exclusions on connection updates', () => {
  const w = webview();
  const state = viewState();
  w.state(state);
  const include = w.body.rows[0].querySelector('.colInclude');
  assert.ok(include, 'Each mapped column needs an Include checkbox');
  include.checked = false;
  include.emit('change');
  assert.equal(w.elements.runBtn.disabled, true);
  w.state({ ...state, connection: { ...state.connection, databases: ['app', 'other'] } });
  assert.equal(w.body.rows[0].querySelector('.colInclude').checked, false);
  assert.equal(w.elements.runBtn.disabled, true);
  include.checked = true;
  include.emit('change');
  assert.equal(w.elements.runBtn.disabled, false);
});

test('host rejects a batch larger than 10000 before refreshing credentials or importing', async () => {
  let builds = 0;
  const h = host({ buildDriverConfig: async (_api, info) => { builds++; return { server: info.server, database: info.database }; } });
  await h.send({ type: 'pickConnection' });
  await h.send({ type: 'sample' });
  await assert.rejects(h.run({ ...fixturePayload(), batchSize: 10001 }), /batch size/i);
  assert.equal(builds, 1);
  assert.equal(h.requests.length, 0);
  await h.run({ ...fixturePayload(), batchSize: 10000 });
  assert.equal(h.requests[0].batchSize, 10000);
});

test('host falls back from configured batch sizes outside 1 to 10000', async () => {
  for (const defaultBatchSize of [0, -1, 1.5, 10001, '100']) {
    const h = host({ defaults: { defaultBatchSize } });
    await h.send({ type: 'ready' });
    assert.equal(h.state().defaults.batchSize, 1000);
  }
});

test('wizard rejects virtual source URIs without resetting a native source', async () => {
  const h = host();
  await h.send({ type: 'ready' });
  assert.throws(() => h.WizardPanel.show(h.context, { ...h.uri('/tmp/virtual.csv'), scheme: 'untitled' }), /file|native|virtual/i);
  assert.equal(h.state().csvPath, '/tmp/first.csv');
});

for (const errorMessage of ['Import cancelled, but rollback could not be confirmed', 'Commit failed: transaction outcome is uncertain']) {
  test(`host reports ${errorMessage} even when cancellation was requested`, async () => {
    const h = host({ runImport: async (_request, _progress, token) => {
      token.isCancellationRequested = true;
      throw new Error(errorMessage);
    } });
    await h.send({ type: 'pickConnection' });
    await h.send({ type: 'sample' });
    await h.receive({ type: 'run', sourceRevision: h.state().sourceRevision, sampleRevision: h.state().sampleRevision, payload: fixturePayload() });
    const errors = h.messages.filter(msg => msg.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, errorMessage);
    assert.equal(h.messages.filter(msg => msg.type === 'cancelled' || msg.type === 'done').length, 0);
    assert.equal(h.infos.length, 0);
    assert.equal(h.state().operation, 'idle');
  });
}
