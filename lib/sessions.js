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
 * Turn a session-archive directory name into something readable.
 *
 * DSH encodes a working directory as `--` plus every separator and colon
 * replaced by `-`, and that encoding is **lossy** — `E:\temp\ds-test` and
 * `E:\temp\ds\test` produce the same directory name. So this is only a last
 * resort: `storages/workspace.json` carries the real path, and callers should
 * prefer it. When it is missing the separator guess is still better than
 * showing `--E-temp-ds-test--` to a user.
 */
export function readableWorkspaceKey(key) {
    const text = String(key ?? '');
    if (text === '')
        return '';
    // `--E-temp-ds-test--`: two dashes, a drive letter, one dash, then the rest
    // of the path with every separator folded to a dash.
    const match = /^--([A-Za-z])-(.*?)-{2}$/.exec(text);
    if (match === null)
        return text;
    const rest = match[2].replaceAll('-', '\\');
    return `${match[1]}:\\${rest}`;
}

/**
 * Read `storages/workspace.json` into lookup tables.
 * @returns {{ titles: Map<string, string>, bySession: Map<string, string> }}
 */
export async function readWorkspaceTitles(dshHome) {
    const titles = new Map();
    const bySession = new Map();
    const byPath = new Map();
    let parsed = null;
    try {
        parsed = JSON.parse(await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8'));
    }
    catch {
        return { titles, bySession, byPath };
    }
    const tables = parsed?.tables?.workspaces;
    if (tables === null || typeof tables !== 'object')
        return { titles, bySession, byPath };
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
            if (typeof id !== 'string')
                continue;
            if (title !== '')
                bySession.set(id, title);
            // The real path is the only lossless answer; keep it per session so
            // the UI can show `E:\temp\ds-test` instead of `--E-temp-ds-test--`.
            if (path !== '')
                byPath.set(id, path);
        }
    }
    return { titles, bySession, byPath };
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
 * `title` is what the sidebar shows: the projection cache first (fast, but only
 * populated for sessions this machine has opened), then the `session/title`
 * event inside the log itself. It is `null` when neither knows — a session that
 * was never titled, which the UI presents as its id.
 *
 * @returns {Promise<Array<{ sessionId: string, workspaceKey: string,
 *   workspaceTitle: string | null, title: string | null, file: string,
 *   fileName: string, size: number, mtimeMs: number, createdAt: number }>>}
 */
export async function scanSessions(dshHome, options = {}) {
    const sessionsRoot = join(dshHome, 'sessions');
    const { bySession, byPath } = await readWorkspaceTitles(dshHome);
    const cached = await readCachedTitles(dshHome);
    // Reading every log is the expensive half; callers that only need sizes
    // (the idle check, a quick listing) can opt out.
    const withTitles = options.titles !== false;
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
            let title = cached.get(dir.name) ?? null;
            if (title === null && withTitles)
                title = await readSessionTitleFromLog(file);
            found.push({
                sessionId: dir.name,
                workspaceKey: workspace.name,
                workspaceTitle: bySession.get(dir.name) ?? null,
                workspacePath: byPath.get(dir.name) ?? null,
                title,
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
 * Read the titles DSH keeps in its projection cache.
 *
 * `storages/session_projcache/sessions/<session-id>.json` holds one record per
 * session the desktop has opened, and `record.rows.title.val` is the title the
 * user sees in the sidebar. It is a cache rather than a source of truth — a
 * session this machine never opened has no file — so callers must treat a miss
 * as "unknown", not as "untitled".
 *
 * @returns {Promise<Map<string, string>>} session id -> title
 */
export async function readCachedTitles(dshHome) {
    const titles = new Map();
    const cacheDir = join(dshHome, 'storages', 'session_projcache', 'sessions');
    let entries;
    try {
        entries = await readdir(cacheDir, { withFileTypes: true });
    }
    catch {
        return titles;
    }
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json'))
            continue;
        const sessionId = entry.name.slice(0, -'.json'.length);
        if (!isSafeSegment(sessionId))
            continue;
        let parsed;
        try {
            parsed = JSON.parse(await readFile(join(cacheDir, entry.name), 'utf8'));
        }
        catch {
            continue;
        }
        const title = parsed?.record?.rows?.title?.val;
        if (typeof title === 'string' && title.trim() !== '')
            titles.set(sessionId, title.trim().slice(0, 200));
    }
    return titles;
}

/** zstd frame magic number, `0x28B52FFD` little-endian. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Read the title out of a session log.
 *
 * The log is a sequence of zstd frames with one JSONL event per line, and the
 * title arrives as a `session/title` event — possibly several times, because
 * the host writes a fallback title from the first prompt and replaces it with
 * the model's title later. The last one wins.
 *
 * Frames are scanned in order and the walk stops as soon as a title is seen, so
 * the common case (a session titled early) touches only the first frame or two
 * instead of decompressing a multi-megabyte log. Only frames that actually
 * mention the event are parsed.
 */
export async function readSessionTitleFromLog(file) {
    let buffer;
    try {
        buffer = await readFile(file);
    }
    catch {
        return null;
    }
    if (buffer.length < 4 || !buffer.subarray(0, 4).equals(ZSTD_MAGIC)) {
        return titleFromText(buffer.toString('utf8'));
    }
    const zstd = globalThis.process?.getBuiltinModule?.('node:zlib')?.zstdDecompressSync;
    if (typeof zstd !== 'function')
        return null;
    let title = null;
    let offset = 0;
    while (offset < buffer.length) {
        const next = buffer.indexOf(ZSTD_MAGIC, offset + 1);
        const end = next === -1 ? buffer.length : next;
        try {
            const text = zstd(buffer.subarray(offset, end)).toString('utf8');
            const found = titleFromText(text);
            // Later titles supersede earlier ones, but a frame without the
            // event proves nothing, so keep walking only when one was seen.
            if (found !== null)
                title = found;
            else if (title !== null)
                break;
        }
        catch {
            // Skip malformed or truncated frames.
        }
        offset = end;
    }
    return title === null ? null : title.slice(0, 200);
}

/** Pick the last `session/title` value out of one frame's JSONL text. */
function titleFromText(text) {
    let title = null;
    if (!text.includes('"session/title"'))
        return null;
    for (const line of text.split('\n')) {
        if (line === '' || !line.includes('"session/title"'))
            continue;
        try {
            const event = JSON.parse(line);
            const value = event?.data?.title;
            if (typeof value === 'string' && value.trim() !== '')
                title = value.trim();
        }
        catch {
            // A partial trailing line is expected at a frame boundary.
        }
    }
    return title;
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
