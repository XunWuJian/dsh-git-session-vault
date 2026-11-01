/**
 * Errors, logging and small filesystem helpers.
 * @module util
 */
import { appendFile, mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

/** A failure that the settings page and the agent tools both understand. */
export class SyncError extends Error {
    constructor(code, message, details) {
        super(message);
        this.name = 'SyncError';
        this.code = code;
        this.details = details;
        // Keep `instanceof` working across bundles and duplicate module copies.
        Object.setPrototypeOf(this, SyncError.prototype);
    }
}

/** Render any thrown value as a one-line message. */
export function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'string')
        return error;
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}

/** Map any thrown value onto a {@link SyncError}. */
export function toSyncError(error) {
    if (error instanceof SyncError)
        return error;
    return new SyncError('internal', errorMessage(error));
}

/**
 * Credential-shaped strings that must never reach a log, the state file or a
 * browser. The list is deliberately broad: a false positive only redacts text,
 * while a miss leaks a live secret into a file the user may share.
 */
const TOKEN_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/giu;

/** `key=value` style secrets (the value is what gets masked). */
const CREDENTIAL_ASSIGNMENT = /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|password|passwd|client[_-]?secret|private[_-]?key|authorization)\s*[=:]\s*)([^\s&;,]+)/giu;

/** `user:password@host` inside any URL, including inside Git's own output. */
const URL_USERINFO = /(\/\/)[^/\s:@]+:[^/\s@]+@/gu;

/**
 * Whether a URL's user name is itself the credential.
 *
 * `https://<token>@host/repo` is the most common way to paste a PAT, and there
 * the user name *is* the secret, so "a user name is not a secret" does not hold.
 */
function usernameIsCredential(username) {
    if (username === '')
        return false;
    if (redactText(username) !== username)
        return true;
    if (/^[A-Fa-f0-9]{16,}$/u.test(username))
        return true;
    if (username.length >= 20 && !/[-_.]/u.test(username)) {
        const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u].filter(pattern => pattern.test(username)).length;
        if (classes >= 2)
            return true;
    }
    return false;
}

/**
 * Strip credentials and home paths out of text before it is logged, stored in
 * state, or returned to a browser: tokens of every common shape,
 * `user:token@host` URL userinfo and absolute home directories must never leave
 * the machine.
 */
export function redactText(text) {
    let out = String(text);
    out = out.replace(TOKEN_PATTERN, '***');
    out = out.replace(URL_USERINFO, '$1***@');
    out = out.replace(/(\/\/)([^/\s@:]+)@/gu, (match, prefix, user) => (usernameIsCredential(user) ? `${prefix}***@` : match));
    out = out.replace(CREDENTIAL_ASSIGNMENT, '$1***');
    const home = homedir();
    if (home !== '')
        out = out.split(home).join('~');
    return out;
}

/** Collapse a path for display: replace the OS home with `~`. */
export function displayPath(input) {
    const home = homedir();
    if (input === home)
        return '~';
    if (input.startsWith(`${home}/`) || input.startsWith(`${home}\\`))
        return `~${input.slice(home.length)}`;
    return input;
}

/** Keep credentials out of a repository URL. */
export function sanitizeRepoUrl(url) {
    const trimmed = String(url ?? '').trim();
    if (trimmed === '')
        return '';
    try {
        const parsed = new URL(trimmed);
        if (parsed.username === '' && parsed.password === '')
            return trimmed;
        parsed.username = '';
        parsed.password = '';
        return parsed.toString().replace(/\/$/, '');
    }
    catch {
        return trimmed;
    }
}

/** Where a repository URL points, for display and error hints. */
export function describeTransport(url) {
    const text = String(url ?? '').trim();
    if (text === '')
        return { transport: 'none', hint: '' };
    if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('.') || text.startsWith('\\\\') || text.startsWith('/'))
        return { transport: 'local', hint: '本地仓库，无需认证 / local path, no credentials needed' };
    if (/^ssh:\/\//i.test(text) || /^[\w.-]+@[\w.-]+:/.test(text))
        return { transport: 'ssh', hint: '使用 ssh-agent 或 ~/.ssh 密钥 / uses ssh-agent or ~/.ssh keys' };
    if (/^https?:\/\//i.test(text))
        return { transport: 'https', hint: '需要 Git 凭据助手或令牌环境变量 / needs a Git credential helper or token env variable' };
    return { transport: 'unknown', hint: '未识别的地址 / unrecognized address' };
}

/** Read a JSON file; `null` when missing or unparsable. */
export async function readJsonFile(path) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch {
        return null;
    }
}

/** Write a JSON file atomically (temp file + rename) with a private mode. */
export async function writeJsonFile(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
}

/** Create a directory (and parents) with an owner-only mode where possible. */
export async function ensurePrivateDir(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
}

/** Whether a filesystem path exists. */
export async function pathExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}

/**
 * A small bounded ring buffer plus an NDJSON file log.
 *
 * Nothing sensitive reaches a logger: callers pass relative session paths,
 * counts and Git messages, and {@link redactText} has the final word.
 */
export function createLogger(options = {}) {
    const ring = [];
    const ringSize = options.ringSize ?? 300;
    const filePath = options.filePath;
    const host = options.host;
    const write = (level, message, details) => {
        const entry = { at: new Date().toISOString(), level, message: redactText(message) };
        if (details !== undefined) {
            try {
                entry.details = JSON.parse(redactText(JSON.stringify(details)));
            }
            catch {
                entry.details = { note: 'unserializable details' };
            }
        }
        ring.push(entry);
        if (ring.length > ringSize)
            ring.splice(0, ring.length - ringSize);
        if (filePath !== undefined)
            void appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8').catch(() => undefined);
        const line = `[${entry.message}]`;
        try {
            if (level === 'error')
                host?.error?.(line, entry.details);
            else if (level === 'warn')
                host?.warn?.(line, entry.details);
            else if (level === 'info')
                host?.info?.(line, entry.details);
            else
                host?.debug?.(line, entry.details);
        }
        catch {
            // A logger must never break the caller.
        }
    };
    return {
        debug: (message, details) => write('debug', message, details),
        info: (message, details) => write('info', message, details),
        warn: (message, details) => write('warn', message, details),
        error: (message, details) => write('error', message, details),
        recent: (limit = 100) => ring.slice(-limit),
    };
}

/** Format a byte count for humans. */
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
