// Talks to the IRIS server's Atelier REST API (the same API the InterSystems ObjectScript extension uses).
// No vscode import, so it can be tested against a fake server on its own.
//
//   POST {base}/api/atelier/v1/{namespace}/action/query   body {"query": "...", "parameters": [...]}
//   -> { status: { errors: [...] }, result: { content: [ {col: value, ...}, ... ] } }
//
// One login per server: the session cookies the first answer sets are sent instead of the password next time;
// when the server forgot the session (401) the request is sent once more with the password.

import * as http from 'http';
import * as https from 'https';

export interface Connection {
    scheme: 'http' | 'https';
    host: string;
    port: number;
    pathPrefix: string;      // '' or '/something'
    namespace: string;
    username: string;
    password: string;
}

export interface QueryOptions {
    allowSelfSigned: boolean;
    timeoutMs: number;
    signal?: { cancelled: boolean; onCancel?: () => void };
}

export interface QueryResult {
    columns: string[];
    rows: Record<string, unknown>[];
    ms: number;
}

export class QueryError extends Error {
    constructor(message: string, public readonly status?: number) { super(message); }
}

const jars = new Map<string, Map<string, string>>();

function jarKey(c: Connection): string {
    return `${c.scheme}://${c.host}:${c.port}${c.pathPrefix}|${c.username}|${c.password}`;
}

export function forgetSessions() { jars.clear(); }

function post(c: Connection, path: string, body: unknown, o: QueryOptions, useSession: boolean): Promise<{ status: number; json: any; text: string }> {
    return new Promise((resolve, reject) => {
        const key = jarKey(c);
        const jar = jars.get(key);
        const headers: Record<string, string> = {
            'Content-Type': 'application/json; charset=utf-8',
            Accept: 'application/json'
        };
        if (useSession && jar && jar.size) headers.Cookie = [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
        else headers.Authorization = 'Basic ' + Buffer.from(`${c.username}:${c.password}`).toString('base64');
        const data = Buffer.from(JSON.stringify(body), 'utf8');
        headers['Content-Length'] = String(data.length);

        const lib = c.scheme === 'http' ? http : https;
        const opts: https.RequestOptions = {
            method: 'POST', host: c.host, port: c.port, path: c.pathPrefix + path, headers, timeout: o.timeoutMs
        };
        if (c.scheme === 'https' && o.allowSelfSigned) opts.rejectUnauthorized = false;

        let done = false;
        const req = lib.request(opts, res => {
            const chunks: Buffer[] = [];
            res.on('data', ch => chunks.push(ch as Buffer));
            res.on('end', () => {
                if (done) return;
                done = true;
                const status = res.statusCode || 0;
                const set = res.headers['set-cookie'];
                if (set && status !== 401) {
                    let j = jars.get(key);
                    if (!j) { j = new Map(); jars.set(key, j); }
                    for (const line of set) {
                        const first = line.split(';')[0];
                        const eq = first.indexOf('=');
                        if (eq <= 0) continue;
                        const name = first.slice(0, eq).trim(), value = first.slice(eq + 1).trim();
                        if (!value || /max-age=0\b/i.test(line) || /expires=thu, 01 jan 1970/i.test(line)) j.delete(name);
                        else j.set(name, value);
                    }
                }
                const text = Buffer.concat(chunks).toString('utf8');
                let json: any;
                try { json = text ? JSON.parse(text) : {}; } catch { json = undefined; }
                resolve({ status, json, text });
            });
        });
        req.on('timeout', () => { req.destroy(new Error(`The query took longer than ${Math.round(o.timeoutMs / 1000)} s and was given up`)); });
        req.on('error', err => { if (!done) { done = true; reject(new QueryError(err.message)); } });
        if (o.signal) o.signal.onCancel = () => { if (!done) { done = true; req.destroy(); reject(new QueryError('Cancelled')); } };
        req.end(data);
    });
}

/** Runs one SQL statement in the connection's namespace. */
export async function runQuery(c: Connection, sql: string, params: unknown[], o: QueryOptions): Promise<QueryResult> {
    const path = `/api/atelier/v1/${encodeURIComponent(c.namespace)}/action/query`;
    const started = Date.now();
    const key = jarKey(c);
    let r = await post(c, path, { query: sql, parameters: params }, o, true);
    if (r.status === 401 && jars.get(key)?.size) {
        jars.delete(key);
        r = await post(c, path, { query: sql, parameters: params }, o, false);
    }
    if (r.status === 401) throw new QueryError('The server rejected the username or password (HTTP 401).', 401);
    const errors: any[] = Array.isArray(r.json?.status?.errors) ? r.json.status.errors : [];
    if (errors.length) {
        const msg = errors.map(e => e?.error || e?.message || String(e)).join('; ');
        throw new QueryError(cleanError(msg), r.status);
    }
    if (r.status < 200 || r.status >= 300) throw new QueryError(`HTTP ${r.status}: ${r.text.slice(0, 300)}`, r.status);
    if (!r.json) throw new QueryError('The server answered with something that is not JSON: ' + r.text.slice(0, 200), r.status);
    const content = r.json?.result?.content;
    const rows: Record<string, unknown>[] = Array.isArray(content) ? content : [];
    const columns: string[] = [];
    const seen = new Set<string>();
    for (const row of rows.slice(0, 200)) {
        for (const k of Object.keys(row || {})) if (!seen.has(k)) { seen.add(k); columns.push(k); }
    }
    return { columns, rows, ms: Date.now() - started };
}

/** "ERROR #5540: SQLCODE: -30 Message: Table 'X' not found" -> "SQLCODE -30: Table 'X' not found" */
export function cleanError(msg: string): string {
    const m = /SQLCODE:\s*(-?\d+)\s*Message:\s*([\s\S]*)$/i.exec(msg);
    if (m) return `SQLCODE ${m[1]}: ${m[2].trim()}`;
    return msg;
}

// ---- SQL text helpers ----------------------------------------------------------------------------

/** A delimited SQL identifier: "Schema"."Table". */
export function quoteIdent(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
}
export function qualified(schema: string, name: string): string {
    return quoteIdent(schema) + '.' + quoteIdent(name);
}

/** The first keyword of a statement, comments and leading parentheses skipped. */
export function firstKeyword(sql: string): string {
    const s = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/^[\s(]+/, '');
    const m = /^([A-Za-z]+)/.exec(s);
    return m ? m[1].toUpperCase() : '';
}

export function isReadOnly(sql: string): boolean {
    return ['SELECT', 'WITH', 'CALL', 'EXPLAIN'].includes(firstKeyword(sql));
}

/** Drops a trailing ; and surrounding blank lines (the API runs one statement). */
export function normalizeStatement(sql: string): string {
    return sql.trim().replace(/;\s*$/, '').trim();
}

/** The statement under the cursor: the block of text between blank lines (or ; at line end) around `line`. */
export function statementAt(text: string, line: number): { text: string; startLine: number; endLine: number } {
    const lines = text.split(/\r?\n/);
    if (!lines.length) return { text: '', startLine: 0, endLine: 0 };
    let l = Math.min(Math.max(0, line), lines.length - 1);
    // on a blank line: use the nearest statement above
    while (l > 0 && lines[l].trim() === '') l--;
    let start = l;
    while (start > 0 && lines[start - 1].trim() !== '' && !/;\s*$/.test(lines[start - 1])) start--;
    let end = l;
    while (end < lines.length - 1 && !/;\s*$/.test(lines[end]) && lines[end + 1].trim() !== '') end++;
    return { text: lines.slice(start, end + 1).join('\n'), startLine: start, endLine: end };
}

/** Rows as CSV (Excel-friendly: comma, quotes doubled, UTF-8 BOM added by the caller when saving). */
export function toCsv(columns: string[], rows: Record<string, unknown>[], sep = ','): string {
    const cell = (v: unknown) => {
        if (v === null || v === undefined) return '';
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return /["\r\n]/.test(s) || s.includes(sep) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [columns.map(cell).join(sep), ...rows.map(r => columns.map(c => cell(r[c])).join(sep))].join('\r\n');
}
