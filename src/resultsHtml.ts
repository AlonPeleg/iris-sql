// The results page (one reused webview panel). Its script and styles are media/results.js and media/results.css;
// data arrives by postMessage. Copy / Save go back to the extension, which has every row.

export function resultsHtml(nonce: string, cspSource: string, scriptUri: string, styleUri: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
<div id="top">
  <div id="where"></div>
  <textarea id="sql" rows="1" spellcheck="false" title="Edit the query and run it: Ctrl+Enter or Run"></textarea>
  <div id="chips"></div>
  <div class="bar">
    <button id="back" class="icon" title="Back to the previous query (Alt+Left)" disabled>&#8592;</button>
    <button id="forward" class="icon" title="Forward (Alt+Right)" disabled>&#8594;</button>
    <span class="stat" id="stat"></span>
    <input type="text" id="filter" placeholder="Filter rows (here only)" spellcheck="false">
    <span class="spacer"></span>
    <button id="rerun" class="primary" title="Run the query above (Ctrl+Enter)">Run</button>
    <button id="toEditor" title="Continue with this query in a .sql editor">Open in Editor</button>
    <button id="columnsBtn" title="Show, hide and reorder columns (drag a column title to move it)">Columns</button>
    <button id="copyTsv" title="Tab-separated, pastes into Excel as columns">Copy for Excel</button>
    <button id="copyCsv">Copy CSV</button>
    <button id="saveCsv">Save CSV...</button>
    <button id="openJson" title="The rows as JSON in an editor">Open as JSON</button>
  </div>
</div>
<div id="msg">Run a query (Ctrl+Enter in a .sql editor) or click a table in the IRIS SQL sidebar. Right-click a cell or a column title to filter, sort or count.</div>
<div id="grid"></div>
<div class="note" id="note"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
