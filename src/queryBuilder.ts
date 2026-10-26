// The results tab's conditions, sort and "count by", turned into SQL on top of the query that was run.
// No vscode import: testable on its own.
//
//   base:  the query as run / typed           SELECT * FROM "S"."T" ORDER BY %ID DESC
//   conds: chips added from the grid          "%createdBy" = 'MDigital', ID > 50
//   sort:  a column to order by (server)      ORDER BY "ID" DESC
//   group: a column to count by               SELECT "x", COUNT(*) ... GROUP BY "x"
//
// How conditions get in:
//   - SELECT [DISTINCT] [TOP n] * FROM ... (what the sidebar runs): into its WHERE - added with AND to a WHERE that is
//     there already (that one kept in parentheses), before GROUP BY / HAVING / ORDER BY.
//   - anything else (a column list, a UNION...): wrapped, SELECT * FROM (query) AS q WHERE ..., so the conditions use
//     the result's own column names.
// IRIS allows ORDER BY inside a sub-select only with TOP, so a wrapped query without TOP loses its ORDER BY (a sort
// chip can order the outside). A query that starts with WITH cannot be wrapped: conditions are refused for it.

export type Op = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'between' | 'contains' | 'notContains' | 'startsWith'
    | 'isNull' | 'notNull' | 'onDay';

/** A clicked value as the grid had it: its JSON type decides how it is written in SQL. */
export type Val = string | number | boolean | null;

export interface Condition {
    id: string;
    col: string;
    op: Op;
    value?: Val;
    value2?: Val;          // between
    enabled: boolean;      // a chip can be turned off without removing it
}

export interface QueryState {
    base: string;
    conds: Condition[];
    sort?: { col: string; dir: 'ASC' | 'DESC' };
    group?: string;        // count by this column
    cols?: string[];       // Run with these columns: the SELECT list (empty / missing = *)
    allCols?: string[];    // every column the query had with * (what the Columns box offers)
}

export const OP_LABEL: Record<Op, string> = {
    eq: '=', ne: '≠', gt: '>', ge: '≥', lt: '<', le: '≤', between: 'between', contains: 'contains',
    notContains: 'does not contain', startsWith: 'starts with', isNull: 'is empty', notNull: 'is not empty', onDay: 'on the day'
};

export function quoteIdent(name: string): string { return '"' + name.replace(/"/g, '""') + '"'; }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
export function isDateLike(v: Val | undefined): boolean { return typeof v === 'string' && (DATE_RE.test(v) || TS_RE.test(v)); }
export function isNumberLike(v: Val | undefined): boolean { return typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)); }

/** A value as SQL: numbers as they are, true/false as 1/0 (how IRIS stores %Boolean), dates and timestamps as ODBC
 *  escapes ({d '...'} / {ts '...'}, right for date and timestamp columns alike), text quoted. */
export function literal(v: Val | undefined): string {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (v === 'true' || v === 'false') return v === 'true' ? '1' : '0';
    if (DATE_RE.test(v)) return `{d '${v}'}`;
    if (TS_RE.test(v)) return `{ts '${v.length === 16 ? v + ':00' : v}'}`;
    return "'" + v.replace(/'/g, "''") + "'";
}

function str(v: Val | undefined): string { return "'" + String(v ?? '').replace(/'/g, "''") + "'"; }

function nextDay(d: string): string {
    const [y, m, dd] = d.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, dd + 1));
    return t.toISOString().slice(0, 10);
}

/** One condition as SQL (without its column's table prefix). */
export function condSql(c: Condition): string {
    const col = quoteIdent(c.col);
    const v = c.value;
    switch (c.op) {
        case 'eq': return v === null || v === undefined ? `${col} IS NULL` : `${col} = ${literal(v)}`;
        case 'ne': return v === null || v === undefined ? `${col} IS NOT NULL` : `(${col} <> ${literal(v)} OR ${col} IS NULL)`;
        case 'gt': return `${col} > ${literal(v)}`;
        case 'ge': return `${col} >= ${literal(v)}`;
        case 'lt': return `${col} < ${literal(v)}`;
        case 'le': return `${col} <= ${literal(v)}`;
        case 'between': return `${col} BETWEEN ${literal(v)} AND ${literal(c.value2)}`;
        case 'contains': return `${col} [ ${str(v)}`;
        case 'notContains': return `NOT (${col} [ ${str(v)})`;
        case 'startsWith': return `${col} %STARTSWITH ${str(v)}`;
        case 'isNull': return `${col} IS NULL`;
        case 'notNull': return `${col} IS NOT NULL`;
        case 'onDay': {
            const day = String(v ?? '').slice(0, 10);
            if (!DATE_RE.test(day)) return `${col} = ${literal(v)}`;
            // a date column: that date; a timestamp column: from midnight to the next midnight
            return typeof v === 'string' && DATE_RE.test(v)
                ? `${col} = {d '${day}'}`
                : `${col} >= {ts '${day} 00:00:00'} AND ${col} < {ts '${nextDay(day)} 00:00:00'}`;
        }
    }
}

/** How a chip reads: %createdBy = 'MDigital', ID between 5 and 9, Name is empty. */
export function condLabel(c: Condition): string {
    const show = (x: Val | undefined) => x === null || x === undefined ? 'empty' : typeof x === 'string' && !isNumberLike(x) ? `'${x}'` : String(x);
    switch (c.op) {
        case 'isNull': case 'notNull': return `${c.col} ${OP_LABEL[c.op]}`;
        case 'between': return `${c.col} between ${show(c.value)} and ${show(c.value2)}`;
        case 'onDay': return `${c.col} on ${String(c.value ?? '').slice(0, 10)}`;
        case 'eq': if (c.value === null || c.value === undefined) return `${c.col} is empty`; break;
        case 'ne': if (c.value === null || c.value === undefined) return `${c.col} is not empty`; break;
    }
    return `${c.col} ${OP_LABEL[c.op]} ${show(c.value)}`;
}

// ---- reading the base query (only what is at the top level: not inside ( ), strings, "names" or comments) ----

/** The query without comments and a trailing ; (so text added at its end can never end up inside a -- comment). */
export function cleanSql(sql: string): string {
    let out = '';
    for (let i = 0; i < sql.length; i++) {
        const c = sql[i];
        if (c === "'" || c === '"') {
            let j = i + 1;
            while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; }
            out += sql.slice(i, j + 1); i = j; continue;
        }
        if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; out += '\n'; continue; }
        if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 1; out += ' '; continue; }
        out += c;
    }
    return out.trim().replace(/;\s*$/, '').trim();
}

interface Clause { kw: string; start: number; end: number }   // keyword position (start) and where its text ends

/** Top-level keywords: WITH, SELECT, FROM, WHERE, GROUP BY, HAVING, ORDER BY, UNION. */
function topLevel(sql: string): Clause[] {
    const found: { kw: string; start: number; len: number }[] = [];
    let depth = 0;
    for (let i = 0; i < sql.length; i++) {
        const c = sql[i];
        if (c === "'" || c === '"') {
            let j = i + 1;
            while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; }
            i = j; continue;
        }
        if (c === '(') { depth++; continue; }
        if (c === ')') { depth = Math.max(0, depth - 1); continue; }
        if (depth > 0 || !/[A-Za-z]/.test(c) || (i > 0 && /[\w%$]/.test(sql[i - 1]))) continue;
        const m = /^(WITH|SELECT|FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|UNION)\b/i.exec(sql.slice(i));
        if (m) { found.push({ kw: m[1].toUpperCase().replace(/\s+/g, ' '), start: i, len: m[0].length }); i += m[0].length - 1; }
    }
    return found.map((f, k) => ({ kw: f.kw, start: f.start, end: k + 1 < found.length ? found[k + 1].start : sql.length }));
}

export interface Shape {
    sql: string;
    simpleStar: boolean;       // SELECT [DISTINCT] [TOP n] * FROM ... with no UNION
    hasTop: boolean;
    startsWithWith: boolean;
    clauses: Clause[];
}

export function shapeOf(base: string): Shape {
    const sql = cleanSql(base);
    const clauses = topLevel(sql);
    const kws = clauses.map(c => c.kw);
    const sel = clauses.find(c => c.kw === 'SELECT');
    const head = sel ? sql.slice(sel.start, sel.end) : '';
    const hasTop = /^SELECT\s+(DISTINCT\s+)?TOP\s+\d+/i.test(head);
    const star = /^SELECT\s+(DISTINCT\s+)?(TOP\s+(\d+|ALL)\s+)?\*\s*$/i.test(head.trim());
    return {
        sql, clauses, hasTop,
        startsWithWith: kws[0] === 'WITH',
        simpleStar: star && kws[0] === 'SELECT' && kws.includes('FROM') && !kws.includes('UNION')
    };
}

function without(sql: string, clauses: Clause[], kw: string): string {
    const c = clauses.find(x => x.kw === kw);
    return c ? (sql.slice(0, c.start) + sql.slice(c.end)).trim() : sql;
}

/** The base query with the enabled conditions added (no outer sort / count). */
function withConditions(sh: Shape, conds: Condition[]): string {
    const on = conds.filter(c => c.enabled);
    if (!on.length) return sh.sql;
    const add = on.map(condSql).join(' AND ');
    if (sh.simpleStar) {
        const where = sh.clauses.find(c => c.kw === 'WHERE');
        if (where) {
            const existing = sh.sql.slice(where.start + 5, where.end).trim();
            return `${sh.sql.slice(0, where.start)}WHERE (${existing}) AND ${add}${where.end < sh.sql.length ? ' ' + sh.sql.slice(where.end) : ''}`.replace(/\s+$/, '');
        }
        const after = sh.clauses.find(c => c.kw === 'GROUP BY' || c.kw === 'HAVING' || c.kw === 'ORDER BY');
        return after
            ? `${sh.sql.slice(0, after.start).trimEnd()} WHERE ${add} ${sh.sql.slice(after.start)}`
            : `${sh.sql} WHERE ${add}`;
    }
    const inner = sh.hasTop ? sh.sql : without(sh.sql, sh.clauses, 'ORDER BY');
    return `SELECT * FROM (${inner}) AS q WHERE ${add}`;
}

export interface Built { sql: string; error?: string }

/** The SQL to run for a state. */
export function buildSql(st: QueryState): Built {
    const sh = shapeOf(st.base);
    const cols = st.group ? [] : (st.cols ?? []);
    const extra = st.conds.some(c => c.enabled) || !!st.sort || !!st.group || cols.length > 0;
    if (!extra) return { sql: sh.sql };
    if (sh.startsWithWith) return { sql: sh.sql, error: 'Conditions, sort and count cannot be added to a query that starts with WITH. Edit the SQL instead.' };
    let sql = withConditions(sh, st.conds);
    const now = shapeOf(sql);
    if (st.group) {
        const g = quoteIdent(st.group);
        const inner = now.hasTop ? now.sql : without(now.sql, now.clauses, 'ORDER BY');
        return { sql: `SELECT ${g}, COUNT(*) AS "Count" FROM (${inner}) AS q GROUP BY ${g} ORDER BY "Count" DESC` };
    }
    if (st.sort) {
        const by = `ORDER BY ${quoteIdent(st.sort.col)} ${st.sort.dir}`;
        // with TOP, the same rows ordered differently (outside); without TOP, the query's own ORDER BY replaced
        if (now.hasTop || !now.simpleStar) {
            const inner = now.hasTop ? now.sql : without(now.sql, now.clauses, 'ORDER BY');
            sql = `SELECT * FROM (${inner}) AS q ${by}`;
        } else {
            sql = `${without(now.sql, now.clauses, 'ORDER BY')} ${by}`;
        }
    }
    return { sql: cols.length ? withColumns(sql, cols) : sql };
}

/** Only these columns: the * of a plain SELECT * is replaced; anything else is wrapped (its ORDER BY kept with TOP ALL). */
function withColumns(sql: string, cols: string[]): string {
    const list = cols.map(quoteIdent).join(', ');
    const sh = shapeOf(sql);
    if (sh.simpleStar) {
        const sel = sh.clauses.find(c => c.kw === 'SELECT')!;
        const head = sh.sql.slice(sel.start, sel.end).replace(/^(SELECT\s+(DISTINCT\s+)?(TOP\s+(\d+|ALL)\s+)?)\*\s*/i, `$1${list} `);
        return sh.sql.slice(0, sel.start) + head + sh.sql.slice(sel.end);
    }
    let inner = sh.sql;
    if (!sh.hasTop && sh.clauses.some(c => c.kw === 'ORDER BY') && !sh.clauses.some(c => c.kw === 'UNION')) {
        inner = inner.replace(/^SELECT(\s+DISTINCT)?\s+/i, m => m.trimEnd() + ' TOP ALL ');
    }
    return `SELECT ${list} FROM (${inner}) AS q`;
}

let seq = 0;
export function newCondition(col: string, op: Op, value?: Val, value2?: Val): Condition {
    return { id: 'c' + Date.now().toString(36) + (seq++).toString(36), col, op, value, value2, enabled: true };
}
