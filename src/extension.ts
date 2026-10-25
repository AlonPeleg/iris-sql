import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Connection, QueryOptions, QueryResult, forgetSessions, isReadOnly, firstKeyword, normalizeStatement, qualified, runQuery, statementAt, toCsv } from './atelier';
import { NamespaceTarget, classUri, findNamespaces, forgetTypedPasswords, loginUserFor, setLog, setStore, signInAs, useDefaultLogin, withLogin } from './connections';
import { Matcher, ProcInfo, TableInfo, callTemplate, isSystemSchema, listColumns, listProcParams, listProcedures, listTables, makeMatcher, procMatches, tableMatches } from './catalog';
import { resultsHtml } from './resultsHtml';

let output: vscode.OutputChannel;
function log(s: string) { output.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`); }

function cfg() { return vscode.workspace.getConfiguration('irisSql'); }
function queryOptions(signal?: QueryOptions['signal']): QueryOptions {
    return {
        allowSelfSigned: cfg().get<boolean>('allowSelfSignedCert', false),
        timeoutMs: Math.max(5, cfg().get<number>('timeoutSeconds', 120)) * 1000,
        signal
    };
}

// ------------------------------------------------------------------------------------------------
// Tree: namespace > Tables / Views / Procedures > schema > item
// ------------------------------------------------------------------------------------------------

type Kind = 'tables' | 'views' | 'procedures';
type Node =
    | { t: 'ns'; ns: NamespaceTarget }
    | { t: 'group'; ns: NamespaceTarget; kind: Kind; count?: number }
    | { t: 'schema'; ns: NamespaceTarget; kind: Kind; schema: string; count?: number }
    | { t: 'table'; ns: NamespaceTarget; table: TableInfo }
    | { t: 'proc'; ns: NamespaceTarget; proc: ProcInfo }
    | { t: 'msg'; text: string; tooltip?: string; ns?: NamespaceTarget };

interface Catalog { tables: TableInfo[]; procs: ProcInfo[]; error?: string }

class SqlTree implements vscode.TreeDataProvider<Node> {
    private emitter = new vscode.EventEmitter<Node | undefined | void>();
    readonly onDidChangeTreeData = this.emitter.event;
    namespaces: NamespaceTarget[] = [];
    private catalogs = new Map<string, Promise<Catalog>>();

    refresh() { this.catalogs.clear(); this.loadedIds.clear(); this.namespaces = []; this.loaded = undefined; this.emitter.fire(); }

    // ---- filter: only matching tables / views / procedures, with the groups above them opened ----
    filter = '';
    private matcher: Matcher | undefined;
    private loadedIds = new Set<string>();           // namespaces whose tables have been read (only those open by themselves)
    setFilter(text: string) {
        this.filter = text.trim();
        this.matcher = makeMatcher(this.filter);
        this.emitter.fire();
    }
    /** Item ids change with the filter, so a filtered tree opens with its matches showing (and closes again after). */
    private fid(base: string) { return this.filter ? `${base}|f:${this.filter}` : base; }
    private openWhenFiltered(): vscode.TreeItemCollapsibleState {
        return this.matcher ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    }
    private label(text: string): vscode.TreeItemLabel | string {
        const hit = this.matcher?.(text);
        return hit ? { label: text, highlights: [hit] } : text;
    }
    /** Reads one namespace's tables again (after its login changed). */
    refreshNamespace(ns: NamespaceTarget) { this.catalogs.delete(ns.id); this.emitter.fire(); }

    private loaded: Promise<void> | undefined;
    async ensureNamespaces(): Promise<NamespaceTarget[]> {
        if (!this.loaded) this.loaded = findNamespaces().then(n => { this.namespaces = n; });
        await this.loaded;
        return this.namespaces;
    }

    private catalog(ns: NamespaceTarget): Promise<Catalog> {
        let p = this.catalogs.get(ns.id);
        if (!p) {
            p = (async () => {
                try {
                    const r = await withLogin(ns, async c => {
                        log(`Reading the SQL catalog of ${ns.label} as ${c.username}`);
                        const tables = await listTables(c, queryOptions(), log);
                        let procs: ProcInfo[] = [];
                        try { procs = await listProcedures(c, queryOptions(), log); } catch (e: any) { log('  procedures not available: ' + (e?.message || e)); }
                        log(`  ${tables.length} tables / views, ${procs.length} procedures`);
                        return { tables, procs };
                    });
                    return r ?? { tables: [], procs: [], error: 'Not signed in - click Refresh to try again.' };
                } catch (e: any) {
                    log('  FAILED: ' + (e?.message || e));
                    return { tables: [], procs: [], error: e?.message || String(e) };
                }
            })();
            this.catalogs.set(ns.id, p);
            p.then(r => { if (r.error) this.catalogs.delete(ns.id); else this.loadedIds.add(ns.id); });
        }
        return p;
    }

    getTreeItem(n: Node): vscode.TreeItem {
        switch (n.t) {
            case 'ns': {
                // filtered: a namespace whose tables were already read opens by itself (others would ask for a login)
                const it = new vscode.TreeItem(n.ns.label, this.matcher && this.loadedIds.has(n.ns.id)
                    ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
                it.id = this.fid(n.ns.id);
                const other = loginUserFor(n.ns);
                it.iconPath = new vscode.ThemeIcon(other ? 'account' : 'server');
                it.description = other ? `as ${other}` : undefined;
                it.contextValue = other ? 'namespaceOther' : 'namespace';
                it.tooltip = `${n.ns.label}\n${n.ns.conn ? `${n.ns.conn.scheme}://${n.ns.conn.host}:${n.ns.conn.port}${n.ns.conn.pathPrefix}` : 'no server address'}\n` +
                    (other ? `Signed in as ${other} (right-click > Use Default Login to go back)` : `Signed in as ${n.ns.conn?.username || '?'} (right-click > Sign in as Another User...)`);
                return it;
            }
            case 'group': {
                const label = n.kind === 'tables' ? 'Tables' : n.kind === 'views' ? 'Views' : 'Procedures';
                const it = new vscode.TreeItem(label, this.openWhenFiltered());
                it.id = this.fid(`${n.ns.id}|${n.kind}`);
                if (n.count !== undefined) it.description = String(n.count);
                it.iconPath = new vscode.ThemeIcon(n.kind === 'procedures' ? 'symbol-method' : n.kind === 'views' ? 'eye' : 'table');
                return it;
            }
            case 'schema': {
                const it = new vscode.TreeItem(this.label(n.schema), this.openWhenFiltered());
                it.id = this.fid(`${n.ns.id}|${n.kind}|${n.schema}`);
                if (n.count !== undefined) it.description = String(n.count);
                it.iconPath = new vscode.ThemeIcon('symbol-namespace');
                return it;
            }
            case 'table': {
                const it = new vscode.TreeItem(this.label(n.table.name), vscode.TreeItemCollapsibleState.None);
                it.iconPath = new vscode.ThemeIcon(n.table.type === 'view' ? 'eye' : 'table');
                it.description = n.table.className && n.table.className.split('.').pop() !== n.table.name ? n.table.className : undefined;
                it.tooltip = `${qualified(n.table.schema, n.table.name)}${n.table.className ? '\nclass ' + n.table.className : ''}\nClick: SELECT TOP ${cfg().get<number>('topRows', 100)} *`;
                it.contextValue = 'table';
                it.command = { command: 'irisSql.selectTop', title: 'Select Top Rows', arguments: [n] };
                return it;
            }
            case 'proc': {
                const it = new vscode.TreeItem(this.label(n.proc.name), vscode.TreeItemCollapsibleState.None);
                it.iconPath = new vscode.ThemeIcon('symbol-method');
                it.description = n.proc.className ? `${n.proc.className}.${n.proc.methodName}` : undefined;
                it.tooltip = `${qualified(n.proc.schema, n.proc.name)}\nClick: open a CALL for it`;
                it.contextValue = 'procedure';
                it.command = { command: 'irisSql.callProcedure', title: 'Call Procedure', arguments: [n] };
                return it;
            }
            case 'msg': {
                const it = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
                it.iconPath = new vscode.ThemeIcon('info');
                it.tooltip = n.tooltip;
                return it;
            }
        }
    }

    async getChildren(n?: Node): Promise<Node[]> {
        if (!n) {
            const list = await this.ensureNamespaces();
            return list.map(ns => ({ t: 'ns', ns }));
        }
        if (n.t === 'ns') {
            const cat = await this.catalog(n.ns);
            if (cat.error) return [{ t: 'msg', text: 'Could not read the catalog', tooltip: cat.error, ns: n.ns }];
            const tables = this.visible(cat.tables).filter(x => x.type !== 'view');
            const views = this.visible(cat.tables).filter(x => x.type === 'view');
            const procs = this.visibleProcs(cat.procs);
            if (this.matcher) {
                const out: Node[] = [];
                if (tables.length) out.push({ t: 'group', ns: n.ns, kind: 'tables', count: tables.length });
                if (views.length) out.push({ t: 'group', ns: n.ns, kind: 'views', count: views.length });
                if (procs.length) out.push({ t: 'group', ns: n.ns, kind: 'procedures', count: procs.length });
                return out.length ? out : [{ t: 'msg', text: `Nothing matches "${this.filter}"` }];
            }
            const out: Node[] = [{ t: 'group', ns: n.ns, kind: 'tables' }];
            if (views.length) out.push({ t: 'group', ns: n.ns, kind: 'views' });
            if (procs.length) out.push({ t: 'group', ns: n.ns, kind: 'procedures' });
            return out;
        }
        if (n.t === 'group') {
            const cat = await this.catalog(n.ns);
            const schemas = new Map<string, number>();
            const add = (s: string) => schemas.set(s, (schemas.get(s) ?? 0) + 1);
            if (n.kind === 'procedures') this.visibleProcs(cat.procs).forEach(p => add(p.schema));
            else this.visible(cat.tables).filter(x => (x.type === 'view') === (n.kind === 'views')).forEach(x => add(x.schema));
            if (!schemas.size) return [{ t: 'msg', text: 'None' }];
            return [...schemas].sort((a, b) => a[0].localeCompare(b[0]))
                .map(([schema, count]) => ({ t: 'schema', ns: n.ns, kind: n.kind, schema, count: this.matcher ? count : undefined }));
        }
        if (n.t === 'schema') {
            const cat = await this.catalog(n.ns);
            if (n.kind === 'procedures') {
                return this.visibleProcs(cat.procs).filter(p => p.schema === n.schema).sort((a, b) => a.name.localeCompare(b.name)).map(proc => ({ t: 'proc', ns: n.ns, proc }));
            }
            return this.visible(cat.tables).filter(x => x.schema === n.schema && (x.type === 'view') === (n.kind === 'views'))
                .sort((a, b) => a.name.localeCompare(b.name)).map(table => ({ t: 'table', ns: n.ns, table }));
        }
        return [];
    }

    // what the settings show, narrowed by the filter
    private visible(tables: TableInfo[]) {
        const all = cfg().get<boolean>('showSystemSchemas', false) ? tables : tables.filter(x => !isSystemSchema(x.schema));
        const m = this.matcher;
        return m ? all.filter(t => tableMatches(m, t)) : all;
    }
    private visibleProcs(p: ProcInfo[]) {
        const all = cfg().get<boolean>('showSystemSchemas', false) ? p : p.filter(x => !isSystemSchema(x.schema));
        const m = this.matcher;
        return m ? all.filter(x => procMatches(m, x)) : all;
    }
}

// ------------------------------------------------------------------------------------------------
// Which namespace a .sql editor runs in: a first line "-- iris: server : NS", else what was picked for it.
// ------------------------------------------------------------------------------------------------

const HEADER_RE = /^\s*--\s*iris:\s*(.+?)\s*$/i;
const docNamespace = new Map<string, string>();     // document uri -> namespace id

function headerOf(doc: vscode.TextDocument): string | undefined {
    if (doc.lineCount === 0) return undefined;
    const m = HEADER_RE.exec(doc.lineAt(0).text);
    return m ? m[1] : undefined;
}

async function namespaceForDoc(tree: SqlTree, doc: vscode.TextDocument, askIfUnknown: boolean): Promise<NamespaceTarget | undefined> {
    const list = await tree.ensureNamespaces();
    const header = headerOf(doc);
    if (header) {
        const norm = header.replace(/\s+/g, '').toLowerCase();
        const hit = list.find(n => n.label.replace(/\s+/g, '').toLowerCase() === norm);
        if (hit) return hit;
    }
    const known = docNamespace.get(doc.uri.toString());
    const hit = known ? list.find(n => n.id === known) : undefined;
    if (hit) return hit;
    if (list.length === 1) return list[0];
    if (!askIfUnknown) return undefined;
    return pickNamespace(tree, doc);
}

async function pickNamespace(tree: SqlTree, doc?: vscode.TextDocument): Promise<NamespaceTarget | undefined> {
    const list = await tree.ensureNamespaces();
    if (!list.length) {
        vscode.window.showWarningMessage('IRIS SQL: no InterSystems namespace in this workspace. Open a server namespace folder first.');
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(list.map(ns => ({ label: ns.label, ns })), { placeHolder: 'Run this query in which namespace?' });
    if (!picked) return undefined;
    if (doc) {
        docNamespace.set(doc.uri.toString(), picked.ns.id);
        // keep it in the file too, so a saved .sql opens on the same namespace next time
        const header = headerOf(doc);
        const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
        if (editor) {
            await editor.edit(b => {
                const line = `-- iris: ${picked.ns.label}`;
                if (header !== undefined) b.replace(doc.lineAt(0).range, line);
                else b.insert(new vscode.Position(0, 0), line + '\n');
            });
        }
    }
    updateStatus(tree);
    return picked.ns;
}

let status: vscode.StatusBarItem;
async function updateStatus(tree: SqlTree) {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'sql') { status.hide(); return; }
    const ns = await namespaceForDoc(tree, ed.document, false);
    status.text = `$(database) ${ns ? ns.label + (loginUserFor(ns) ? ` (as ${loginUserFor(ns)})` : '') : 'IRIS SQL: choose namespace'}`;
    status.tooltip = 'Namespace this query runs in (Ctrl+Enter). Click to change.';
    status.show();
}

async function newQueryDoc(ns: NamespaceTarget | undefined, body: string) {
    const header = ns ? `-- iris: ${ns.label}\n` : '';
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: header + body });
    if (ns) docNamespace.set(doc.uri.toString(), ns.id);
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    const last = doc.lineAt(doc.lineCount - 1);
    ed.selection = new vscode.Selection(last.range.end, last.range.end);
    return ed;
}

// ------------------------------------------------------------------------------------------------
// Running a query and showing the results
// ------------------------------------------------------------------------------------------------

class Results {
    private panel?: vscode.WebviewPanel;
    private ready = false;
    private pending: any[] = [];
    last?: { ns: NamespaceTarget; sql: string; result?: QueryResult };

    constructor(private readonly run: (ns: NamespaceTarget, sql: string) => Promise<void>) {}

    private ensure() {
        if (this.panel) { this.panel.reveal(undefined, true); return; }
        this.ready = false;
        this.panel = vscode.window.createWebviewPanel('irisSql.results', 'IRIS SQL Results',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
        const nonce = crypto.randomBytes(16).toString('hex');
        this.panel.webview.html = resultsHtml(nonce, this.panel.webview.cspSource);
        this.panel.onDidDispose(() => { this.panel = undefined; this.ready = false; });
        this.panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    }

    post(m: any) {
        this.ensure();
        if (this.ready) this.panel!.webview.postMessage(m); else this.pending.push(m);
    }

    private rows(order?: number[]): Record<string, unknown>[] {
        const r = this.last?.result;
        if (!r) return [];
        return Array.isArray(order) ? order.map(i => r.rows[i]).filter(Boolean) : r.rows;
    }

    private async onMessage(m: any) {
        if (m?.type === 'ready') {
            this.ready = true;
            const p = this.pending; this.pending = [];
            p.forEach(x => this.panel!.webview.postMessage(x));
            return;
        }
        const r = this.last?.result;
        if (m?.type === 'rerun' && this.last) { await this.run(this.last.ns, this.last.sql); return; }
        if (m?.type === 'copyValue') { await vscode.env.clipboard.writeText(String(m.value ?? '')); vscode.window.setStatusBarMessage('$(check) Copied value', 1500); return; }
        if (!r) return;
        if (m?.type === 'copy') {
            const sep = m.sep === '\t' ? '\t' : ',';
            await vscode.env.clipboard.writeText(toCsv(r.columns, this.rows(m.order), sep));
            vscode.window.setStatusBarMessage(`$(check) Copied ${this.rows(m.order).length} rows`, 2000);
        } else if (m?.type === 'save') {
            const uri = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, saveLabel: 'Save CSV' });
            if (!uri) return;
            // BOM so Excel reads Hebrew / UTF-8 correctly
            await vscode.workspace.fs.writeFile(uri, Buffer.from('﻿' + toCsv(r.columns, this.rows(m.order)), 'utf8'));
            vscode.window.showInformationMessage(`IRIS SQL: saved ${this.rows(m.order).length} rows to ${uri.fsPath}`);
        } else if (m?.type === 'json') {
            const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(this.rows(m.order), null, 2) });
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });
        }
    }
}

export function activate(context: vscode.ExtensionContext) {
    output = vscode.window.createOutputChannel('IRIS SQL');
    setLog(log);
    setStore(context.globalState);
    const tree = new SqlTree();
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    status.command = 'irisSql.pickNamespace';

    let running = false;
    const run = async (ns: NamespaceTarget, sqlIn: string) => {
        const sql = normalizeStatement(sqlIn);
        if (!sql) { vscode.window.showInformationMessage('IRIS SQL: nothing to run.'); return; }
        if (running) { vscode.window.showInformationMessage('IRIS SQL: a query is still running.'); return; }
        if (cfg().get<boolean>('confirmWrites', true) && !isReadOnly(sql)) {
            const kw = firstKeyword(sql) || 'This statement';
            const ok = await vscode.window.showWarningMessage(`${kw} can change data or definitions. Run it on ${ns.label}?`, { modal: true }, 'Run');
            if (ok !== 'Run') return;
        }
        running = true;
        results.last = { ns, sql };
        const where = () => ns.label + (loginUserFor(ns) ? ` (as ${loginUserFor(ns)})` : '');
        results.post({ type: 'running', where: where(), sql });
        log(`Running on ${ns.label}: ${sql.replace(/\s+/g, ' ').slice(0, 300)}`);
        try {
            const r = await withLogin<QueryResult>(ns, async c => {
                const signal: QueryOptions['signal'] = { cancelled: false };
                return await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `IRIS SQL: running on ${ns.label}`, cancellable: true },
                    async (_p, token) => {
                        token.onCancellationRequested(() => { signal.cancelled = true; signal.onCancel?.(); });
                        return runQuery(c, sql, [], queryOptions(signal));
                    });
            });
            if (!r) { results.post({ type: 'error', where: where(), sql, message: 'Not run: no password was given.' }); return; }
            results.last = { ns, sql, result: r };
            log(`  ${r.rows.length} rows, ${r.ms} ms`);
            results.post({ type: 'result', where: where(), sql, columns: r.columns, rows: r.rows, ms: r.ms, maxShown: Math.max(1, cfg().get<number>('maxRowsShown', 2000)) });
        } catch (e: any) {
            log('  FAILED: ' + (e?.message || e));
            results.post({ type: 'error', where: where(), sql, message: e?.message || String(e) });
        } finally {
            running = false;
        }
    };
    const results = new Results(run);

    const view = vscode.window.createTreeView('irisSql.tree', { treeDataProvider: tree, showCollapseAll: true });
    const applyFilter = (text: string) => {
        tree.setFilter(text);
        view.description = tree.filter ? `filter: ${tree.filter}` : undefined;
        void vscode.commands.executeCommand('setContext', 'irisSql.filtered', !!tree.filter);
    };

    const withConn = async (n: Node | undefined, fn: (c: Connection, ns: NamespaceTarget) => Promise<void>) => {
        if (!n || !('ns' in n) || !n.ns) return;
        const ns = n.ns;
        try { await withLogin(ns, c => fn(c, ns)); } catch (e: any) { vscode.window.showErrorMessage('IRIS SQL: ' + (e?.message || e)); }
    };

    context.subscriptions.push(
        output, status,
        view,
        vscode.commands.registerCommand('irisSql.filter', () => {
            // live: the tree narrows as you type; Enter or Esc closes the box and keeps the filter
            const box = vscode.window.createInputBox();
            box.title = 'Filter tables, views and procedures';
            box.placeholder = 'Part of a table, schema or class name  ·  * and ? are wildcards  ·  empty = show all';
            box.value = tree.filter;
            let timer: NodeJS.Timeout | undefined;
            box.onDidChangeValue(v => { if (timer) clearTimeout(timer); timer = setTimeout(() => applyFilter(v), 200); });
            box.onDidAccept(() => { if (timer) clearTimeout(timer); applyFilter(box.value); box.hide(); });
            box.onDidHide(() => box.dispose());
            box.show();
        }),
        vscode.commands.registerCommand('irisSql.clearFilter', () => applyFilter('')),
        vscode.commands.registerCommand('irisSql.refresh', () => { forgetSessions(); tree.refresh(); }),
        vscode.commands.registerCommand('irisSql.forgetPassword', () => { forgetTypedPasswords(); forgetSessions(); tree.refresh(); }),
        vscode.commands.registerCommand('irisSql.signInAs', async (n?: Node) => {
            let ns = n && n.t === 'ns' ? n.ns : undefined;
            if (!ns) ns = await pickNamespace(tree);
            if (ns && await signInAs(ns)) { tree.refreshNamespace(ns); updateStatus(tree); }
        }),
        vscode.commands.registerCommand('irisSql.useDefaultLogin', async (n?: Node) => {
            if (!n || n.t !== 'ns') return;
            await useDefaultLogin(n.ns);
            tree.refreshNamespace(n.ns);
            updateStatus(tree);
        }),

        vscode.commands.registerCommand('irisSql.newQuery', async (n?: Node) => {
            let ns = n && n.t === 'ns' ? n.ns : undefined;
            if (!ns) {
                const list = await tree.ensureNamespaces();
                ns = list.length === 1 ? list[0] : await pickNamespace(tree);
                if (!ns) return;
            }
            await newQueryDoc(ns, '\nSELECT TOP 100 *\nFROM ');
        }),

        vscode.commands.registerCommand('irisSql.runQuery', async () => {
            const ed = vscode.window.activeTextEditor;
            if (!ed) return;
            const ns = await namespaceForDoc(tree, ed.document, true);
            if (!ns) return;
            let sql: string;
            if (!ed.selection.isEmpty) sql = ed.document.getText(ed.selection);
            else {
                const st = statementAt(ed.document.getText(), ed.selection.active.line);
                sql = st.text;
                // briefly show which statement runs
                const range = new vscode.Range(st.startLine, 0, st.endLine, ed.document.lineAt(st.endLine).text.length);
                const deco = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground') });
                ed.setDecorations(deco, [range]);
                setTimeout(() => deco.dispose(), 600);
            }
            // the "-- iris:" header is a comment line; drop comment-only lines at the top
            sql = sql.split(/\r?\n/).filter((l, i, a) => !(HEADER_RE.test(l) && a.slice(0, i).every(x => x.trim() === ''))).join('\n');
            await run(ns, sql);
        }),

        vscode.commands.registerCommand('irisSql.pickNamespace', async () => {
            const ed = vscode.window.activeTextEditor;
            await pickNamespace(tree, ed && ed.document.languageId === 'sql' ? ed.document : undefined);
        }),

        vscode.commands.registerCommand('irisSql.selectTop', async (n?: Node) => {
            if (!n || n.t !== 'table') return;
            await run(n.ns, `SELECT TOP ${Math.max(1, cfg().get<number>('topRows', 100))} * FROM ${qualified(n.table.schema, n.table.name)}`);
        }),
        vscode.commands.registerCommand('irisSql.countRows', async (n?: Node) => {
            if (!n || n.t !== 'table') return;
            await run(n.ns, `SELECT COUNT(*) AS "Rows" FROM ${qualified(n.table.schema, n.table.name)}`);
        }),
        vscode.commands.registerCommand('irisSql.showColumns', (n?: Node) => withConn(n, async (c, ns) => {
            if (!n || n.t !== 'table') return;
            const sql = `-- columns of ${qualified(n.table.schema, n.table.name)}`;
            results.post({ type: 'running', where: ns.label, sql });
            const { raw } = await listColumns(c, n.table, queryOptions());
            results.last = { ns, sql: `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = '${n.table.schema.replace(/'/g, "''")}' AND TABLE_NAME = '${n.table.name.replace(/'/g, "''")}' ORDER BY ORDINAL_POSITION`, result: raw };
            results.post({ type: 'result', where: ns.label, sql, columns: raw.columns, rows: raw.rows, ms: raw.ms, maxShown: 100000 });
        })),
        vscode.commands.registerCommand('irisSql.queryFromTable', async (n?: Node) => {
            if (!n || n.t !== 'table') return;
            await newQueryDoc(n.ns, `\nSELECT TOP 100 *\nFROM ${qualified(n.table.schema, n.table.name)}\nWHERE `);
        }),
        vscode.commands.registerCommand('irisSql.openClass', async (n?: Node) => {
            if (!n || n.t !== 'table') return;
            if (!n.table.className) { vscode.window.showInformationMessage('IRIS SQL: the server did not say which class this table comes from.'); return; }
            const uri = classUri(n.ns, n.table.className);
            if (!uri) return;
            try { await vscode.window.showTextDocument(uri, { preview: false }); }
            catch (e: any) { vscode.window.showErrorMessage(`IRIS SQL: could not open ${n.table.className}: ${e?.message || e}`); }
        }),
        vscode.commands.registerCommand('irisSql.copyName', async (n?: Node) => {
            if (!n) return;
            const name = n.t === 'table' ? qualified(n.table.schema, n.table.name) : n.t === 'proc' ? qualified(n.proc.schema, n.proc.name) : '';
            if (name) { await vscode.env.clipboard.writeText(name); vscode.window.setStatusBarMessage(`$(check) Copied ${name}`, 2000); }
        }),
        vscode.commands.registerCommand('irisSql.callProcedure', (n?: Node) => withConn(n, async (c, ns) => {
            if (!n || n.t !== 'proc') return;
            const params = await listProcParams(c, n.proc, queryOptions());
            await newQueryDoc(ns, '\n' + callTemplate(n.proc, params));
        })),

        vscode.window.onDidChangeActiveTextEditor(() => updateStatus(tree)),
        vscode.workspace.onDidChangeWorkspaceFolders(() => { tree.refresh(); updateStatus(tree); }),
        vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('irisSql.showSystemSchemas')) tree.refresh(); })
    );
    updateStatus(tree);
}

export function deactivate() { /* nothing */ }
