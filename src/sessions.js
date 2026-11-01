/**
 * Session archive layout discovery.
 *
 * A DSH home keeps session logs under `<DSH_HOME>/sessions/<workspace-dir>/<
 * session-id>/session[.vN].jsonl[.zst]`. The workspace directory name is a
 * lossy encoding of the session's working directory, so it is only used as a
 * grouping key in the backup; `storages/workspace.json` supplies the readable
 * title when it is present.
 *
 * Every function here tolerates missing and malformed files: a session that
 * cannot be read is reported as an error in its record instead of failing the
 * whole scan.
 * @module sessions
 */
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Recognized session log file names. */
const SESSION_FILE = /^session\.(?:v(\d+)\.)?jsonl(?:\.zstd)?$/i;

/** Sort key so `session.v4` wins over `session.v1`. */
function versionOf(name) {
    const match = SESSION_FILE.exec(name);
    if (match === null)
        return 0;
    return match[1] === undefined ? 1 : Number.parseInt(match[1], 10);
}

/** Whether a name looks like a session log. */
export function isSessionFileName(name) {
    return SESSION_FILE.test(name);
}

/** Session identifiers are directory names; refuse anything path-like. */
export function isSafeSegment(name) {
    return typeof name === 'string' && name !== '' && name.length <= 200 && !/[\\/]/.test(name) &&
        name !== '.' && name !== '..' && !name.includes('\0');
}

/**
 * Read `storages/workspace.json` into lookup tables.
 * @returns {{ titles: Map<string, string>, bySession: Map<string, string> }}
 */
export async function readWorkspaceTitles(dshHome) {
    const titles = new Map();
    const bySession = new Map();
    let parsed = null;
    try {
        parsed = JSON.parse(await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8'));
    }
    catch {
        return { titles, bySession };
    }
    const tables = parsed?.tables?.workspaces;
    if (tables === null || typeof tables !== 'object')
        return { titles, bySession };
    for (const workspace of Object.values(tables)) {
        if (workspace === null || typeof workspace !== 'object')
            continue;
        const title = typeof workspace.title === 'string' ? workspace.title : '';
        const path = typeof workspace.path === 'string' ? workspace.path : '';
        if (title !== '') {
            if (path !== '')
                titles.set(path, title);
        }
        const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
        for (const id of ids) {
            if (typeof id === 'string' && title !== '')
                bySession.set(id, title);
        }
    }
    return { titles, bySession };
}

/**
 * Best-effort creation time for a session: the log's birthtime when the
 * filesystem reports one, its ctime otherwise.
 */
async function timestampsOf(path) {
    try {
        const info = await stat(path, { bigint: true });
        const birth = info.birthtimeMs > 0n ? Number(info.birthtimeMs) : Number(info.ctimeMs);
        return { createdAt: birth, mtimeMs: Number(info.mtimeMs), size: Number(info.size) };
    }
    catch {
        return null;
    }
}

/**
 * Enumerate every session log under a DSH home.
 *
 * @returns {Promise<Array<{ sessionId: string, workspaceKey: string,
 *   workspaceTitle: string | null, file: string, fileName: string, size: number,
 *   mtimeMs: number, createdAt: number }>>}
 */
export async function scanSessions(dshHome) {
    const sessionsRoot = join(dshHome, 'sessions');
    const { bySession } = await readWorkspaceTitles(dshHome);
    let workspaces;
    try {
        workspaces = await readdir(sessionsRoot, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const found = [];
    for (const workspace of workspaces) {
        if (!workspace.isDirectory() || !isSafeSegment(workspace.name))
            continue;
        const workspacePath = join(sessionsRoot, workspace.name);
        let sessionDirs;
        try {
            sessionDirs = await readdir(workspacePath, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const dir of sessionDirs) {
            if (!dir.isDirectory() || !isSafeSegment(dir.name))
                continue;
            const sessionPath = join(workspacePath, dir.name);
            let files;
            try {
                files = await readdir(sessionPath, { withFileTypes: true });
            }
            catch {
                continue;
            }
            const candidates = files
                .filter(entry => entry.isFile() && isSessionFileName(entry.name))
                .map(entry => entry.name)
                .sort((left, right) => versionOf(right) - versionOf(left) || (left < right ? 1 : -1));
            const fileName = candidates[0];
            if (fileName === undefined)
                continue;
            const file = join(sessionPath, fileName);
            const stamps = await timestampsOf(file);
            if (stamps === null)
                continue;
            found.push({
                sessionId: dir.name,
                workspaceKey: workspace.name,
                workspaceTitle: bySession.get(dir.name) ?? null,
                file,
                fileName,
                size: stamps.size,
                mtimeMs: stamps.mtimeMs,
                createdAt: stamps.createdAt,
            });
        }
    }
    found.sort((left, right) => left.createdAt - right.createdAt ||
        (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0));
    return found;
}

/**
 * Identify the DSH session id stored inside a session log's header line.
 *
 * The log is a zstd-compressed JSONL stream; only the first line is needed.
 * Any failure is silent because the implementation is internal to the host and
 * may change: callers fall back to the directory name.
 */
export async function readSessionHeaderId(file) {
    let handle = null;
    try {
        handle = await open(file, 'r');
        const buffer = Buffer.alloc(256 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead <= 0)
            return null;
        let inflated = null;
        const zstd = globalThis.process?.getBuiltinModule?.('node:zlib')?.zstdDecompressSync;
        if (file.toLowerCase().endsWith('.zst') && typeof zstd === 'function') {
            try {
                inflated = zstd(buffer.subarray(0, bytesRead));
            }
            catch {
                inflated = null;
            }
        }
        if (inflated === null) {
            if (file.toLowerCase().endsWith('.zst'))
                return null;
            inflated = buffer.subarray(0, bytesRead);
        }
        const text = inflated.toString('utf8');
        const newline = text.indexOf('\n');
        const firstLine = newline === -1 ? text : text.slice(0, newline);
        if (firstLine.trim() === '')
            return null;
        const parsed = JSON.parse(firstLine);
        const id = typeof parsed?.id === 'string' ? parsed.id : typeof parsed?.sessionId === 'string' ? parsed.sessionId : null;
        return id !== null && isSafeSegment(id) ? id : null;
    }
    catch {
        return null;
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}

/** Normalize a session id: strip the `session-` decoration the host uses. */
export function canonicalSessionId(raw) {
    const text = String(raw ?? '').trim();
    if (text === '')
        return '';
    return text.startsWith('session-') ? text.slice('session-'.length) : text;
}

/**
 * Match one directory entry against a requested session id.
 *
 * The host stores some sessions as `<uuid>` and others as `session-<uuid>`
 * depending on where they came from, so a request for either form matches.
 */
export function sessionIdMatches(entryName, requested) {
    const wanted = canonicalSessionId(requested);
    if (wanted === '')
        return false;
    return canonicalSessionId(entryName) === wanted;
}
