// Which namespaces this workspace has, and how to reach them: the InterSystems ObjectScript extension's own
// connection for each workspace folder (isfs server folders, or local folders with objectscript.conn).
//
// Login per namespace:
//   - default: the user of that InterSystems connection. Password: what that extension hands over, else Server
//     Manager's saved login (silently), else asked once.
//   - "Sign in as Another User...": a user typed for that namespace (remembered); its password is only ever asked
//     and kept in memory until VS Code closes, since such passwords may change every few hours.
// When the server rejects a password (HTTP 401), the caller asks for the current one and runs again (withLogin).

import * as vscode from 'vscode';
import { Connection, QueryError, forgetSessions } from './atelier';

export interface NamespaceTarget {
    id: string;                 // serverName|NS (lower case)
    label: string;              // e.g. "dev-iris : USER"
    serverName: string;
    namespace: string;
    folder: vscode.WorkspaceFolder;
    apiVersion?: number;
    conn?: Omit<Connection, 'password'> & { password?: string };
}

const typedPasswords = new Map<string, string>();     // serverName|user -> password (this session only)
let log: (s: string) => void = () => undefined;
let store: vscode.Memento | undefined;
const LOGIN_KEY = 'irisSql.loginUser';                 // namespace id -> username signed in as
const USERS_KEY = 'irisSql.usedUsers';                 // namespace id -> other users signed in with before (newest first)

export function setLog(fn: (s: string) => void) { log = fn; }
export function setStore(m: vscode.Memento) { store = m; }
export function forgetTypedPasswords() { typedPasswords.clear(); }

/** The other user this namespace is signed in as, or undefined for the connection's own user. */
export function loginUserFor(t: NamespaceTarget): string | undefined {
    return store?.get<Record<string, string>>(LOGIN_KEY, {})[t.id] || undefined;
}
/** Signs this namespace in as `user` (undefined: the connection's own user). The password is asked when needed. */
export async function setLoginUser(t: NamespaceTarget, user: string | undefined) {
    const all = { ...(store?.get<Record<string, string>>(LOGIN_KEY, {}) ?? {}) };
    if (user) all[t.id] = user; else delete all[t.id];
    await store?.update(LOGIN_KEY, all);
    if (user) {
        const used = { ...(store?.get<Record<string, string[]>>(USERS_KEY, {}) ?? {}) };
        used[t.id] = [user, ...(used[t.id] ?? []).filter(u => u.toLowerCase() !== user.toLowerCase())].slice(0, 5);
        await store?.update(USERS_KEY, used);
    }
}

/** Other users this namespace was signed in with before (for the login choice), newest first. */
export function usedUsersFor(t: NamespaceTarget): string[] {
    return store?.get<Record<string, string[]>>(USERS_KEY, {})[t.id] ?? [];
}

/** The connection as it is now (no prompt): for ending its server session. */
export async function currentConnection(t: NamespaceTarget): Promise<Connection | undefined> {
    return connectionFor(t, { ask: false });
}

const pwKey = (t: NamespaceTarget, user: string) => `${t.serverName}|${user}`.toLowerCase();

async function objectScriptApi(): Promise<any | undefined> {
    const ext = vscode.extensions.getExtension('intersystems-community.vscode-objectscript');
    if (!ext) return undefined;
    try { return ext.isActive ? ext.exports : await ext.activate(); } catch { return undefined; }
}

function isfsAuthority(uri: vscode.Uri): { serverName: string; ns: string } | undefined {
    if (!uri.scheme.startsWith('isfs')) return undefined;
    const a = uri.authority;
    const i = a.indexOf(':');
    const fromQuery = new URLSearchParams(uri.query).get('ns') || '';
    if (i > 0) return { serverName: decodeURIComponent(a.slice(0, i)), ns: decodeURIComponent(a.slice(i + 1)) || fromQuery };
    return a ? { serverName: decodeURIComponent(a), ns: fromQuery } : undefined;
}

/** Every namespace reachable from the workspace folders, one entry per server + namespace. */
export async function findNamespaces(): Promise<NamespaceTarget[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const api = await objectScriptApi();
    const out = new Map<string, NamespaceTarget>();
    for (const folder of folders) {
        let s: any;
        try {
            s = api?.asyncServerForUri ? await api.asyncServerForUri(folder.uri) : api?.serverForUri?.(folder.uri);
        } catch (e: any) {
            log(`serverForUri failed for ${folder.uri.toString()}: ${e?.message || e}`);
        }
        const fromUri = isfsAuthority(folder.uri);
        const conf = vscode.workspace.getConfiguration('objectscript', folder.uri).get<any>('conn');
        const isIris = !!fromUri || !!conf?.active;
        if (!isIris) continue;
        const serverName: string = s?.serverName || fromUri?.serverName || conf?.server || '';
        const namespace: string = (s?.namespace || fromUri?.ns || conf?.ns || '').toUpperCase();
        if (!namespace) continue;
        const id = `${serverName}|${namespace}`.toLowerCase();
        if (out.has(id)) continue;
        const t: NamespaceTarget = {
            id, serverName, namespace, folder,
            label: `${serverName || s?.host || 'server'} : ${namespace}`,
            apiVersion: typeof s?.apiVersion === 'number' ? s.apiVersion : undefined
        };
        if (s?.host && s?.port) {
            let prefix: string = s.pathPrefix || '';
            if (prefix && !prefix.startsWith('/')) prefix = '/' + prefix;
            prefix = prefix.replace(/\/+$/, '');
            t.conn = {
                scheme: s.scheme === 'http' ? 'http' : 'https',
                host: s.host, port: Number(s.port), pathPrefix: prefix, namespace,
                username: s.username || '', password: s.password || s.auth?.password || undefined
            };
        }
        out.set(id, t);
    }
    return [...out.values()].sort((a, b) => a.label.localeCompare(b.label));
}

async function fromServerManager(serverName: string, username: string): Promise<string | undefined> {
    try {
        const smApi = vscode.extensions.getExtension('intersystems-community.servermanager')?.exports;
        let account: any = smApi?.getAccount?.({ name: serverName, username });
        if (!account?.id) account = { id: `${serverName}/${username}`, label: `${username} on ${serverName}` };
        const session = await vscode.authentication.getSession('intersystems-server-credentials', [serverName, username], { silent: true, account } as vscode.AuthenticationGetSessionOptions);
        return session?.accessToken || undefined;
    } catch (e: any) {
        log(`Server Manager login for ${username}@${serverName} not available: ${e?.message || e}`);
        return undefined;
    }
}

async function askPassword(t: NamespaceTarget, user: string, rejected: boolean): Promise<string | undefined> {
    const p = await vscode.window.showInputBox({
        title: rejected ? `IRIS SQL: the password for ${user} was rejected` : `IRIS SQL: sign in to ${t.label}`,
        prompt: rejected
            ? `${t.label} did not accept the password for ${user} (it may have changed). Enter the current one.`
            : `Password for ${user} on ${t.label} (kept in memory until VS Code closes)`,
        password: true, ignoreFocusOut: true
    });
    if (p) typedPasswords.set(pwKey(t, user), p);
    return p || undefined;
}

/** A full connection (with password) for a namespace, or undefined when cancelled / not reachable. */
export async function connectionFor(t: NamespaceTarget, opts: { ask: boolean }): Promise<Connection | undefined> {
    if (!t.conn) {
        vscode.window.showWarningMessage(`IRIS SQL: no server address for ${t.label}. Is the InterSystems ObjectScript extension connected to it?`);
        return undefined;
    }
    const other = loginUserFor(t);
    let username = other || t.conn.username;
    // a password typed in this session wins (also over a stale one in settings that the server rejected)
    let password = username ? typedPasswords.get(pwKey(t, username)) : undefined;
    if (!other) {
        if (!password) password = t.conn.password;
        if (!password && username) password = await fromServerManager(t.serverName, username);
    }
    if (!password && opts.ask) {
        if (!username) {
            username = (await vscode.window.showInputBox({ prompt: `Username for ${t.label}`, ignoreFocusOut: true })) || '';
            if (!username) return undefined;
        }
        password = await askPassword(t, username, false);
    }
    if (!password) return undefined;
    return { ...t.conn, username, password } as Connection;
}

/**
 * Runs `fn` with this namespace's connection. When the server rejects the password, asks for the current one
 * (passwords that rotate every few hours) and runs `fn` once more. Undefined when there is no login (cancelled).
 */
export async function withLogin<T>(t: NamespaceTarget, fn: (c: Connection) => Promise<T>): Promise<T | undefined> {
    const c = await connectionFor(t, { ask: true });
    if (!c) return undefined;
    try {
        return await fn(c);
    } catch (e) {
        if (!(e instanceof QueryError && e.status === 401)) throw e;
        log(`  ${c.username} was rejected on ${t.label}; asking for the current password`);
        typedPasswords.delete(pwKey(t, c.username));
        forgetSessions();
        const p = await askPassword(t, c.username, true);
        if (!p) throw new QueryError(`Not signed in: the server rejected the password for ${c.username}.`, 401);
        return await fn({ ...c, password: p });
    }
}

/** Right-click a namespace > Sign in as Another User... Returns true when the login changed. */
export async function signInAs(t: NamespaceTarget): Promise<boolean> {
    const current = loginUserFor(t);
    const user = await vscode.window.showInputBox({
        title: `IRIS SQL: sign in to ${t.label} as another user`,
        prompt: 'This user is used for the tables and queries of this namespace (it sees what that user may see).',
        value: current ?? '', placeHolder: 'username', ignoreFocusOut: true
    });
    if (!user) return false;
    const p = await askPassword(t, user.trim(), false);
    if (!p) return false;
    await setLoginUser(t, user.trim());   // sessions are kept per user + password, so the old one is not reused
    return true;
}

/** Back to the connection's own user. */
export async function useDefaultLogin(t: NamespaceTarget) {
    const other = loginUserFor(t);
    if (other) typedPasswords.delete(pwKey(t, other));
    await setLoginUser(t, undefined);
}

/** The isfs URI of a class, in the namespace folder it was listed from (for "Open Class"). */
export function classUri(t: NamespaceTarget, className: string): vscode.Uri | undefined {
    const parts = className.split('.');
    if (parts.length < 2) return undefined;
    const rel = parts.join('/') + '.cls';
    if (t.folder.uri.scheme.startsWith('isfs')) return vscode.Uri.joinPath(t.folder.uri, rel);
    // a local folder: open it from the server through isfs, read-only view of the same server
    if (!t.serverName) return undefined;
    return vscode.Uri.parse(`isfs-readonly://${t.serverName}:${t.namespace.toLowerCase()}/${rel}`);
}
