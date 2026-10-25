// The results grid (one reused webview panel). Data arrives by postMessage; the page sorts, filters and draws
// at most maxRowsShown rows. Copy / Save go back to the extension, which has every row.

export function resultsHtml(nonce: string, cspSource: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background);
         font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
  #top { position: sticky; top: 0; z-index: 2; background: var(--vscode-editor-background);
         border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); padding: 8px 12px; }
  #where { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  #sql { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre-wrap; max-height: 5.5em;
         overflow: auto; margin: 0 0 6px; opacity: .9; }
  .bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .bar .stat { font-size: 12px; margin-right: 6px; }
  .bar .spacer { flex: 1; }
  input[type=text] { font: inherit; font-size: 12px; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
         border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px; outline: none; width: 200px; }
  input[type=text]:focus { border-color: var(--vscode-focusBorder); }
  button { font: inherit; font-size: 12px; padding: 3px 10px; border: 1px solid transparent; border-radius: 2px; cursor: pointer;
           color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #msg { padding: 16px 12px; }
  #msg.err { color: var(--vscode-errorForeground); white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); }
  #grid { overflow: auto; }
  table { border-collapse: collapse; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 12px); }
  th, td { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); padding: 2px 8px; text-align: left; vertical-align: top;
           max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  th { position: sticky; top: 0; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); cursor: pointer;
       user-select: none; font-weight: 600; }
  th .arrow { opacity: .7; margin-left: 4px; }
  td.n { color: var(--vscode-descriptionForeground); font-style: italic; }
  td.num { text-align: right; }
  td.rn { color: var(--vscode-editorLineNumber-foreground); text-align: right; user-select: none; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  td.sel { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .note { font-size: 12px; color: var(--vscode-descriptionForeground); padding: 6px 12px; }
  .running { display: inline-block; width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--vscode-progressBar-background, #0e70c0);
             border-right-color: transparent; animation: spin .8s linear infinite; vertical-align: -1px; margin-right: 6px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div id="top">
  <div id="where"></div>
  <pre id="sql"></pre>
  <div class="bar">
    <span class="stat" id="stat"></span>
    <input type="text" id="filter" placeholder="Filter rows" spellcheck="false">
    <span class="spacer"></span>
    <button id="rerun" title="Run the same query again">Run again</button>
    <button id="copyTsv" title="Tab-separated, pastes into Excel as columns">Copy for Excel</button>
    <button id="copyCsv">Copy CSV</button>
    <button id="saveCsv">Save CSV...</button>
    <button id="openJson" title="All rows as JSON in an editor">Open as JSON</button>
  </div>
</div>
<div id="msg">Run a query (Ctrl+Enter in a .sql editor) or click a table in the IRIS SQL sidebar.</div>
<div id="grid"></div>
<div class="note" id="note"></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let data = null;          // { columns, rows, ms, sql, where, maxShown, total }
  let sortCol = -1, sortDir = 1, filterText = '';
  let selected = null;

  function fmt(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  function isNum(v) { return typeof v === 'number' || (typeof v === 'string' && /^-?\\d+(\\.\\d+)?$/.test(v)); }

  function visibleRows() {
    let rows = data.rows.map((r, i) => ({ r, i }));
    if (filterText) {
      const f = filterText.toLowerCase();
      rows = rows.filter(x => data.columns.some(c => { const s = fmt(x.r[c]); return s !== null && s.toLowerCase().includes(f); }));
    }
    if (sortCol >= 0) {
      const c = data.columns[sortCol];
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

  function draw() {
    const grid = $('grid');
    grid.textContent = '';
    $('note').textContent = '';
    if (!data || !data.columns) return;
    if (!data.rows.length) { $('msg').hidden = false; $('msg').className = ''; $('msg').textContent = data.columns.length ? 'No rows.' : 'Done. The statement returned no rows.'; return; }
    $('msg').hidden = true;
    const rows = visibleRows();
    const shown = rows.slice(0, data.maxShown);
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    const corner = document.createElement('th'); corner.textContent = '#'; hr.appendChild(corner);
    data.columns.forEach((c, i) => {
      const th = document.createElement('th');
      th.textContent = c;
      th.title = 'Sort by ' + c;
      if (i === sortCol) { const a = document.createElement('span'); a.className = 'arrow'; a.textContent = sortDir > 0 ? '\\u25B2' : '\\u25BC'; th.appendChild(a); }
      th.addEventListener('click', () => { if (sortCol === i) sortDir = -sortDir; else { sortCol = i; sortDir = 1; } draw(); });
      hr.appendChild(th);
    });
    thead.appendChild(hr); table.appendChild(thead);
    const tb = document.createElement('tbody');
    for (const x of shown) {
      const tr = document.createElement('tr');
      const rn = document.createElement('td'); rn.className = 'rn'; rn.textContent = String(x.i + 1); tr.appendChild(rn);
      for (const c of data.columns) {
        const td = document.createElement('td');
        const v = fmt(x.r[c]);
        if (v === null) { td.className = 'n'; td.textContent = 'NULL'; }
        else { td.textContent = v; td.dir = 'auto'; if (isNum(x.r[c])) td.className = 'num'; if (v.length > 60) td.title = v.length > 2000 ? v.slice(0, 2000) + '\\u2026' : v; }
        td.dataset.v = v === null ? '' : v;
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    grid.appendChild(table);
    const total = data.rows.length;
    $('stat').textContent = (filterText ? rows.length + ' of ' : '') + total + ' row' + (total === 1 ? '' : 's') + ' \\u00b7 ' + data.columns.length + ' columns \\u00b7 ' + data.ms + ' ms';
    if (rows.length > shown.length) $('note').textContent = 'Showing the first ' + shown.length + ' rows (setting irisSql.maxRowsShown). Copy / Save CSV include all ' + rows.length + '.';
  }

  $('grid').addEventListener('click', e => {
    const td = e.target.closest('td');
    if (!td || td.classList.contains('rn')) return;
    if (selected) selected.classList.remove('sel');
    selected = td; td.classList.add('sel');
  });
  $('grid').addEventListener('dblclick', e => {
    const td = e.target.closest('td');
    if (!td || td.classList.contains('rn')) return;
    vscode.postMessage({ type: 'copyValue', value: td.dataset.v || '' });
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selected && !String(window.getSelection() || '')) {
      e.preventDefault(); vscode.postMessage({ type: 'copyValue', value: selected.dataset.v || '' });
    }
  });
  let ft = 0;
  $('filter').addEventListener('input', e => { clearTimeout(ft); ft = setTimeout(() => { filterText = e.target.value; draw(); }, 200); });
  const order = () => visibleRows().map(x => x.i);
  $('copyTsv').addEventListener('click', () => vscode.postMessage({ type: 'copy', sep: '\\t', order: order() }));
  $('copyCsv').addEventListener('click', () => vscode.postMessage({ type: 'copy', sep: ',', order: order() }));
  $('saveCsv').addEventListener('click', () => vscode.postMessage({ type: 'save', order: order() }));
  $('openJson').addEventListener('click', () => vscode.postMessage({ type: 'json', order: order() }));
  $('rerun').addEventListener('click', () => vscode.postMessage({ type: 'rerun' }));

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (!m) return;
    if (m.type === 'running') {
      $('where').textContent = m.where; $('sql').textContent = m.sql;
      $('msg').hidden = false; $('msg').className = ''; $('msg').innerHTML = '<span class="running"></span>Running\\u2026';
      $('grid').textContent = ''; $('note').textContent = ''; $('stat').textContent = '';
    } else if (m.type === 'error') {
      $('where').textContent = m.where; $('sql').textContent = m.sql;
      $('msg').hidden = false; $('msg').className = 'err'; $('msg').textContent = m.message;
      $('grid').textContent = ''; $('stat').textContent = '';
      data = null;
    } else if (m.type === 'result') {
      data = m; sortCol = -1; sortDir = 1; selected = null;
      $('where').textContent = m.where; $('sql').textContent = m.sql;
      draw();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
