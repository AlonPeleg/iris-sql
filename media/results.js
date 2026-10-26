// IRIS SQL Results page. The extension sends the rows and the query state (conditions, sort, count by); this page
// draws the grid, its right-click menu, the chips and the condition box, and sends back what you ask for. The SQL
// itself is built by the extension (queryBuilder.ts); "here only" filters, column order / hiding and the header-click
// sort only change what this page shows.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  let data = null;            // the last result: { columns, rows, ms, sql, where, maxShown, state, canBack, canForward }
  let state = { conds: [], sort: null, group: null };
  let sortCol = null, sortDir = 1, filterText = '';
  let selected = null;
  // page-only view settings, kept while the tab is open (the same table run again keeps them)
  let colOrder = [];          // column names in the order shown
  const hidden = new Set();   // hidden column names
  let local = [];             // here-only filters: { id, col, mode: 'keep' | 'hide', value }

  // ---------------------------------------------------------------- values ----
  const fmt = v => v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const isNum = v => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));
  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(v);
  const sameVal = (a, b) => (a === null || a === undefined) ? (b === null || b === undefined) : fmt(a) === fmt(b);
  const show = v => v === null || v === undefined ? 'empty' : typeof v === 'string' && !isNum(v) ? "'" + v + "'" : String(v);
  const short = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

  // ---------------------------------------------------------------- columns ----
  function visibleColumns() { return colOrder.filter(c => data && data.columns.includes(c) && !hidden.has(c)); }
  function mergeColumns(cols) {
    const keep = colOrder.filter(c => cols.includes(c));
    colOrder = keep.concat(cols.filter(c => !keep.includes(c)));
  }

  function visibleRows() {
    let rows = data.rows.map((r, i) => ({ r, i }));
    for (const f of local) {
      if (!data.columns.includes(f.col)) continue;
      rows = rows.filter(x => sameVal(x.r[f.col], f.value) === (f.mode === 'keep'));
    }
    if (filterText) {
      const q = filterText.toLowerCase();
      const cols = visibleColumns();
      rows = rows.filter(x => cols.some(c => { const s = fmt(x.r[c]); return s !== null && s.toLowerCase().includes(q); }));
    }
    if (sortCol && data.columns.includes(sortCol)) {
      const c = sortCol;
      rows.sort((a, b) => {
        const va = a.r[c], vb = b.r[c];
        if (va === vb) return 0;
        if (va === null || va === undefined || va === '') return 1;
        if (vb === null || vb === undefined || vb === '') return -1;
        if (isNum(va) && isNum(vb)) return (Number(va) - Number(vb)) * sortDir;
        return String(va).localeCompare(String(vb)) * sortDir;
      });
    }
    return rows;
  }

  // ---------------------------------------------------------------- grid ----
  function draw() {
    const grid = $('grid');
    grid.textContent = '';
    $('note').textContent = '';
    drawChips();
    if (!data || !data.columns) return;
    const cols = visibleColumns();
    $('columnsBtn').textContent = 'Columns' + (hidden.size && data.columns.some(c => hidden.has(c)) ? ' (' + data.columns.filter(c => hidden.has(c)).length + ' hidden)' : '');
    if (!data.rows.length) {
      $('msg').hidden = false; $('msg').className = '';
      $('msg').textContent = data.columns.length ? 'No rows.' : 'Done. The statement returned no rows.';
      $('stat').textContent = '0 rows · ' + data.ms + ' ms';
      return;
    }
    $('msg').hidden = true;
    const rows = visibleRows();
    const shown = rows.slice(0, data.maxShown);
    const table = el('table');
    const thead = el('thead');
    const hr = el('tr');
    hr.appendChild(el('th', '', '#'));
    cols.forEach(c => {
      const th = el('th', '', c);
      th.dataset.col = c;
      th.title = c + '\nClick: sort here · Right-click: filter, sort, count, hide · Drag: move';
      th.draggable = true;
      if (c === sortCol) th.appendChild(el('span', 'arrow', sortDir > 0 ? '▲' : '▼'));
      hr.appendChild(th);
    });
    thead.appendChild(hr); table.appendChild(thead);
    const tb = el('tbody');
    for (const x of shown) {
      const tr = el('tr');
      tr.dataset.i = String(x.i);
      tr.appendChild(el('td', 'rn', String(x.i + 1)));
      for (const c of cols) {
        const td = el('td');
        const raw = x.r[c];
        const v = fmt(raw);
        td.dataset.col = c;
        if (v === null) { td.className = 'n'; td.textContent = 'NULL'; }
        else { td.textContent = v; td.dir = 'auto'; if (isNum(raw)) td.className = 'num'; if (v.length > 60) td.title = v.length > 2000 ? v.slice(0, 2000) + '…' : v; }
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    grid.appendChild(table);
    const total = data.rows.length;
    const narrowed = rows.length !== total;
    $('stat').textContent = (narrowed ? rows.length + ' of ' : '') + total + ' row' + (total === 1 ? '' : 's') + ' · ' + cols.length +
      (cols.length !== data.columns.length ? ' of ' + data.columns.length : '') + ' columns · ' + data.ms + ' ms';
    if (rows.length > shown.length) $('note').textContent = 'Showing the first ' + shown.length + ' rows (setting irisSql.maxRowsShown). Copy / Save CSV include all ' + rows.length + '.';
  }

  const cellOf = td => {
    const tr = td.closest('tr');
    if (!tr || !data) return null;
    const row = data.rows[Number(tr.dataset.i)];
    return row ? { col: td.dataset.col, value: row[td.dataset.col] } : null;
  };

  $('grid').addEventListener('click', e => {
    const th = e.target.closest('th');
    if (th && th.dataset.col) {               // header click: sort what is shown (no query)
      if (sortCol === th.dataset.col) sortDir = -sortDir; else { sortCol = th.dataset.col; sortDir = 1; }
      draw(); return;
    }
    const td = e.target.closest('td');
    if (!td || td.classList.contains('rn')) return;
    if (selected) selected.classList.remove('sel');
    selected = td; td.classList.add('sel');
  });
  $('grid').addEventListener('dblclick', e => {
    const td = e.target.closest('td');
    if (!td || td.classList.contains('rn')) return;
    const c = cellOf(td);
    if (c) vscode.postMessage({ type: 'copyValue', value: fmt(c.value) ?? '' });
  });

  // drag a column title onto another to move it in front of that one
  let dragCol = null;
  $('grid').addEventListener('dragstart', e => { const th = e.target.closest && e.target.closest('th'); if (th && th.dataset.col) { dragCol = th.dataset.col; e.dataTransfer.effectAllowed = 'move'; } });
  $('grid').addEventListener('dragover', e => {
    const th = e.target.closest && e.target.closest('th');
    if (!dragCol || !th || !th.dataset.col) return;
    e.preventDefault();
    document.querySelectorAll('th.drop-before').forEach(x => x.classList.remove('drop-before'));
    th.classList.add('drop-before');
  });
  $('grid').addEventListener('drop', e => {
    const th = e.target.closest && e.target.closest('th');
    document.querySelectorAll('th.drop-before').forEach(x => x.classList.remove('drop-before'));
    if (!dragCol || !th || !th.dataset.col || th.dataset.col === dragCol) { dragCol = null; return; }
    e.preventDefault();
    colOrder = colOrder.filter(c => c !== dragCol);
    colOrder.splice(colOrder.indexOf(th.dataset.col), 0, dragCol);
    dragCol = null;
    draw();
  });
  $('grid').addEventListener('dragend', () => { dragCol = null; document.querySelectorAll('th.drop-before').forEach(x => x.classList.remove('drop-before')); });

  // ---------------------------------------------------------------- chips ----
  function chip(text, opts) {
    const c = el('span', 'chip' + (opts.cls ? ' ' + opts.cls : ''));
    if (opts.dot) { const d = el('span', 'dot', opts.on ? '●' : '○'); d.title = opts.on ? 'Turn off (keep the chip)' : 'Turn on'; d.addEventListener('click', opts.dot); c.appendChild(d); }
    const t = el('span', 't', text); t.title = opts.title || text; if (opts.click) t.addEventListener('click', opts.click); c.appendChild(t);
    if (opts.tag) c.appendChild(el('span', 'tag', opts.tag));
    const x = el('span', 'x', '✕'); x.title = opts.xTitle || 'Remove'; x.addEventListener('click', opts.remove); c.appendChild(x);
    return c;
  }
  function drawChips() {
    const box = $('chips');
    box.textContent = '';
    for (const c of state.conds || []) {
      box.appendChild(chip(c.label, {
        cls: c.enabled ? '' : 'off', on: c.enabled, title: c.label + '\nClick: edit · ●: turn off / on · ✕: remove',
        dot: () => send({ type: 'toggleCond', id: c.id }),
        click: e => openCondBox({ col: c.col, op: c.op, value: c.value, value2: c.value2, editId: c.id }, e.clientX, e.clientY),
        remove: () => send({ type: 'removeCond', id: c.id })
      }));
    }
    if (state.sort) box.appendChild(chip('sorted by ' + state.sort.col + (state.sort.dir === 'DESC' ? ' ↓' : ' ↑'), {
      cls: 'kind', title: 'Server sort. Click: other direction · ✕: remove',
      click: () => send({ type: 'sort', col: state.sort.col, dir: state.sort.dir === 'DESC' ? 'ASC' : 'DESC' }),
      remove: () => send({ type: 'clearSort' })
    }));
    if (state.group) box.appendChild(chip('count by ' + state.group, {
      cls: 'kind', title: 'Rows counted by ' + state.group + '. Right-click a value: show those rows · ✕: back to the rows',
      remove: () => send({ type: 'clearGroup' })
    }));
    for (const f of local) {
      box.appendChild(chip((f.mode === 'keep' ? f.col + ' = ' : f.col + ' ≠ ') + show(f.value), {
        cls: 'local', tag: 'here only', title: 'Only changes what is shown here (the rows already loaded); no query is run.',
        remove: () => { local = local.filter(x => x.id !== f.id); draw(); }
      }));
    }
  }

  // ---------------------------------------------------------------- menu ----
  let menuEl = null, popEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  function place(box, x, y) {
    document.body.appendChild(box);
    const r = box.getBoundingClientRect();
    box.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    box.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  }
  function openMenu(items, x, y, head) {
    closeMenu(); closePop();
    menuEl = el('div', 'menu');
    if (head) menuEl.appendChild(el('div', 'head', head));
    for (const it of items) {
      if (it === '-') { menuEl.appendChild(el('div', 'sep')); continue; }
      const d = el('div', 'item', it.label);
      d.title = it.title || it.label;
      d.addEventListener('click', ev => { ev.stopPropagation(); closeMenu(); it.run(ev); });
      menuEl.appendChild(d);
    }
    place(menuEl, x, y);
  }

  function cellMenu(col, value, x, y) {
    const items = [];
    const v = value === undefined ? null : value;
    if (state.group) {
      if (col === state.group) items.push({ label: 'Show these rows (' + col + (v === null ? ' is empty' : ' = ' + short(show(v), 40)) + ')', run: () => send({ type: 'drill', col, value: v }) });
      items.push('-', { label: 'Copy value', run: () => send({ type: 'copyValue', value: fmt(v) ?? '' }) });
      openMenu(items, x, y, col);
      return;
    }
    const sv = short(show(v), 40);
    if (v === null) {
      items.push({ label: 'Filter: ' + col + ' is empty', run: () => add(col, 'isNull') });
      items.push({ label: 'Filter: ' + col + ' is not empty', run: () => add(col, 'notNull') });
    } else {
      items.push({ label: 'Filter: ' + col + ' = ' + sv, run: () => add(col, 'eq', v) });
      items.push({ label: 'Filter: ' + col + ' ≠ ' + sv, run: () => add(col, 'ne', v) });
      if (isDate(v)) {
        items.push({ label: 'Filter: ' + col + ' on ' + String(v).slice(0, 10), run: () => add(col, 'onDay', v) });
        items.push({ label: 'Filter: ' + col + ' after ' + sv, run: () => add(col, 'gt', v) });
        items.push({ label: 'Filter: ' + col + ' before ' + sv, run: () => add(col, 'lt', v) });
      } else if (isNum(v)) {
        items.push({ label: 'Filter: ' + col + ' > ' + sv, run: () => add(col, 'gt', v) });
        items.push({ label: 'Filter: ' + col + ' < ' + sv, run: () => add(col, 'lt', v) });
      } else if (typeof v === 'string' && v !== '') {
        items.push({ label: 'Filter: ' + col + ' contains…', run: ev => openCondBox({ col, op: 'contains', value: v }, ev.clientX, ev.clientY) });
      }
    }
    items.push({ label: 'Filter ' + col + '…', run: ev => openCondBox({ col, op: v === null ? 'isNull' : 'eq', value: v }, ev.clientX, ev.clientY) });
    items.push('-');
    items.push({ label: 'Keep only rows like this (here only)', title: 'Only the loaded rows; no query is run', run: () => addLocal(col, 'keep', v) });
    items.push({ label: 'Hide rows like this (here only)', title: 'Only the loaded rows; no query is run', run: () => addLocal(col, 'hide', v) });
    items.push('-');
    columnItems(col).forEach(i => items.push(i));
    items.push('-');
    items.push({ label: 'Copy value', run: () => send({ type: 'copyValue', value: fmt(v) ?? '' }) });
    items.push({ label: 'Copy condition', title: 'As SQL, e.g. "%createdBy" = \'MDigital\'', run: () => send({ type: 'copyCondition', col, op: v === null ? 'isNull' : 'eq', value: v }) });
    items.push({ label: 'Copy column name', run: () => send({ type: 'copyValue', value: col }) });
    openMenu(items, x, y, col);
  }
  function columnItems(col) {
    return [
      { label: 'Sort by ' + col + ' ↑ (run)', run: () => send({ type: 'sort', col, dir: 'ASC' }) },
      { label: 'Sort by ' + col + ' ↓ (run)', run: () => send({ type: 'sort', col, dir: 'DESC' }) },
      { label: 'Count by ' + col, title: 'How many rows have each value', run: () => send({ type: 'countBy', col }) },
      { label: 'Hide column', run: () => { hidden.add(col); draw(); } }
    ];
  }
  function headerMenu(col, x, y) {
    const items = [];
    if (!state.group) {
      items.push({ label: 'Filter ' + col + '…', run: ev => openCondBox({ col, op: 'eq', value: '' }, ev.clientX, ev.clientY) });
      items.push({ label: 'Filter: ' + col + ' is empty', run: () => add(col, 'isNull') });
      items.push({ label: 'Filter: ' + col + ' is not empty', run: () => add(col, 'notNull') });
      items.push('-');
      columnItems(col).forEach(i => items.push(i));
    } else items.push({ label: 'Hide column', run: () => { hidden.add(col); draw(); } });
    items.push('-', { label: 'Copy column name', run: () => send({ type: 'copyValue', value: col }) });
    openMenu(items, x, y, col);
  }
  $('grid').addEventListener('contextmenu', e => {
    const th = e.target.closest('th');
    if (th && th.dataset.col) { e.preventDefault(); headerMenu(th.dataset.col, e.clientX, e.clientY); return; }
    const td = e.target.closest('td');
    if (!td || td.classList.contains('rn')) return;
    const c = cellOf(td);
    if (!c) return;
    e.preventDefault();
    if (selected) selected.classList.remove('sel');
    selected = td; td.classList.add('sel');
    cellMenu(c.col, c.value, e.clientX, e.clientY);
  });

  function add(col, op, value, value2) { send({ type: 'addCond', col, op, value: value === undefined ? null : value, value2 }); }
  function addLocal(col, mode, value) { local.push({ id: 'l' + Date.now() + Math.random(), col, mode, value: value === undefined ? null : value }); draw(); }

  // ---------------------------------------------------------------- condition box ----
  const OPS = [['eq', '='], ['ne', '≠'], ['gt', '>'], ['ge', '≥'], ['lt', '<'], ['le', '≤'], ['between', 'between'],
               ['contains', 'contains'], ['notContains', 'does not contain'], ['startsWith', 'starts with'],
               ['isNull', 'is empty'], ['notNull', 'is not empty'], ['onDay', 'on the day']];
  const NO_VALUE = ['isNull', 'notNull'];
  // what was typed, as the same kind of value the column had (a number stays a number, true / false a boolean)
  function typed(text, like) {
    const t = text.trim();
    if (typeof like === 'number' && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (typeof like === 'boolean' && /^(true|false|1|0)$/i.test(t)) return /^(true|1)$/i.test(t);
    return text;
  }
  function openCondBox(c, x, y) {
    closeMenu(); closePop();
    popEl = el('div', 'pop');
    popEl.appendChild(el('div', 'ttl', c.col));
    const row = el('div', 'row');
    const op = el('select');
    for (const [k, l] of OPS) { const o = el('option', '', l); o.value = k; op.appendChild(o); }
    op.value = c.op || 'eq';
    const v1 = el('input'); v1.type = 'text'; v1.value = fmt(c.value) ?? ''; v1.spellcheck = false;
    const and = el('span', '', 'and');
    const v2 = el('input'); v2.type = 'text'; v2.value = fmt(c.value2) ?? ''; v2.spellcheck = false;
    row.append(op, v1, and, v2);
    popEl.appendChild(row);
    const hint = el('div', 'hint'); popEl.appendChild(hint);
    const sync = () => {
      const k = op.value;
      v1.hidden = NO_VALUE.includes(k);
      and.hidden = v2.hidden = k !== 'between';
      hint.textContent = k === 'onDay' ? 'A date, like 2026-05-31' : k === 'contains' || k === 'notContains' || k === 'startsWith' ? 'Part of the text' :
        isDate(c.value) ? 'Dates as 2026-05-31 or 2026-05-31 11:00:15' : '';
      hint.hidden = !hint.textContent;
    };
    op.addEventListener('change', sync); sync();
    const btns = el('div', 'btns');
    const ok = el('button', 'primary', c.editId ? 'Save' : 'Add filter');
    const cancel = el('button', '', 'Cancel');
    btns.append(cancel, ok);
    popEl.appendChild(btns);
    const done = () => {
      const k = op.value;
      const msg = { col: c.col, op: k };
      if (!NO_VALUE.includes(k)) msg.value = typed(v1.value, c.value);
      if (k === 'between') msg.value2 = typed(v2.value, c.value);
      closePop();
      if (c.editId) send(Object.assign({ type: 'editCond', id: c.editId }, msg)); else send(Object.assign({ type: 'addCond' }, msg));
    };
    ok.addEventListener('click', done);
    cancel.addEventListener('click', closePop);
    popEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); done(); }
      if (e.key === 'Escape') { e.preventDefault(); closePop(); }
    });
    place(popEl, x, y);
    (v1.hidden ? op : v1).focus();
    if (!v1.hidden) v1.select();
  }

  // ---------------------------------------------------------------- Columns list ----
  $('columnsBtn').addEventListener('click', e => {
    if (!data) return;
    closeMenu(); closePop();
    popEl = el('div', 'pop');
    popEl.appendChild(el('div', 'ttl', 'Columns'));
    const list = el('div', 'cols');
    for (const c of colOrder.filter(x => data.columns.includes(x))) {
      const lab = el('label');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !hidden.has(c);
      cb.addEventListener('change', () => { cb.checked ? hidden.delete(c) : hidden.add(c); draw(); });
      lab.append(cb, document.createTextNode(c));
      list.appendChild(lab);
    }
    popEl.appendChild(list);
    const btns = el('div', 'btns');
    const all = el('button', '', 'Show all'); all.addEventListener('click', () => { hidden.clear(); closePop(); draw(); });
    const reset = el('button', '', 'Original order'); reset.addEventListener('click', () => { colOrder = data.columns.slice(); closePop(); draw(); });
    const close = el('button', 'primary', 'Close'); close.addEventListener('click', closePop);
    btns.append(all, reset, close);
    popEl.appendChild(btns);
    popEl.addEventListener('keydown', ev => { if (ev.key === 'Escape') closePop(); });
    const r = e.target.getBoundingClientRect();
    place(popEl, r.left, r.bottom + 4);
  });

  document.addEventListener('mousedown', e => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
    if (popEl && !popEl.contains(e.target) && e.target.id !== 'columnsBtn') closePop();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeMenu(); closePop(); }
    // Ctrl+C on a selected cell copies its value - but not while typing in the query box, the filter or the condition box
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selected && !/^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName) && !String(window.getSelection() || '')) {
      const c = cellOf(selected);
      if (c) { e.preventDefault(); send({ type: 'copyValue', value: fmt(c.value) ?? '' }); }
    }
    // Alt+Left / Alt+Right: back / forward
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !/^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName)) {
      e.preventDefault(); send({ type: e.key === 'ArrowLeft' ? 'back' : 'forward' });
    }
  });
  window.addEventListener('blur', closeMenu);

  // ---------------------------------------------------------------- toolbar ----
  function send(m) { vscode.postMessage(m); }
  let ft = 0;
  $('filter').addEventListener('input', e => { clearTimeout(ft); ft = setTimeout(() => { filterText = e.target.value; draw(); }, 200); });
  const exportMsg = type => ({ type, order: visibleRows().map(x => x.i), columns: visibleColumns() });
  $('copyTsv').addEventListener('click', () => send(Object.assign(exportMsg('copy'), { sep: '\t' })));
  $('copyCsv').addEventListener('click', () => send(Object.assign(exportMsg('copy'), { sep: ',' })));
  $('saveCsv').addEventListener('click', () => send(exportMsg('save')));
  $('openJson').addEventListener('click', () => send(exportMsg('json')));
  $('back').addEventListener('click', () => send({ type: 'back' }));
  $('forward').addEventListener('click', () => send({ type: 'forward' }));

  // the query box: edit, then Run / Ctrl+Enter runs it on the same namespace and user
  const sqlBox = $('sql');
  const fitSql = () => { sqlBox.rows = Math.min(8, Math.max(1, sqlBox.value.split('\n').length)); };
  const setSql = s => { sqlBox.value = s || ''; fitSql(); };
  sqlBox.addEventListener('input', fitSql);
  sqlBox.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runBox(); }
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); sqlBox.setRangeText('    ', sqlBox.selectionStart, sqlBox.selectionEnd, 'end'); }
  });
  const runBox = () => { if (sqlBox.value.trim()) send({ type: 'rerun', sql: sqlBox.value }); };
  $('rerun').addEventListener('click', runBox);
  $('toEditor').addEventListener('click', () => send({ type: 'toEditor', sql: sqlBox.value }));

  function takeState(m) {
    state = m.state || { conds: [], sort: null, group: null };
    $('back').disabled = !m.canBack;
    $('forward').disabled = !m.canForward;
    $('where').textContent = m.where || '';
    setSql(m.sql);
  }

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (!m) return;
    if (m.type === 'running') {
      takeState(m);
      $('msg').hidden = false; $('msg').className = ''; $('msg').textContent = '';
      $('msg').append(el('span', 'running'), document.createTextNode('Running…'));
      $('grid').textContent = ''; $('note').textContent = ''; $('stat').textContent = '';
      drawChips();
    } else if (m.type === 'error') {
      takeState(m);
      $('msg').hidden = false; $('msg').className = 'err'; $('msg').textContent = m.message;
      $('grid').textContent = ''; $('stat').textContent = '';
      data = null;
      drawChips();                         // the chips stay: remove the one that broke the query
    } else if (m.type === 'result') {
      takeState(m);
      const sameColumns = data && data.columns.join('\u0001') === m.columns.join('\u0001');
      data = m; selected = null;
      if (!sameColumns) { sortCol = null; sortDir = 1; local = []; }   // here-only filters belong to the rows they were made on
      mergeColumns(m.columns);
      draw();
    }
  });
  send({ type: 'ready' });
})();
