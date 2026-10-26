import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Connection, QueryOptions, QueryResult, endSession, forgetSessions, isReadOnly, firstKeyword, normalizeStatement, qualified, runQuery, statementAt, toCsv } from './atelier';
import { NamespaceTarget, classUri, currentConnection, findNamespaces, forgetTypedPasswords, loginUserFor, setLog, setLoginUser, setStore, signInAs, usedUsersFor, useDefaultLogin, withLogin } from './connections';
import { Matcher, ProcInfo, TableInfo, callTemplate, isSystemSchema, listColumns, listProcParams, listProcedures, listTables, makeMatcher, procMatches, tableMatches } from './catalog';
import { resultsHtml } from './resultsHtml';
import { Op, QueryState, Val, buildSql, cleanSql, condLabel, condSql, newCondition } from './queryBuilder';

let output: vscode.OutputChannel;
function log(s: string) { output.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`); }

function cfg() { return vscode.workspace.getConfiguration('irisSql'); }

/** What a click on a table runs: every row (irisSql.topRows = 0, the default), or the first N. */
/** The first or last N rows of a table, by row id (%ID: the order rows were added in). */
function topBottomSql(t: TableInfo, n: number, last: boolean): string {
    return `SELECT TOP ${n} * FROM ${qualified(t.schema, t.name)} ORDER BY %ID ${last ? 'DESC' : 'ASC'}`;
}

function selectSql(t: TableInfo): string {
    const n = Math.floor(Number(cfg().get<number>('topRows', 0)) || 0);
    return `SELECT ${n > 0 ? `TOP ${n} ` : ''}* FROM ${qualified(t.schema, t.name)}`;
}
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

    // ---- the one namespace the tree shows (Choose Namespace...) ----
    chosenId: string | undefined;
    /** The namespace list read again from the workspace (a folder added since shows up), tables kept. */
    async reloadNamespaces(): Promise<NamespaceTarget[]> { this.loaded = undefined; return this.ensureNamespaces(); }
    chosen(): NamespaceTarget | undefined { return this.namespaces.find(n => n.id === this.chosenId); }
    choose(ns: NamespaceTarget | undefined) { this.chosenId = ns?.id; this.emitter.fire(); }

    // ---- filter, per namespace: only matching tables / views / procedures, with the groups above them opened ----
    // Each namespace has its own filter, so filtering one never loads (or asks a login for) another.
    private filters = new Map<string, { text: string; m: Matcher }>();
    private loadedIds = new Set<string>();           // namespaces whose tables have been read
    filterOf(ns: NamespaceTarget): string { return this.filters.get(ns.id)?.text ?? ''; }
    isLoaded(ns: NamespaceTarget): boolean { return this.loadedIds.has(ns.id); }
    /** Namespaces with a filter on, and their filters. */
    activeFilters(): { ns: NamespaceTarget; text: string }[] {
        return this.namespaces.filter(n => this.filters.has(n.id)).map(n => ({ ns: n, text: this.filters.get(n.id)!.text }));
    }
    setFilter(ns: NamespaceTarget, text: string) {
        const m = makeMatcher(text);
        if (m) this.filters.set(ns.id, { text: text.trim(), m }); else this.filters.delete(ns.id);
        this.emitter.fire();
    }
    clearFilters() { this.filters.clear(); this.emitter.fire(); }
    private matcherOf(ns: NamespaceTarget): Matcher | undefined { return this.filters.get(ns.id)?.m; }
    /** Item ids change with the filter, so a filtered namespace opens with its matches showing (and closes again after). */
    private fid(ns: NamespaceTarget, base: string) { const f = this.filterOf(ns); return f ? `${base}|f:${f}` : base; }
    private openWhenFiltered(ns: NamespaceTarget): vscode.TreeItemCollapsibleState {
        return this.matcherOf(ns) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    }
    private label(ns: NamespaceTarget, text: string): vscode.TreeItemLabel | string {
        const hit = this.matcherOf(ns)?.(text);
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
                // a namespace with a filter of its own opens with its matches showing
                const other = loginUserFor(n.ns);
                const it = new vscode.TreeItem(n.ns.label, vscode.TreeItemCollapsibleState.Expanded);
                it.id = this.fid(n.ns, `${n.ns.id}|as:${other ?? ''}`);
                const filter = this.filterOf(n.ns);
                it.iconPath = new vscode.ThemeIcon(other ? 'account' : 'server');
                it.description = [other ? `as ${other}` : '', filter ? `filter: ${filter}` : ''].filter(Boolean).join(' · ') || undefined;
                it.contextValue = (other ? 'namespaceOther' : 'namespace') + (filter ? 'Filtered' : '');
                it.tooltip = `${n.ns.label}\n${n.ns.conn ? `${n.ns.conn.scheme}://${n.ns.conn.host}:${n.ns.conn.port}${n.ns.conn.pathPrefix}` : 'no server address'}\n` +
                    (other ? `Signed in as ${other} (right-click > Use Default Login to go back)` : `Signed in as ${n.ns.conn?.username || '?'} (right-click > Sign in as Another User...)`);
                return it;
            }
            case 'group': {
                const label = n.kind === 'tables' ? 'Tables' : n.kind === 'views' ? 'Views' : 'Procedures';
                const it = new vscode.TreeItem(label, this.openWhenFiltered(n.ns));
                it.id = this.fid(n.ns, `${n.ns.id}|${n.kind}`);
                if (n.count !== undefined) it.description = String(n.count);
                it.iconPath = new vscode.ThemeIcon(n.kind === 'procedures' ? 'symbol-method' : n.kind === 'views' ? 'eye' : 'table');
                return it;
            }
            case 'schema': {
                const it = new vscode.TreeItem(this.label(n.ns, n.schema), this.openWhenFiltered(n.ns));
                it.id = this.fid(n.ns, `${n.ns.id}|${n.kind}|${n.schema}`);
                if (n.count !== undefined) it.description = String(n.count);
                it.iconPath = new vscode.ThemeIcon('symbol-namespace');
                return it;
            }
            case 'table': {
                const it = new vscode.TreeItem(this.label(n.ns, n.table.name), vscode.TreeItemCollapsibleState.None);
                it.iconPath = new vscode.ThemeIcon(n.table.type === 'view' ? 'eye' : 'table');
                it.description = n.table.className && n.table.className.split('.').pop() !== n.table.name ? n.table.className : undefined;
                it.tooltip = `${qualified(n.table.schema, n.table.name)}${n.table.className ? '\nclass ' + n.table.className : ''}\nClick: ${selectSql(n.table).replace(/ FROM .*/, '')}`;
                it.contextValue = n.table.type === 'view' ? 'tableView' : 'table';
                it.command = { command: 'irisSql.selectTop', title: 'Select Rows', arguments: [n] };
                return it;
            }
            case 'proc': {
                const it = new vscode.TreeItem(this.label(n.ns, n.proc.name), vscode.TreeItemCollapsibleState.None);
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
            // only the chosen namespace; nothing chosen yet: empty, so the welcome text with its button shows
            const list = await this.ensureNamespaces();
            const ns = list.find(x => x.id === this.chosenId);
            return ns ? [{ t: 'ns', ns }] : [];
        }
        if (n.t === 'ns') {
            const cat = await this.catalog(n.ns);
            if (cat.error) return [{ t: 'msg', text: 'Could not read the catalog', tooltip: cat.error, ns: n.ns }];
            const tables = this.visible(n.ns, cat.tables).filter(x => x.type !== 'view');
            const views = this.visible(n.ns, cat.tables).filter(x => x.type === 'view');
            const procs = this.visibleProcs(n.ns, cat.procs);
            if (this.matcherOf(n.ns)) {
                const out: Node[] = [];
                if (tables.length) out.push({ t: 'group', ns: n.ns, kind: 'tables', count: tables.length });
                if (views.length) out.push({ t: 'group', ns: n.ns, kind: 'views', count: views.length });
                if (procs.length) out.push({ t: 'group', ns: n.ns, kind: 'procedures', count: procs.length });
                return out.length ? out : [{ t: 'msg', text: `Nothing matches "${this.filterOf(n.ns)}"` }];
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
            if (n.kind === 'procedures') this.visibleProcs(n.ns, cat.procs).forEach(p => add(p.schema));
            else this.visible(n.ns, cat.tables).filter(x => (x.type === 'view') === (n.kind === 'views')).forEach(x => add(x.schema));
            if (!schemas.size) return [{ t: 'msg', text: 'None' }];
            return [...schemas].sort((a, b) => a[0].localeCompare(b[0]))
                .map(([schema, count]) => ({ t: 'schema', ns: n.ns, kind: n.kind, schema, count: this.matcherOf(n.ns) ? count : undefined }));
        }
        if (n.t === 'schema') {
            const cat = await this.catalog(n.ns);
            if (n.kind === 'procedures') {
                return this.visibleProcs(n.ns, cat.procs).filter(p => p.schema === n.schema).sort((a, b) => a.name.localeCompare(b.name)).map(proc => ({ t: 'proc', ns: n.ns, proc }));
            }
            return this.visible(n.ns, cat.tables).filter(x => x.schema === n.schema && (x.type === 'view') === (n.kind === 'views'))
                .sort((a, b) => a.name.localeCompare(b.name)).map(table => ({ t: 'table', ns: n.ns, table }));
        }
        return [];
    }

    // what the settings show, narrowed by the filter
    private visible(ns: NamespaceTarget, tables: TableInfo[]) {
        const all = cfg().get<boolean>('showSystemSchemas', false) ? tables : tables.filter(x => !isSystemSchema(x.schema));
        const m = this.matcherOf(ns);
        return m ? all.filter(t => tableMatches(m, t)) : all;
    }
    private visibleProcs(ns: NamespaceTarget, p: ProcInfo[]) {
        const all = cfg().get<boolean>('showSystemSchemas', false) ? p : p.filter(x => !isSystemSchema(x.schema));
        const m = this.matcherOf(ns);
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

type HistoryEntry = { ns: NamespaceTarget; state: QueryState; sql: string; where: string; at: number };
type RunView = { state: QueryState; push: boolean; pos?: number };
const HISTORY_MAX = 50;

/** The results tab: the rows, the query state behind them (base SQL + conditions / sort / count by) and Back / Forward. */
class Results {
    private panel?: vscode.WebviewPanel;
    private ready = false;
    private pending: any[] = [];
    last?: { ns: NamespaceTarget; sql: string; result?: QueryResult };
    private state?: QueryState;
    private history: HistoryEntry[] = [];
    private pos = -1;

    constructor(private readonly extensionUri: vscode.Uri,
                private readonly run: (ns: NamespaceTarget, sql: string, view?: RunView) => Promise<void>,
                private readonly toEditor: (ns: NamespaceTarget, sql: string) => Promise<unknown>) {}

    private ensure() {
        if (this.panel) { this.panel.reveal(undefined, true); return; }
        this.ready = false;
        const media = vscode.Uri.joinPath(this.extensionUri, 'media');
        this.panel = vscode.window.createWebviewPanel('irisSql.results', 'IRIS SQL Results',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
        const w = this.panel.webview;
        const nonce = crypto.randomBytes(16).toString('hex');
        w.html = resultsHtml(nonce, w.cspSource,
            w.asWebviewUri(vscode.Uri.joinPath(media, 'results.js')).toString(),
            w.asWebviewUri(vscode.Uri.joinPath(media, 'results.css')).toString());
        this.panel.onDidDispose(() => { this.panel = undefined; this.ready = false; this.pending = []; });
        w.onDidReceiveMessage(m => this.onMessage(m));
    }

    post(m: any) {
        this.ensure();
        if (this.ready) this.panel!.webview.postMessage(m); else this.pending.push(m);
    }

    /** A query is about to run: it becomes the current one (and a new history entry, unless Back / Forward / refresh). */
    begin(ns: NamespaceTarget, state: QueryState, push: boolean, pos?: number) {
        this.state = state;
        const entry = (): HistoryEntry => ({
            ns, state: clone(state), sql: buildSql(state).sql,
            where: ns.label + (loginUserFor(ns) ? ` (as ${loginUserFor(ns)})` : ''), at: Date.now()
        });
        if (pos !== undefined && this.history[pos]) { this.pos = pos; this.history[pos].at = Date.now(); return; }
        if (push) {
            this.history = this.history.slice(0, this.pos + 1);
            this.history.push(entry());
            if (this.history.length > HISTORY_MAX) this.history.shift();
            this.pos = this.history.length - 1;
        } else if (this.pos >= 0 && this.history[this.pos]) {
            this.history[this.pos] = entry();
        }
    }

    /** A result came back: with * (no column choice, no count) its columns are the ones the Columns box offers. */
    noteColumns(columns: string[]) {
        const st = this.state;
        if (!st || st.group || st.cols?.length) return;
        st.allCols = columns.slice();
        const h = this.history[this.pos];
        if (h) h.state.allCols = columns.slice();
    }

    /** Clear Query History: forgets every query but the one shown now. */
    clearHistory() {
        const cur = this.history[this.pos];
        this.history = cur ? [cur] : [];
        this.pos = cur ? 0 : -1;
        if (this.panel) this.post({ type: 'state', ...this.stateMsg() });
    }

    /** What the page needs to draw the chips and the Back / Forward buttons. */
    stateMsg() {
        const st = this.state;
        return {
            state: {
                conds: (st?.conds ?? []).map(c => ({ ...c, label: condLabel(c) })),
                sort: st?.sort ?? null,
                group: st?.group ?? null,
                cols: st?.cols ?? [],
                allCols: st?.allCols ?? []
            },
            canBack: this.pos > 0,
            canForward: this.pos >= 0 && this.pos < this.history.length - 1,
            // newest first, for the history list next to the arrows
            history: this.history.map((h, i) => ({ i, sql: h.sql, where: h.where, at: h.at, current: i === this.pos })).reverse()
        };
    }

    private rows(order?: number[]): Record<string, unknown>[] {
        const r = this.last?.result;
        if (!r) return [];
        return Array.isArray(order) ? order.map(i => r.rows[i]).filter(Boolean) : r.rows;
    }
    /** The columns the page shows, in its order (hidden ones left out); all of them if it sent none. */
    private cols(m: any): string[] {
        const all = this.last?.result?.columns ?? [];
        const want = Array.isArray(m?.columns) ? m.columns.filter((c: unknown) => typeof c === 'string' && all.includes(c)) : [];
        return want.length ? want : all;
    }

    /** Runs the current state changed by fn (a new history entry). */
    private async change(fn: (st: QueryState) => void) {
        if (!this.last || !this.state) return;
        const st = clone(this.state);
        fn(st);
        await this.runState(st, true);
    }
    private async runState(st: QueryState, push: boolean) {
        if (!this.last) return;
        const built = buildSql(st);
        if (built.error) { vscode.window.showWarningMessage('IRIS SQL: ' + built.error); return; }
        await this.run(this.last.ns, built.sql, { state: st, push });
    }

    private async onMessage(m: any) {
        if (m?.type === 'ready') {
            this.ready = true;
            const p = this.pending; this.pending = [];
            p.forEach(x => this.panel!.webview.postMessage(x));
            return;
        }
        if (m?.type === 'copyValue') { await vscode.env.clipboard.writeText(String(m.value ?? '')); vscode.window.setStatusBarMessage('$(check) Copied', 1500); return; }
        if (m?.type === 'copyCondition' && OPS.includes(m.op) && typeof m.col === 'string') {
            await vscode.env.clipboard.writeText(condSql(newCondition(m.col, m.op, val(m.value), val(m.value2))));
            vscode.window.setStatusBarMessage('$(check) Copied condition', 1500);
            return;
        }
        if (!this.last) return;
        const ns = this.last.ns;
        switch (m?.type) {
            case 'rerun': {
                const sql = typeof m.sql === 'string' && m.sql.trim() ? m.sql : this.last.sql;
                // the query as built: run it again (refresh); edited: it becomes the new base, the chips fold into it
                if (this.state && norm(sql) === norm(this.last.sql)) await this.runState(this.state, false);
                else await this.run(ns, sql);
                return;
            }
            case 'toEditor': await this.toEditor(ns, String(m.sql ?? this.last.sql)); return;
            case 'clearHistory': this.clearHistory(); return;
            case 'back': case 'forward': case 'goto': {
                const to = m.type === 'goto' ? Number(m.index) : this.pos + (m.type === 'back' ? -1 : 1);
                const h = this.history[to];
                if (!h) return;
                await this.run(h.ns, buildSql(h.state).sql, { state: clone(h.state), push: false, pos: to });
                return;
            }
            case 'addCond':
                if (typeof m.col !== 'string' || !OPS.includes(m.op)) return;
                await this.change(st => { st.conds.push(newCondition(m.col, m.op, val(m.value), val(m.value2))); });
                return;
            case 'editCond':
                if (!OPS.includes(m.op)) return;
                await this.change(st => {
                    const c = st.conds.find(x => x.id === m.id);
                    if (c) { c.op = m.op; c.value = val(m.value); c.value2 = val(m.value2); c.enabled = true; }
                });
                return;
            case 'removeCond': await this.change(st => { st.conds = st.conds.filter(x => x.id !== m.id); }); return;
            case 'toggleCond': await this.change(st => { const c = st.conds.find(x => x.id === m.id); if (c) c.enabled = !c.enabled; }); return;
            case 'sort':
                if (typeof m.col !== 'string') return;
                await this.change(st => { st.sort = { col: m.col, dir: m.dir === 'DESC' ? 'DESC' : 'ASC' }; st.group = undefined; });
                return;
            case 'clearSort': await this.change(st => { st.sort = undefined; }); return;
            case 'setCols': {
                // Run with these: every column (or none) checked = back to *
                const all = this.state?.allCols ?? this.last.result?.columns ?? [];
                const cols: string[] = Array.isArray(m.cols) ? m.cols.filter((c: unknown) => typeof c === 'string') : [];
                await this.change(st => { st.cols = cols.length && !(cols.length >= all.length && all.every(c => cols.includes(c))) ? cols : undefined; });
                return;
            }
            case 'countBy':
                if (typeof m.col !== 'string') return;
                await this.change(st => { st.group = m.col; st.sort = undefined; });
                return;
            case 'clearGroup': await this.change(st => { st.group = undefined; }); return;
            case 'drill':
                if (typeof m.col !== 'string') return;
                await this.change(st => {
                    const v = val(m.value);
                    st.conds.push(newCondition(m.col, v === null ? 'isNull' : 'eq', v === null ? undefined : v));
                    st.group = undefined;
                });
                return;
        }
        const r = this.last.result;
        if (!r) return;
        if (m?.type === 'copy') {
            const sep = m.sep === '\t' ? '\t' : ',';
            await vscode.env.clipboard.writeText(toCsv(this.cols(m), this.rows(m.order), sep));
            vscode.window.setStatusBarMessage(`$(check) Copied ${this.rows(m.order).length} rows`, 2000);
        } else if (m?.type === 'save') {
            const uri = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, saveLabel: 'Save CSV' });
            if (!uri) return;
            // BOM so Excel reads Hebrew / UTF-8 correctly
            await vscode.workspace.fs.writeFile(uri, Buffer.from('﻿' + toCsv(this.cols(m), this.rows(m.order)), 'utf8'));
            vscode.window.showInformationMessage(`IRIS SQL: saved ${this.rows(m.order).length} rows to ${uri.fsPath}`);
        } else if (m?.type === 'json') {
            const cols = this.cols(m);
            const rows = this.rows(m.order).map(row => Object.fromEntries(cols.map(c => [c, row[c]])));
            const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(rows, null, 2) });
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });
        }
    }
}

const OPS: Op[] = ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between', 'contains', 'notContains', 'startsWith', 'isNull', 'notNull', 'onDay'];
const clone = (st: QueryState): QueryState => JSON.parse(JSON.stringify(st));
const norm = (s: string) => cleanSql(s).replace(/\s+/g, ' ').trim();
/** A value from the page: only the JSON kinds a grid cell can have. */
function val(v: unknown): Val | undefined {
    if (v === undefined) return undefined;
    return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
}

export function activate(context: vscode.ExtensionContext) {
    output = vscode.window.createOutputChannel('IRIS SQL');
    setLog(log);
    setStore(context.globalState);
    const tree = new SqlTree();
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    status.command = 'irisSql.pickNamespace';

    let running = false;
    const run = async (ns: NamespaceTarget, sqlIn: string, view?: RunView) => {
        const sql = normalizeStatement(sqlIn);
        if (!sql) { vscode.window.showInformationMessage('IRIS SQL: nothing to run.'); return; }
        if (running) { vscode.window.showInformationMessage('IRIS SQL: a query is still running.'); return; }
        if (cfg().get<boolean>('confirmWrites', true) && !isReadOnly(sql)) {
            const kw = firstKeyword(sql) || 'This statement';
            const ok = await vscode.window.showWarningMessage(`${kw} can change data or definitions. Run it on ${ns.label}?`, { modal: true }, 'Run');
            if (ok !== 'Run') return;
        }
        running = true;
        results.begin(ns, view?.state ?? { base: sql, conds: [] }, view ? view.push : true, view?.pos);
        results.last = { ns, sql };
        const where = () => ns.label + (loginUserFor(ns) ? ` (as ${loginUserFor(ns)})` : '');
        results.post({ type: 'running', where: where(), sql, ...results.stateMsg() });
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
            if (!r) { results.post({ type: 'error', where: where(), sql, message: 'Not run: no password was given.', ...results.stateMsg() }); return; }
            results.last = { ns, sql, result: r };
            results.noteColumns(r.columns);
            log(`  ${r.rows.length} rows, ${r.ms} ms`);
            results.post({ type: 'result', where: where(), sql, columns: r.columns, rows: r.rows, ms: r.ms, maxShown: Math.max(1, cfg().get<number>('maxRowsShown', 2000)), ...results.stateMsg() });
        } catch (e: any) {
            log('  FAILED: ' + (e?.message || e));
            results.post({ type: 'error', where: where(), sql, message: e?.message || String(e), ...results.stateMsg() });
        } finally {
            running = false;
        }
    };
    const results = new Results(context.extensionUri, run, (ns, sql) => newQueryDoc(ns, '\n' + sql.trim()));

    const view = vscode.window.createTreeView('irisSql.tree', { treeDataProvider: tree, showCollapseAll: true });
    // the title shows what is filtered; the title-bar funnel turns filled while anything is
    const filtersChanged = () => showTitle();
    /** The filter box for some namespaces (live: the tree narrows as you type; Enter / Esc close it and keep it). */
    const openFilterBox = (targets: NamespaceTarget[]) => {
        if (!targets.length) return;
        const box = vscode.window.createInputBox();
        box.title = targets.length === 1 ? `Filter ${targets[0].label}` : `Filter ${targets.length} namespaces`;
        box.placeholder = 'Part of a table, schema or class name  ·  * and ? are wildcards  ·  empty = show all';
        box.value = tree.filterOf(targets[0]);
        let timer: NodeJS.Timeout | undefined;
        const apply = (v: string) => { for (const ns of targets) tree.setFilter(ns, v); filtersChanged(); };
        box.onDidChangeValue(v => { if (timer) clearTimeout(timer); timer = setTimeout(() => apply(v), 200); });
        box.onDidAccept(() => { if (timer) clearTimeout(timer); apply(box.value); box.hide(); });
        box.onDidHide(() => box.dispose());
        box.show();
    };

    // ---- Choose Namespace...: which namespace the tree shows, and with which login ----
    const CHOSEN_KEY = 'irisSql.chosenNamespace';
    const showTitle = () => {
        const ns = tree.chosen();
        const f = ns ? tree.filterOf(ns) : '';
        view.title = 'Namespace';
        view.description = ns ? `${ns.namespace}${loginUserFor(ns) ? ' as ' + loginUserFor(ns) : ''}${f ? ' · filter: ' + f : ''}` : undefined;
        void vscode.commands.executeCommand('setContext', 'irisSql.filtered', !!f);
    };
    /** Ends the server session of what the tree showed before (it would hold a license until the server's timeout). */
    const endPrevious = async (ns: NamespaceTarget | undefined) => {
        if (!ns) return;
        const c = await currentConnection(ns);
        if (c) { await endSession(c, queryOptions()); log(`Ended the session of ${c.username} on ${ns.label}`); }
    };
    const chooseNamespace = async (): Promise<boolean> => {
        const list = await tree.reloadNamespaces();          // read again: a namespace folder added since is listed
        if (!list.length) {
            vscode.window.showWarningMessage('IRIS SQL: no InterSystems namespace is open in this workspace. Open a server namespace folder first.');
            return false;
        }
        const current = tree.chosen();
        type NsItem = vscode.QuickPickItem & { ns: NamespaceTarget };
        const nsPick = await vscode.window.showQuickPick<NsItem>(list.map(ns => ({
            label: `${ns.id === current?.id ? '$(check) ' : ''}${ns.label}`,
            description: [ns.id === current?.id ? 'shown now' : '', loginUserFor(ns) ? `last as ${loginUserFor(ns)}` : ''].filter(Boolean).join(' · '),
            ns
        })), { title: 'IRIS SQL: Choose Namespace (1/2)', placeHolder: 'Which namespace should the tree show?' });
        if (!nsPick) return false;
        const ns = nsPick.ns;

        type LoginItem = vscode.QuickPickItem & { user?: string; other?: boolean };
        const assigned = ns.conn?.username || 'the connection user';
        const now = loginUserFor(ns);
        const items: LoginItem[] = [
            { label: `$(server) ${assigned}`, description: "the namespace's assigned user" + (!now ? ' · current' : ''), user: undefined }
        ];
        for (const u of usedUsersFor(ns)) items.push({ label: `$(account) ${u}`, description: 'signed in with before' + (now === u ? ' · current' : ''), user: u });
        items.push({ label: '$(add) Sign in as another user...', other: true });
        const loginPick = await vscode.window.showQuickPick<LoginItem>(items, {
            title: `IRIS SQL: Choose Namespace (2/2) - ${ns.label}`, placeHolder: 'Sign in as which user?'
        });
        if (!loginPick) return false;

        const prev = tree.chosen();
        const prevUser = prev ? loginUserFor(prev) : undefined;
        const prevConn = prev ? await currentConnection(prev) : undefined;   // before the login changes
        if (loginPick.other) {
            if (!(await signInAs(ns))) return false;
        } else if (loginPick.user) {
            await setLoginUser(ns, loginPick.user);             // its password is asked when the tables load, if needed
        } else {
            await setLoginUser(ns, undefined);
        }
        // a different namespace or user than before: end the old server session
        if (prev && prevConn && (prev.id !== ns.id || prevUser !== loginUserFor(ns))) {
            await endSession(prevConn, queryOptions());
            log(`Ended the session of ${prevConn.username} on ${prev.label}`);
        }
        tree.choose(ns);
        tree.refreshNamespace(ns);                                 // tables read again with this login
        await context.workspaceState.update(CHOSEN_KEY, ns.id);
        showTitle();
        updateStatus(tree);
        return true;
    };
    // the namespace chosen last time in this workspace (its tables load when shown)
    tree.chosenId = context.workspaceState.get<string>(CHOSEN_KEY);
    void tree.ensureNamespaces().then(showTitle);

    const withConn = async (n: Node | undefined, fn: (c: Connection, ns: NamespaceTarget) => Promise<void>) => {
        if (!n || !('ns' in n) || !n.ns) return;
        const ns = n.ns;
        try { await withLogin(ns, c => fn(c, ns)); } catch (e: any) { vscode.window.showErrorMessage('IRIS SQL: ' + (e?.message || e)); }
    };

    context.subscriptions.push(
        output, status,
        view,
        // title-bar funnel: the namespace the tree shows (none chosen yet: choose one first)
        vscode.commands.registerCommand('irisSql.filter', async () => {
            const ns = tree.chosen();
            if (ns) { openFilterBox([ns]); return; }
            if (await chooseNamespace()) { const c = tree.chosen(); if (c) openFilterBox([c]); }
        }),
        vscode.commands.registerCommand('irisSql.chooseNamespace', () => chooseNamespace()),
        vscode.commands.registerCommand('irisSql.filterNamespace', (n?: Node) => { if (n && n.t === 'ns') openFilterBox([n.ns]); }),
        vscode.commands.registerCommand('irisSql.clearNamespaceFilter', (n?: Node) => {
            if (n && n.t === 'ns') { tree.setFilter(n.ns, ''); filtersChanged(); }
        }),
        vscode.commands.registerCommand('irisSql.clearFilter', () => { tree.clearFilters(); filtersChanged(); }),
        vscode.commands.registerCommand('irisSql.refresh', () => { forgetSessions(); tree.refresh(); }),
        vscode.commands.registerCommand('irisSql.forgetPassword', () => { forgetTypedPasswords(); forgetSessions(); tree.refresh(); }),
        vscode.commands.registerCommand('irisSql.signInAs', async (n?: Node) => {
            let ns = n && n.t === 'ns' ? n.ns : undefined;
            if (!ns) ns = await pickNamespace(tree);
            const before = ns ? await currentConnection(ns) : undefined;
            if (ns && await signInAs(ns)) {
                if (before) await endSession(before, queryOptions());
                tree.refreshNamespace(ns); showTitle(); updateStatus(tree);
            }
        }),
        vscode.commands.registerCommand('irisSql.useDefaultLogin', async (n?: Node) => {
            if (!n || n.t !== 'ns') return;
            await endPrevious(n.ns);
            await useDefaultLogin(n.ns);
            tree.refreshNamespace(n.ns);
            showTitle();
            updateStatus(tree);
        }),

        vscode.commands.registerCommand('irisSql.newQuery', async (n?: Node) => {
            let ns = n && n.t === 'ns' ? n.ns : undefined;
            if (!ns) {
                const list = await tree.ensureNamespaces();
                ns = list.length === 1 ? list[0] : await pickNamespace(tree);
                if (!ns) return;
            }
            await newQueryDoc(ns, '\nSELECT *\nFROM ');
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
            await run(n.ns, selectSql(n.table));
        }),
        vscode.commands.registerCommand('irisSql.selectLast100', async (n?: Node) => {
            if (!n || n.t !== 'table') return;
            await run(n.ns, topBottomSql(n.table, 100, true));
        }),
        vscode.commands.registerCommand('irisSql.selectTopBottom', async (n?: Node) => {
            if (!n || n.t !== 'table') return;
            const which = await vscode.window.showQuickPick([
                { label: '$(arrow-up) Top', description: 'the first rows (lowest row id)', last: false },
                { label: '$(arrow-down) Bottom', description: 'the last rows (highest row id, newest first)', last: true }
            ], { title: `Select rows of ${n.table.name}`, placeHolder: 'From the top or the bottom?' });
            if (!which) return;
            const count = await vscode.window.showInputBox({
                title: `Select the ${which.last ? 'last' : 'first'} rows of ${n.table.name}`, prompt: 'How many rows?', value: '100',
                validateInput: v => /^\s*[1-9]\d{0,6}\s*$/.test(v) ? undefined : 'A whole number from 1 up'
            });
            if (!count) return;
            await run(n.ns, topBottomSql(n.table, Number(count.trim()), which.last));
        }),
        vscode.commands.registerCommand('irisSql.clearHistory', () => results.clearHistory()),
        vscode.commands.registerCommand('irisSql.countRows', async (n?: Node) => {
            if (!n || n.t !== 'table') return;
            await run(n.ns, `SELECT COUNT(*) AS "Rows" FROM ${qualified(n.table.schema, n.table.name)}`);
        }),
        vscode.commands.registerCommand('irisSql.showColumns', (n?: Node) => withConn(n, async (c, ns) => {
            if (!n || n.t !== 'table') return;
            const sql = `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = '${n.table.schema.replace(/'/g, "''")}' AND TABLE_NAME = '${n.table.name.replace(/'/g, "''")}' ORDER BY ORDINAL_POSITION`;
            results.begin(ns, { base: sql, conds: [] }, true);
            results.post({ type: 'running', where: ns.label, sql, ...results.stateMsg() });
            const { raw } = await listColumns(c, n.table, queryOptions());
            results.last = { ns, sql, result: raw };
            results.noteColumns(raw.columns);
            results.post({ type: 'result', where: ns.label, sql, columns: raw.columns, rows: raw.rows, ms: raw.ms, maxShown: 100000, ...results.stateMsg() });
        })),
        vscode.commands.registerCommand('irisSql.queryFromTable', async (n?: Node) => {
            if (!n || n.t !== 'table') return;
            await newQueryDoc(n.ns, `\nSELECT *\nFROM ${qualified(n.table.schema, n.table.name)}\nWHERE `);
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
