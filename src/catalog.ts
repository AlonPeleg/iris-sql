// What SQL a namespace has: tables, views, stored procedures, columns. Tried with INFORMATION_SCHEMA first
// (IRIS), then the class dictionary (older Caché), so it works on both.

import { Connection, QueryOptions, runQuery, quoteIdent } from './atelier';

export interface TableInfo { schema: string; name: string; type: 'table' | 'view'; className?: string }
export interface ProcInfo { schema: string; name: string; className?: string; methodName?: string }
export interface ColumnInfo { name: string; type: string; length?: string; nullable?: string }

const SYSTEM_SCHEMA = /^(%|INFORMATION_SCHEMA$|Ens($|_)|EnsLib|EnsPortal|Ens_|HS_|HSMOD|CSPX|SchemaMap|IRIS_Migration)/i;

export function isSystemSchema(schema: string): boolean { return SYSTEM_SCHEMA.test(schema); }

/** Default SQL schema of a package when the class does not set one: dots become underscores. */
function schemaOfClass(cls: string): string {
    const pkg = cls.slice(0, cls.lastIndexOf('.'));
    return pkg.replace(/\./g, '_');
}

async function firstThatWorks<T>(tries: (() => Promise<T>)[], log: (s: string) => void): Promise<T> {
    let last: any;
    for (const t of tries) {
        try { return await t(); } catch (e: any) { last = e; log('  catalog query failed, trying the next form: ' + (e?.message || e)); }
    }
    throw last;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
/** A row's value by column name, whatever case the server used. */
function col(row: Record<string, unknown>, name: string): unknown {
    if (name in row) return row[name];
    const k = Object.keys(row).find(x => x.toLowerCase() === name.toLowerCase());
    return k ? row[k] : undefined;
}

export async function listTables(c: Connection, o: QueryOptions, log: (s: string) => void): Promise<TableInfo[]> {
    return firstThatWorks<TableInfo[]>([
        async () => {
            const r = await runQuery(c,
                "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, CLASSNAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE IN ('BASE TABLE','VIEW') ORDER BY TABLE_SCHEMA, TABLE_NAME", [], o);
            return r.rows.map(row => ({
                schema: s(col(row, 'TABLE_SCHEMA')), name: s(col(row, 'TABLE_NAME')),
                type: /VIEW/i.test(s(col(row, 'TABLE_TYPE'))) ? 'view' as const : 'table' as const,
                className: s(col(row, 'CLASSNAME')) || undefined
            }));
        },
        async () => {
            const r = await runQuery(c,
                "SELECT Name, SqlSchemaName, SqlTableName FROM %Dictionary.CompiledClass WHERE ClassType = 'persistent' ORDER BY Name", [], o);
            return r.rows.map(row => ({
                schema: s(col(row, 'SqlSchemaName')) || schemaOfClass(s(col(row, 'Name'))),
                name: s(col(row, 'SqlTableName')) || s(col(row, 'Name')).split('.').pop()!,
                type: 'table' as const, className: s(col(row, 'Name'))
            }));
        },
        async () => {
            const r = await runQuery(c,
                "SELECT Name, SqlTableName FROM %Dictionary.CompiledClass WHERE ClassType = 'persistent' ORDER BY Name", [], o);
            return r.rows.map(row => ({
                schema: schemaOfClass(s(col(row, 'Name'))),
                name: s(col(row, 'SqlTableName')) || s(col(row, 'Name')).split('.').pop()!,
                type: 'table' as const, className: s(col(row, 'Name'))
            }));
        }
    ], log);
}

export async function listProcedures(c: Connection, o: QueryOptions, log: (s: string) => void): Promise<ProcInfo[]> {
    return firstThatWorks<ProcInfo[]>([
        async () => {
            const r = await runQuery(c,
                "SELECT ROUTINE_SCHEMA, ROUTINE_NAME FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_TYPE = 'PROCEDURE' ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME", [], o);
            return r.rows.map(row => ({ schema: s(col(row, 'ROUTINE_SCHEMA')), name: s(col(row, 'ROUTINE_NAME')) }));
        },
        async () => {
            const r = await runQuery(c,
                "SELECT parent, Name, SqlName FROM %Dictionary.CompiledMethod WHERE SqlProc = 1 ORDER BY parent, Name", [], o);
            return r.rows.map(row => {
                const cls = s(col(row, 'parent'));
                const method = s(col(row, 'Name'));
                const short = cls.split('.').pop() || cls;
                return { schema: schemaOfClass(cls), name: s(col(row, 'SqlName')) || `${short}_${method}`, className: cls, methodName: method };
            });
        }
    ], log);
}

export async function listColumns(c: Connection, t: { schema: string; name: string }, o: QueryOptions): Promise<{ columns: ColumnInfo[]; raw: Awaited<ReturnType<typeof runQuery>> }> {
    const raw = await runQuery(c,
        'SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
        [t.schema, t.name], o);
    return {
        raw,
        columns: raw.rows.map(row => ({
            name: s(col(row, 'COLUMN_NAME')), type: s(col(row, 'DATA_TYPE')),
            length: s(col(row, 'CHARACTER_MAXIMUM_LENGTH')) || undefined, nullable: s(col(row, 'IS_NULLABLE')) || undefined
        }))
    };
}

export interface ProcParam { name: string; mode: string }

export async function listProcParams(c: Connection, p: { schema: string; name: string }, o: QueryOptions): Promise<ProcParam[]> {
    try {
        const r = await runQuery(c,
            "SELECT PARAMETER_NAME, PARAMETER_MODE FROM INFORMATION_SCHEMA.PARAMETERS WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? ORDER BY ORDINAL_POSITION",
            [p.schema, p.name], o);
        return r.rows.map(row => ({ name: s(col(row, 'PARAMETER_NAME')), mode: s(col(row, 'PARAMETER_MODE')) || 'IN' }))
            .filter(x => !/^RETURN/i.test(x.mode) && x.name !== '');
    } catch {
        return [];
    }
}

export function callTemplate(p: { schema: string; name: string }, params: ProcParam[]): string {
    const target = quoteIdent(p.schema) + '.' + quoteIdent(p.name);
    if (!params.length) return `CALL ${target}()`;
    const args = params.map(x => `    NULL  /* ${x.name} ${x.mode} */`).join(',\n');
    return `CALL ${target}(\n${args}\n)`;
}

// ---- filter (the sidebar's Filter box) ----------------------------------------------------------

/** Where a filter matched in a name: [start, end) for highlighting, or undefined when it did not. */
export type Matcher = (text: string | undefined) => [number, number] | undefined;

/**
 * Part of a name, case-insensitive. `*` and `?` work as wildcards (`*Pledge*db`, `config_?ntity`); without them it is a
 * plain "contains". An empty filter matches everything.
 */
export function makeMatcher(filter: string): Matcher | undefined {
    const f = filter.trim();
    if (!f) return undefined;
    const src = /[*?]/.test(f)
        ? f.split('').map(ch => ch === '*' ? '.*?' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('')
        : f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(src, 'i');
    return text => {
        if (!text) return undefined;
        const m = re.exec(text);
        return m ? [m.index, m.index + Math.max(m[0].length, 1)] : undefined;
    };
}

/** A table / view matches by its name, its schema, schema.name, or its class name. */
export function tableMatches(m: Matcher, t: TableInfo): boolean {
    return !!(m(t.name) || m(t.schema) || m(`${t.schema}.${t.name}`) || m(t.className));
}
export function procMatches(m: Matcher, p: ProcInfo): boolean {
    return !!(m(p.name) || m(p.schema) || m(`${p.schema}.${p.name}`) || m(p.className && p.methodName ? `${p.className}.${p.methodName}` : undefined));
}
