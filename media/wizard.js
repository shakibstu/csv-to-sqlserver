(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const els = {
    csvPath: $('csvPath'),
    delimiter: $('delimiter'),
    sampleBtn: $('sampleBtn'),
    pickConnBtn: $('pickConnBtn'),
    connSummary: $('connSummary'),
    mappingSection: $('mappingSection'),
    databaseSelect: $('databaseSelect'),
    databaseInput: $('databaseInput'),
    mode: $('mode'),
    schema: $('schema'),
    table: $('table'),
    batchSize: $('batchSize'),
    colTableBody: document.querySelector('#colTable tbody'),
    preview: $('preview'),
    runBtn: $('runBtn'),
    errors: $('errors'),
    status: $('status'),
  };

  let state = { csvPath: '', delimiter: ',', operation: 'idle' };
  let renderedResetRevision;
  let renderedSourceRevision;
  let renderedSampleRevision;
  let renderedConnection;
  let pendingImport = false;
  let pendingSource;

  els.delimiter.addEventListener('change', () => {
    const raw = els.delimiter.value;
    const actual = raw === '\\t' ? '\t' : raw;
    if (state.operation === 'importing' || pendingImport) return;
    if (actual === state.delimiter) return;
    pendingSource = { delimiter: actual, revision: state.sourceRevision, resetRevision: state.resetRevision };
    clearMappings();
    updateLocks();
    vscode.postMessage({ type: 'setDelimiter', delimiter: actual });
  });

  els.sampleBtn.addEventListener('click', () => {
    els.errors.textContent = '';
    els.status.textContent = '';
    clearMappings();
    state.operation = 'sampling';
    updateLocks();
    vscode.postMessage({ type: 'sample' });
  });

  els.pickConnBtn.addEventListener('click', () => {
    els.errors.textContent = '';
    state.operation = 'connecting';
    render();
    vscode.postMessage({ type: 'pickConnection' });
  });

  els.runBtn.addEventListener('click', () => {
    if (els.runBtn.disabled || pendingImport) return;
    els.errors.textContent = '';
    els.status.textContent = '';
    const columns = Array.from(els.colTableBody.rows)
      .filter((tr) => tr.querySelector('.colInclude').checked)
      .map((tr) => ({
      sourceName: tr.dataset.source,
      targetName: tr.querySelector('.colTarget').value,
      sqlType: tr.querySelector('.colType').value,
      nullable: tr.querySelector('.colNull').checked,
      isKey: tr.querySelector('.colKey').checked,
    }));
    const database = !els.databaseSelect.hidden
      ? els.databaseSelect.value
      : els.databaseInput.value;
    pendingImport = true;
    updateLocks();
    vscode.postMessage({
      type: 'run',
      sourceRevision: state.sourceRevision,
      sampleRevision: state.sampleRevision,
      payload: {
        mode: els.mode.value,
        database: (database || '').trim(),
        schema: els.schema.value,
        table: els.table.value,
        batchSize: Number(els.batchSize.value),
        columns,
      },
    });
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'state') {
      const next = msg.state;
      if (next.sourceRevision < state.sourceRevision) return;
      state = next;
      if (state.operation === 'importing') pendingImport = false;
      if (pendingSource && (state.resetRevision !== pendingSource.resetRevision ||
          (state.sourceRevision > pendingSource.revision && state.delimiter === pendingSource.delimiter))) {
        pendingSource = undefined;
      }
      render();
    } else if (msg.type === 'error') {
      pendingImport = false;
      pendingSource = undefined;
      els.errors.textContent = msg.message;
      render();
    } else if (msg.type === 'done') {
      pendingImport = false;
      els.status.textContent = `Done. ${msg.rowsLoaded.toLocaleString()} rows loaded.`;
      updateLocks();
    } else if (msg.type === 'cancelled') {
      pendingImport = false;
      els.status.textContent = 'Import cancelled.';
      updateLocks();
    }
  });

  function clearMappings() {
    renderedSampleRevision = undefined;
    els.mappingSection.hidden = true;
    els.colTableBody.innerHTML = '';
    els.preview.innerHTML = '';
  }

  function render() {
    els.csvPath.textContent = state.csvPath || '';
    if (renderedResetRevision !== state.resetRevision) {
      const defaults = state.defaults || { batchSize: 1000, schema: 'dbo' };
      renderedResetRevision = state.resetRevision;
      els.mode.value = 'create';
      els.schema.value = defaults.schema;
      els.table.value = '';
      els.batchSize.value = String(defaults.batchSize);
      els.databaseSelect.innerHTML = '';
      els.databaseInput.value = '';
      renderedConnection = undefined;
      els.errors.textContent = '';
      els.status.textContent = '';
      clearMappings();
    }
    if (renderedSourceRevision !== state.sourceRevision) {
      renderedSourceRevision = state.sourceRevision;
      clearMappings();
    }
    const delimiter = pendingSource ? pendingSource.delimiter : state.delimiter;
    els.delimiter.value = delimiter === '\t' ? '\\t' : delimiter;

    if (state.operation === 'connecting') {
      els.connSummary.textContent = 'Picking connection...';
      els.connSummary.classList.add('busy');
    } else if (state.connection) {
      const c = state.connection;
      els.connSummary.textContent = `${c.authenticationType} @ ${c.server}${
        c.database ? ' / ' + c.database : ''
      } (ready)`;
      els.connSummary.classList.remove('busy');
    } else {
      els.connSummary.textContent = 'No connection selected.';
      els.connSummary.classList.remove('busy');
    }

    // Database choices change only when the selected connection changes.
    const connectionKey = JSON.stringify(state.connection || null);
    if (renderedConnection !== connectionKey) {
      renderedConnection = connectionKey;
      els.databaseSelect.innerHTML = '';
      els.databaseInput.value = '';
      renderDatabaseField(state.connection);
    }

    if (!pendingSource && state.inferred && state.sampleRevision !== undefined) {
      els.mappingSection.hidden = false;
      if (renderedSampleRevision !== state.sampleRevision) {
        renderedSampleRevision = state.sampleRevision;
        if (!els.table.value) {
          const base = String(state.csvPath || '').split(/[\\/]/).pop();
          els.table.value = base.replace(/\.[^.]+$/, '');
        }
        renderColumns(state.inferred.columns);
        renderPreview(state.inferred.sampleRows);
      }
    } else {
      clearMappings();
    }
    updateLocks();
  }

  function updateLocks() {
    const importing = state.operation === 'importing' || pendingImport;
    const connecting = state.operation === 'connecting';
    const sampling = state.operation === 'sampling';
    els.delimiter.disabled = importing;
    els.sampleBtn.disabled = importing || connecting || sampling || !!pendingSource;
    els.pickConnBtn.disabled = importing || connecting;
    for (const control of [els.databaseSelect, els.databaseInput, els.mode, els.schema, els.table, els.batchSize]) {
      control.disabled = importing;
    }
    for (const control of els.colTableBody.querySelectorAll('input')) control.disabled = importing;
    els.runBtn.disabled = importing || connecting || sampling || !!pendingSource || !state.connection ||
      !state.inferred || state.sampleRevision === undefined ||
      !Array.from(els.colTableBody.rows).some((tr) => tr.querySelector('.colInclude').checked);
  }

  function renderDatabaseField(connection) {
    const dbs = (connection && connection.databases) || [];
    const defaultDb = (connection && connection.database) || '';
    if (dbs.length > 0) {
      // Use a dropdown populated from sys.databases.
      const currentSelection = els.databaseSelect.value;
      const previousInput = els.databaseInput.value;
      els.databaseSelect.innerHTML = '';
      for (const name of dbs) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        els.databaseSelect.appendChild(opt);
      }
      // Pick a sensible default: keep prior choice if still valid, else the
      // connection's default database, else the first entry.
      const preferred = [currentSelection, previousInput, defaultDb].find((v) =>
        dbs.includes(v),
      );
      els.databaseSelect.value = preferred || dbs[0];
      els.databaseSelect.hidden = false;
      els.databaseInput.hidden = true;
    } else {
      // Fall back to free-text (e.g. list-databases failed or no connection yet).
      els.databaseSelect.hidden = true;
      els.databaseSelect.innerHTML = '';
      els.databaseInput.hidden = false;
      if (!els.databaseInput.value && defaultDb) {
        els.databaseInput.value = defaultDb;
      }
    }
  }

  function renderColumns(columns) {
    els.colTableBody.innerHTML = '';
    for (const col of columns) {
      const tr = document.createElement('tr');
      tr.dataset.source = col.name;
      const include = checkbox('colInclude', true);
      include.addEventListener('change', updateLocks);
      tr.appendChild(cell(include));
      tr.appendChild(cell(text(col.name)));
      tr.appendChild(cell(input({ className: 'colTarget', value: col.name })));
      tr.appendChild(cell(input({ className: 'colType', value: col.sqlType })));
      tr.appendChild(cell(checkbox('colNull', col.nullable)));
      tr.appendChild(cell(checkbox('colKey', false)));
      els.colTableBody.appendChild(tr);
    }
  }

  function renderPreview(rows) {
    els.preview.innerHTML = '';
    if (!rows || rows.length === 0) {
      els.preview.textContent = '(no rows)';
      return;
    }
    const keys = Object.keys(rows[0]);
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    for (const k of keys) {
      const th = document.createElement('th');
      th.textContent = k;
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const r of rows.slice(0, 20)) {
      const tr = document.createElement('tr');
      for (const k of keys) {
        const td = document.createElement('td');
        td.textContent = String(r[k] ?? '');
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    els.preview.appendChild(table);
  }

  function cell(node) {
    const td = document.createElement('td');
    td.appendChild(node);
    return td;
  }
  function text(s) {
    const span = document.createElement('span');
    span.textContent = s;
    return span;
  }
  function input({ className, value }) {
    const el = document.createElement('input');
    el.type = 'text';
    el.className = className;
    el.value = value;
    return el;
  }
  function checkbox(className, checked) {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.className = className;
    el.checked = !!checked;
    return el;
  }

  clearMappings();
  updateLocks();
  vscode.postMessage({ type: 'ready' });
})();
