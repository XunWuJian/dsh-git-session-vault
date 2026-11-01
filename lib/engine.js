/**
 * Three-way session synchronization over a Git repository.
 *
 * The repository is the source of truth for the *content* of a session log;
 * the local state file keeps a baseline (the last expression both sides
 * agreed on) for every session so that a compare of `base / local / remote`
 * decides what to do:
 *
 * | local | remote | action |
 * |-------|--------|--------|
 * | same as base | same as base | skip |
 * | changed | same as base | push (copy local -> work tree, commit, publish) |
 * | same as base | changed | pull (copy work tree -> local, after a local backup) |
 * | changed | changed, content equal | skip |
 * | changed | changed, content differs | conflict -> stop, never resolve silently |
 *
 * Session logs are append-only, zstd-compressed whole-file snapshots, so a file
 * identity is `sha256(content)` rather than a Git object id: identical content
 * must compare equal even when the compression frame differs.
 *
 * Nothing is ever deleted locally, and a local file is never overwritten
 * without a copy in `backups/` first.
 * @module engine
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { SCHEMA_VERSION, TITLE_EN, TITLE_ZH } from './constants.js';
import { MERGE_KINDS, classifyPath, forkFileName, isForkFile } from './merge.js';
import { readSessionHeaderId, scanSessions, sessionIdMatches } from './sessions.js';
import { deviceInfo, loadConfig, loadState, normalizeConfig, saveConfig, saveState } from './store.js';
import { runGit } from './git.js';
import {
    SyncError,
    describeTransport,
    displayPath,
    errorMessage,
    redactText,
    sanitizeRepoUrl,
    toSyncError,
    writeJsonFile,
} from './util.js';

/** One MiB read chunk while hashing. */
const HASH_CHUNK = 1024 * 1024;

/** SHA-256 of a file, streamed to stay within memory for large logs. */
export async function hashFile(path) {
    const hash = createHash('sha256');
    const { open } = await import('node:fs/promises');
    const handle = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(HASH_CHUNK);
        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead <= 0)
                break;
            hash.update(buffer.subarray(0, bytesRead));
        }
    }
    finally {
        await handle.close();
    }
    return hash.digest('hex');
}

/** Validate a repository-relative path from untrusted input. */
function assertSafeRelative(rel, label) {
    const text = String(rel ?? '').replaceAll('\\', '/');
    const segments = text.split('/');
    if (text === '' || text.startsWith('/') || /^[a-zA-Z]:/.test(text) ||
        segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes('\0'))) {
        throw new SyncError('invalid-repository', `仓库中的路径不安全 / unsafe path in repository: ${redactText(text)} (${label})`);
    }
    return text;
}

/** Join a validated relative path onto a trusted root. */
function inside(root, rel) {
    const target = resolve(root, rel.split('/').join(sep));
    const rootResolved = resolve(root);
    if (target !== rootResolved && !target.startsWith(rootResolved + sep))
        throw new SyncError('invalid-repository', `路径越界 / path escapes its root: ${redactText(rel)}`);
    return target;
}

/** A commit subject that keeps `git log` readable. */
function commitSubject(operationName, counts) {
    const parts = [];
    if (counts.push > 0)
        parts.push(`+${counts.push}`);
    if (counts.pull > 0)
        parts.push(`-${counts.pull}`);
    parts.push(`conflict:${counts.conflict}`);
    return `[${TITLE_EN}] ${operationName} ${parts.join(' ')} (${counts.total} sessions)`;
}

/**
 * Create the sync engine.
 *
 * @param {object} options
 * @param {string} options.dshHome  absolute DSH home
 * @param {string} options.workDir  Git working copy of the backup repository
 * @param {object} options.paths    plugin data paths
 * @param {object} options.logger   sync logger
 * @param {object} [options.env]    environment used to resolve token variables
 */
export function createEngine(options) {
    const { dshHome, workDir, paths, logger } = options;
    const env = options.env ?? process.env;
    let queue = Promise.resolve();
    let working = false;

    /** Serialize every mutating operation. */
    function exclusive(task) {
        if (working)
            throw new SyncError('busy', '已有同步任务在执行 / another synchronization is already running');
        working = true;
        const run = queue.then(task);
        queue = run.catch(() => undefined).finally(() => {
            working = false;
        });
        return run;
    }

    /** Resolve a token from the environment when the config asks for one. */
    function tokenFor(config) {
        if (config.authMode !== 'https-token')
            return undefined;
        const name = config.tokenEnvVar;
        if (name === '')
            return undefined;
        const value = env[name] ?? '';
        if (value === '')
            return undefined;
        return { username: config.username === '' ? 'x-access-token' : config.username, password: value };
    }

    /** Run one git command in the work tree with the configured credentials. */
    function git(args, config, extra = {}) {
        return runGit(args, { cwd: workDir, token: tokenFor(config), ...extra });
    }

    /** The repository URL used for push/pull; never carries credentials. */
    function remoteUrl(config) {
        return sanitizeRepoUrl(config.repoUrl);
    }

    /** Ensure the work tree exists and points at the configured repository. */
    async function ensureRepo(config) {
        if (config.repoUrl === '') {
            throw new SyncError('not-configured', '尚未填写 Git 仓库地址 / no repository configured yet');
        }
        await mkdir(workDir, { recursive: true });
        let isRepo = false;
        try {
            isRepo = (await runGit(['rev-parse', '--git-dir'], { cwd: workDir })).stdout.trim() !== '';
        }
        catch {
            isRepo = false;
        }
        if (!isRepo) {
            await runGit(['init', '-q'], { cwd: workDir });
            await runGit(['config', 'user.name', 'dsh-git-session-vault'], { cwd: workDir });
            await runGit(['config', 'user.email', 'dsh-git-session-vault@localhost'], { cwd: workDir });
            await runGit(['config', 'core.autocrlf', 'false'], { cwd: workDir });
            await runGit(['config', 'core.quotepath', 'false'], { cwd: workDir });
        }
        const url = remoteUrl(config);
        let current = '';
        try {
            current = (await runGit(['remote', 'get-url', 'origin'], { cwd: workDir })).stdout.trim();
        }
        catch {
            current = '';
        }
        if (current !== url) {
            await runGit(['remote', 'remove', 'origin'], { cwd: workDir }).catch(() => undefined);
            await runGit(['remote', 'add', 'origin', url], { cwd: workDir });
        }
        return { url };
    }

    /** Whether the remote branch exists (a lightweight `ls-remote`). */
    async function remoteHasBranch(config) {
        const { stdout } = await git(['ls-remote', '--heads', 'origin', config.branch], config, { timeoutMs: 60_000 });
        return stdout.trim() !== '';
    }

    /** Fetch the configured branch; returns false when it does not exist yet. */
    async function fetchBranch(config) {
        const hasBranch = await remoteHasBranch(config);
        if (!hasBranch)
            return false;
        await git(['fetch', '--prune', 'origin', `refs/heads/${config.branch}:refs/remotes/origin/${config.branch}`], config, { timeoutMs: 180_000 });
        return true;
    }

    /** Root of the backup inside the work tree. */
    function backupRoot(config) {
        return config.backupDir === '' ? workDir : join(workDir, ...config.backupDir.split('/'));
    }

    /** Repository-relative path of one session log. */
    function repoPathOf(config, entry) {
        const rel = `profiles/${entry.workspaceKey}/sessions/${entry.sessionId}/${entry.fileName}`;
        return config.backupDir === '' ? rel : `${config.backupDir}/${rel}`;
    }

    /** Local absolute path of one session log. */
    function localPathOf(workspaceKey, sessionId, fileName) {
        return join(dshHome, 'sessions', workspaceKey, sessionId, fileName);
    }

    /** Whether a workspace key passes the include/exclude filters. */
    function workspaceAllowed(config, entry) {
        if (config.includeWorkspaces.length > 0 &&
            !config.includeWorkspaces.some(item => item === entry.workspaceKey || item === entry.workspaceTitle)) {
            return false;
        }
        return !config.excludeWorkspaces.some(item => item === entry.workspaceKey || item === entry.workspaceTitle);
    }

    /** Whether a session is a sub-agent child session. */
    function isSubagentSession(entry) {
        return entry.sessionId.split(':').length > 1;
    }

    /** Scan the local session archive into records keyed by session id. */
    async function scanLocal(config) {
        const sessions = await scanSessions(dshHome);
        const records = new Map();
        for (const entry of sessions) {
            if (!workspaceAllowed(config, entry))
                continue;
            if (!config.includeSubagentSessions && isSubagentSession(entry))
                continue;
            const oversized = config.maxSessionMb > 0 && entry.size > config.maxSessionMb * 1024 * 1024;
            records.set(entry.sessionId, {
                sessionId: entry.sessionId,
                workspaceKey: entry.workspaceKey,
                workspaceTitle: entry.workspaceTitle,
                fileName: entry.fileName,
                localPath: entry.file,
                localSize: entry.size,
                localMtime: entry.mtimeMs,
                createdAt: entry.createdAt,
                localHash: null,
                reason: oversized ? `超过上限 ${config.maxSessionMb} MB，已跳过 / larger than the ${config.maxSessionMb} MB limit` : null,
            });
        }
        return records;
    }

    /** Session entries of the fetched branch, keyed by session id. */
    async function remoteTree(config) {
        const hasBranch = await remoteHasBranch(config).catch(() => false);
        if (!hasBranch)
            return new Map();
        const ref = `origin/${config.branch}`;
        // `--long` reports the blob size, so one listing call describes the
        // whole branch without a second process per session.
        const listingResult = await git(['ls-tree', '-r', '-l', '-z', ref], config);
        const listing = new Map();
        for (const line of listingResult.stdout.split('\0')) {
            if (line === '')
                continue;
            const tab = line.indexOf('\t');
            if (tab < 0)
                continue;
            const [mode, type, objectId, size] = line.slice(0, tab).trim().split(/\s+/);
            if (type !== 'blob')
                continue;
            const fullPath = line.slice(tab + 1);
            const rel = config.backupDir === ''
                ? fullPath
                : fullPath.startsWith(`${config.backupDir}/`) ? fullPath.slice(config.backupDir.length + 1) : null;
            if (rel === null)
                continue;
            const match = /^profiles\/([^/]+)\/sessions\/([^/]+)\/([^/]+)$/.exec(rel);
            if (match === null)
                continue;
            listing.set(match[2], {
                repoPath: fullPath,
                workspaceKey: match[1],
                sessionId: match[2],
                fileName: match[3],
                remoteSize: Number.parseInt(size, 10) || 0,
                blobId: objectId,
                mode,
            });
        }
        return listing;
    }

    /** Materialize one session from the fetched branch at `target`. */
    async function checkoutSession(config, repoPath, target) {
        await mkdir(dirname(target), { recursive: true });
        // Binary: a session log is a zstd frame, not text.
        const result = await git(['show', `origin/${config.branch}:${assertSafeRelative(repoPath, 'session')}`], config, { binary: true });
        await writeFile(target, result.stdoutBuffer, { mode: 0o600 });
    }

    /** Content hash of one session on the fetched branch. */
    async function remoteSessionHash(config, repoPath) {
        const result = await git(['show', `origin/${config.branch}:${assertSafeRelative(repoPath, 'session')}`], config, { binary: true });
        return createHash('sha256').update(result.stdoutBuffer).digest('hex');
    }

    /** Raw bytes of one session on the fetched branch. */
    async function remoteSessionBytes(config, repoPath) {
        const result = await git(['show', `origin/${config.branch}:${assertSafeRelative(repoPath, 'session')}`], config, { binary: true });
        return result.stdoutBuffer;
    }

    /** Raw bytes of the recorded baseline copy, or undefined when unavailable. */
    async function baselineBytes(config, sessionId) {
        const target = join(paths.dataDir, 'baseline', config.branch, sessionId, 'base.bin');
        try {
            return await readFile(target);
        }
        catch {
            return undefined;
        }
    }

    /** Keep a copy of the agreed baseline so a later append can be detected. */
    async function rememberBaseline(config, sessionId, source) {
        const target = join(paths.dataDir, 'baseline', config.branch, sessionId, 'base.bin');
        try {
            await mkdir(dirname(target), { recursive: true });
            await copyFile(source, target);
        }
        catch {
            // Best effort: without a stored baseline the merge simply falls
            // back to the conservative "diverged" verdict.
        }
    }

    /** Copy a local log into `backups/` before it is replaced. */
    async function backupLocal(entry) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = join(paths.backupRoot, stamp, entry.workspaceKey, entry.sessionId, entry.fileName);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(entry.localPath, target);
        return displayPath(target);
    }

    /**
     * Baseline of the remote branch this device last observed.
     *
     * The recorded table is the only trustworthy source. A device that has
     * never synchronized has *agreed* on nothing, so its baseline is empty and
     * an equally named but different local log becomes a conflict instead of a
     * silent overwrite. Content that happens to be identical on both sides is
     * still recognized as such by comparing hashes directly.
     */
    async function loadRemoteBaseline(config, state) {
        const key = `origin:${config.branch}`;
        const recorded = state.remoteBaseline?.[key];
        if (recorded !== null && recorded !== undefined && typeof recorded === 'object')
            return { key, baseline: recorded };
        return { key, baseline: {} };
    }

    /** Build the plan shared by diff, sync, backup and restore. */
    async function buildPlan(config, state, input = {}) {
        const decisions = input.resolve !== null && typeof input.resolve === 'object' ? input.resolve : undefined;
        const local = await scanLocal(config);
        const remote = await remoteTree(config);
        const loaded = await loadRemoteBaseline(config, state);
        const remoteBaseline = loaded.baseline;
        const localBaseline = state.baseline ?? {};

        // Rows: local sessions first, then sessions that exist only remotely.
        const rows = [];
        for (const [sessionId, entry] of local) {
            const remoteEntry = remote.get(sessionId) ?? null;
            rows.push({
                sessionId,
                workspaceKey: entry.workspaceKey,
                workspaceTitle: entry.workspaceTitle,
                fileName: entry.fileName,
                localSize: entry.localSize,
                localMtime: entry.localMtime,
                createdAt: entry.createdAt,
                localHash: null,
                remoteHash: null,
                remoteSize: remoteEntry === null ? null : remoteEntry.remoteSize,
                baseHash: remoteBaseline[sessionId]?.hash ?? null,
                skippedReason: entry.reason,
                repoPath: repoPathOf(config, entry),
                localPathExposed: displayPath(entry.localPath),
            });
        }
        for (const [sessionId, remoteEntry] of remote) {
            if (local.has(sessionId))
                continue;
            rows.push({
                sessionId,
                workspaceKey: remoteEntry.workspaceKey,
                workspaceTitle: null,
                fileName: remoteEntry.fileName,
                localSize: null,
                localMtime: null,
                createdAt: null,
                localHash: null,
                remoteHash: null,
                remoteSize: remoteEntry.remoteSize,
                baseHash: remoteBaseline[sessionId]?.hash ?? null,
                skippedReason: null,
                repoPath: remoteEntry.repoPath,
                localPathExposed: null,
            });
        }

        // Identity is always the content hash: two logs can differ in a single
        // byte while keeping the same length, so a size comparison would be
        // unsound. A Git blob id is only reused when it is *identical* to the
        // one recorded for the same content earlier.
        for (const row of rows) {
            if (row.localSize !== null && row.skippedReason === null)
                row.localHash = await hashFile(local.get(row.sessionId).localPath);
        }
        for (const row of rows) {
            const remoteEntry = remote.get(row.sessionId);
            if (remoteEntry === undefined)
                continue;
            const known = remoteBaseline[row.sessionId];
            if (known !== undefined && typeof known.blobId === 'string' &&
                remoteEntry.blobId !== undefined && known.blobId === remoteEntry.blobId &&
                typeof known.hash === 'string') {
                // The branch still stores the very same blob we hashed before.
                row.remoteHash = known.hash;
                continue;
            }
            row.remoteHash = await remoteSessionHash(config, remoteEntry.repoPath);
            row.remoteBlobId = remoteEntry.blobId;
        }

        // Both-sides-changed rows need their bytes to tell two independent
        // appends (keep both, no interruption) from a real divergence (ask).
        for (const row of rows) {
            if (row.skippedReason !== null)
                continue;
            if (row.localHash === null || row.remoteHash === null)
                continue;
            if (row.localHash === row.remoteHash || row.baseHash === null)
                continue;
            if (row.localHash === row.baseHash || row.remoteHash === row.baseHash)
                continue;
            const localEntry = local.get(row.sessionId);
            if (localEntry === undefined)
                continue;
            row.mergeBytes = {
                base: await baselineBytes(config, row.sessionId),
                local: await readFile(localEntry.localPath).catch(() => undefined),
                remote: await remoteSessionBytes(config, row.repoPath).catch(() => undefined),
            };
        }

        // Decide every row.
        const actions = [];
        for (const row of rows) {
            if (row.skippedReason !== null) {
                row.action = 'skip';
                row.reason = row.skippedReason;
                continue;
            }
            const decision = decisions?.[row.sessionId];
            const base = row.baseHash;
            const localHash = row.localHash;
            const remoteHash = row.remoteHash;
            const localChanged = localHash !== null && localHash !== base;
            const remoteChanged = remoteHash !== null && remoteHash !== base;
            let action;
            let reason;            if (row.remoteSize === null && localHash === null) {
                action = 'skip';
                reason = 'empty';
            }
            else if (row.remoteSize === null) {
                action = 'push';
                reason = base === null ? 'only-local' : 'removed-remotely';
            }
            else if (localHash === null) {
                action = 'pull';
                reason = base === null ? 'only-remotely' : 'missing-local';
            }
            else if (localHash === remoteHash) {
                action = 'skip';
                reason = 'identical';
            }
            // An explicit decision by the user always outranks the automatic
            // rules, including the "no agreed baseline" conflict below.
            else if (decision === 'local') {
                action = 'push';
                reason = 'kept-local';
            }
            else if (decision === 'remote') {
                action = 'pull';
                reason = 'kept-remote';
            }
            else if (base === null) {
                action = 'conflict';
                reason = 'same-id-different-content';
            }
            else if (!localChanged && remoteChanged) {
                action = 'pull';
                reason = 'changed-remotely';
            }
            else if (localChanged && !remoteChanged) {
                action = 'push';
                reason = 'changed-locally';
            }
            else {
                // Both sides moved. Session logs are append-only, so most of
                // these are two independent appends to one base: keep the local
                // log and preserve the remote lineage as a fork file instead of
                // interrupting the user. A genuine divergence still asks.
                const bytes = row.mergeBytes ?? {};
                const verdict = classifyPath(bytes.base, bytes.local, bytes.remote);
                if (verdict.kind === MERGE_KINDS.APPEND_BOTH) {
                    action = 'fork';
                    reason = 'appended-both';
                }
                else {
                    action = 'conflict';
                    reason = verdict.kind === MERGE_KINDS.DIVERGED ? 'diverged-both' : 'changed-both';
                }
            }
            if (action === 'push' && !config.pushEnabled) {
                action = 'skip';
                reason = 'upload-disabled';
            }
            if (action === 'pull' && !config.pullEnabled) {
                action = 'skip';
                reason = 'download-disabled';
            }
            row.action = action;
            row.reason = reason;
            if (action === 'push') {
                actions.push({
                    kind: 'push',
                    sessionId: row.sessionId,
                    repoPath: row.repoPath,
                    localPath: local.get(row.sessionId).localPath,
                    reason,
                });
            }
            else if (action === 'pull') {
                // Replacing a log that exists locally is only risky when the
                // local copy has drifted from the baseline; an untouched log is
                // simply the older version of the same content. An explicit
                // "keep the remote log" decision is the user's own authorization.
                const overwrites = localHash !== null && localHash !== base;
                const authorized = decision === 'remote';
                if (overwrites && !authorized && !config.allowOverwrite) {
                    row.action = 'skip';
                    row.reason = 'local-changes-protected';
                    continue;
                }
                actions.push({
                    kind: 'pull',
                    sessionId: row.sessionId,
                    repoPath: row.repoPath,
                    localPath: localPathOf(row.workspaceKey, row.sessionId, row.fileName),
                    // Any replaced file is preserved in `backups/` first.
                    overwrites: localHash !== null,
                    reason,
                });
            }
            else if (action === 'fork') {
                // Keep the local log where it is and preserve the remote
                // lineage beside it, so neither side loses a single turn.
                actions.push({
                    kind: 'fork',
                    sessionId: row.sessionId,
                    repoPath: row.repoPath,
                    localPath: localPathOf(row.workspaceKey, row.sessionId, row.fileName),
                    forkPath: join(
                        dshHome, 'sessions', row.workspaceKey, row.sessionId,
                        forkFileName(row.fileName, deviceInfo(config).id),
                    ),
                    reason,
                });
            }
        }

        const baselineGone = Object.keys(localBaseline).filter(id => !rows.some(row => row.sessionId === id));
        const countOf = action => rows.filter(row => row.action === action).length;
        const counts = {
            total: rows.length,
            push: countOf('push'),
            pull: countOf('pull'),
            fork: countOf('fork'),
            conflict: countOf('conflict'),
            skipped: countOf('skip'),
        };
        // Where each session lives after the plan runs: a pulled session is
        // written to its target path even when it had no local copy before.
        const localPaths = new Map();
        for (const [sessionId, entry] of local)
            localPaths.set(sessionId, entry.localPath);
        for (const action of actions) {
            if (action.kind === 'pull')
                localPaths.set(action.sessionId, action.localPath);
        }
        return { rows, actions, counts, baselineGone, remoteBaseline, remoteKey: loaded.key, localPaths };
    }

    /** Write the manifests that describe the current branch tree. */
    async function writeManifests(config, operations) {
        const root = backupRoot(config);
        const profilesDir = join(root, 'profiles');
        const profiles = {};
        const sessionsIndex = [];
        let workspaces = [];
        try {
            workspaces = await readdir(profilesDir, { withFileTypes: true });
        }
        catch {
            workspaces = [];
        }
        for (const workspace of workspaces) {
            if (!workspace.isDirectory())
                continue;
            let ids = [];
            try {
                ids = (await readdir(join(profilesDir, workspace.name, 'sessions'), { withFileTypes: true }))
                    .filter(item => item.isDirectory()).map(item => item.name).sort();
            }
            catch {
                ids = [];
            }
            profiles[workspace.name] = { sessionCount: ids.length, updatedAt: new Date().toISOString() };
            for (const id of ids) {
                const dir = join(profilesDir, workspace.name, 'sessions', id);
                let fileName = '';
                try {
                    fileName = (await readdir(dir, { withFileTypes: true }))
                        .filter(item => item.isFile()).map(item => item.name).sort()[0] ?? '';
                }
                catch {
                    fileName = '';
                }
                if (fileName === '')
                    continue;
                const size = (await stat(join(dir, fileName)).catch(() => null))?.size ?? 0;
                sessionsIndex.push({ sessionId: id, workspaceKey: workspace.name, file: fileName, size });
            }
        }
        const device = deviceInfo(config);
        const manifest = {
            schemaVersion: SCHEMA_VERSION,
            generator: { name: 'dsh-git-session-vault', titleZh: TITLE_ZH, titleEn: TITLE_EN },
            updatedAt: new Date().toISOString(),
            updatedBy: device.id,
            backupDir: config.backupDir,
            device,
            profiles,
            sessions: sessionsIndex.sort((left, right) => (left.sessionId < right.sessionId ? -1 : 1)),
            lastOperation: operations,
        };
        await mkdir(root, { recursive: true });
        await writeJsonFile(join(root, 'manifest.json'), manifest);
        await writeJsonFile(join(root, 'metadata', 'schema.json'), {
            schemaVersion: SCHEMA_VERSION,
            description: 'DSH 会话同步备份布局 / session archive layout of DSH Session Sync',
            layout: {
                'manifest.json': '备份索引 / index of this backup',
                'profiles/<workspace>/sessions/<sessionId>/<session file>': '会话原始日志 / raw session log',
            },
            notes: [
                '会话日志是 DSH 自己的压缩文件，原样保存，未经改动 / raw host files, stored unchanged',
                '内容含完整对话，请使用私有仓库 / contains full conversations; keep the repository private',
            ],
        });
        return manifest;
    }

    /** Commit everything in the work tree; returns the new commit or null. */
    async function commit(config, subject, trailers) {
        await git(['add', '-A'], config);
        if ((await git(['status', '--porcelain'], config)).stdout.trim() === '')
            return null;
        const args = ['commit', '-q', '-m', subject];
        for (const [key, value] of Object.entries(trailers))
            args.push('-m', `${key}: ${value}`);
        await git(args, config);
        return (await git(['rev-parse', 'HEAD'], config)).stdout.trim();
    }

    /**
     * Push the branch; re-fetch and retry once when another device won.
     *
     * A rejected push is reconciled with a fast-forward merge only. History is
     * append-only here, so a real divergence means two devices wrote the same
     * session and the user has to decide — it is reported, never rebased away.
     */
    async function pushBranch(config) {
        try {
            await git(['push', 'origin', `HEAD:refs/heads/${config.branch}`], config, { timeoutMs: 300_000 });
            return { ok: true, raced: false };
        }
        catch (error) {
            if (!/rejected|non-fast-forward|fetch first|failed to push/i.test(errorMessage(error)))
                throw error;
            await fetchBranch(config);
            try {
                await git(['merge', '--ff-only', `origin/${config.branch}`], config);
            }
            catch (mergeError) {
                throw new SyncError('conflict', `另一台设备已推送，需要重新同步 / another device pushed first; run a sync again: ${redactText(errorMessage(mergeError))}`);
            }
            await git(['push', 'origin', `HEAD:refs/heads/${config.branch}`], config, { timeoutMs: 300_000 });
            return { ok: true, raced: true };
        }
    }

    /** Execute one plan. */
    async function applyPlan(config, state, plan, operationName) {
        const result = { pulled: [], pushed: [], forked: [], overwritten: [], commit: state.lastCommit, warning: undefined };
        try {
            for (const action of plan.actions) {
                if (action.kind !== 'pull')
                    continue;
                if (action.overwrites) {
                    const row = plan.rows.find(item => item.sessionId === action.sessionId);
                    result.overwritten.push(await backupLocal({
                        localPath: action.localPath,
                        workspaceKey: row?.workspaceKey ?? 'unknown',
                        sessionId: action.sessionId,
                        fileName: basename(action.localPath),
                    }));
                }
                await checkoutSession(config, action.repoPath, action.localPath);
                result.pulled.push(action.sessionId);
            }
            // A fork keeps both lineages: the local log stays untouched and the
            // remote content is written beside it under a fork name that the
            // mirror never deletes or overwrites.
            for (const action of plan.actions) {
                if (action.kind !== 'fork')
                    continue;
                const bytes = await remoteSessionBytes(config, action.repoPath);
                await mkdir(dirname(action.forkPath), { recursive: true });
                await writeFile(action.forkPath, bytes, { mode: 0o600 });
                result.forked.push(displayPath(action.forkPath));
                logger.warn(`两边都在追加，已保留两份 / both sides appended; kept a fork copy: ${displayPath(action.forkPath)}`);
            }
            for (const action of plan.actions) {
                if (action.kind !== 'push')
                    continue;
                const target = inside(workDir, action.repoPath);
                await mkdir(dirname(target), { recursive: true });
                await copyFile(action.localPath, target);
                result.pushed.push(action.sessionId);
            }
            if (result.pushed.length > 0) {
                await writeManifests(config, {
                    operation: operationName,
                    at: new Date().toISOString(),
                    pushed: result.pushed.length,
                    pulled: result.pulled.length,
                    conflicts: plan.counts.conflict,

                });
                result.commit = await commit(config, commitSubject(operationName, plan.counts), {
                    Operation: operationName,
                    Device: deviceInfo(config).id,
                    Sessions: String(plan.counts.total),
                    Pushed: String(plan.counts.push),
                    Pulled: String(plan.counts.pull),
                    Conflicts: String(plan.counts.conflict),
                });
                if (result.commit !== null)
                    await pushBranch(config);
            }
        }
        catch (error) {
            // The local work tree keeps its commit, so retrying is cheap. The
            // failure is reported instead of swallowed: recording a baseline for
            // content the repository never received would make the next run
            // believe both sides agree.
            result.warning = `已保存本地提交，但未能推送到仓库 / local commit kept but the push failed: ${redactText(errorMessage(error))}`;
            logger.warn(result.warning);
            throw toSyncError(error);
        }
        return result;
    }

    /** Refresh both baselines after an operation. */
    async function updateBaseline(state, plan) {
        const local = { ...(state.baseline ?? {}) };
        const remote = { ...(plan.remoteBaseline ?? {}) };
        const stamp = new Date().toISOString();
        for (const row of plan.rows) {
            if (row.action === 'conflict')
                continue;
            if (row.action === 'skip' && row.skippedReason !== null)
                continue;
            // What each side holds after the operation, recorded only when it is
            // actually known. A skipped upload leaves the remote side untouched
            // and therefore unconfirmed.
            const localHash = row.action === 'pull' ? row.remoteHash : (row.localHash ?? row.remoteHash);
            const remoteHash = row.action === 'push' ? row.localHash : row.remoteHash;
            if (localHash !== null && localHash !== undefined) {
                local[row.sessionId] = {
                    hash: localHash,
                    size: row.localSize ?? row.remoteSize ?? 0,
                    workspaceKey: row.workspaceKey,
                    fileName: row.fileName,
                    updatedAt: stamp,
                };
            }
            if (remoteHash !== null && remoteHash !== undefined) {
                remote[row.sessionId] = {
                    hash: remoteHash,
                    size: row.remoteSize ?? row.localSize ?? 0,
                    workspaceKey: row.workspaceKey,
                    fileName: row.fileName,
                    // Only keep the blob id when the branch still stores the very
                    // blob that was hashed; a push rewrote it.
                    ...(row.action === 'push' || row.remoteBlobId === undefined ? {} : { blobId: row.remoteBlobId }),
                    updatedAt: stamp,
                };
            }
        }
        for (const gone of plan.baselineGone) {
            if (!plan.rows.some(row => row.sessionId === gone))
                delete local[gone];
        }
        state.baseline = local;
        const table = state.remoteBaseline !== null && typeof state.remoteBaseline === 'object' ? state.remoteBaseline : {};
        table[plan.remoteKey] = remote;
        state.remoteBaseline = table;
        return state;
    }

    /**
     * Keep a byte copy of every session both sides now agree on.
     *
     * Without it a later append on both sides could not be told apart from a
     * rewrite, and the plugin would interrupt the user for the ordinary case.
     * The copy lives in the plugin's own data directory, never in the
     * repository.
     */
    async function refreshBaselineBytes(config, plan) {
        for (const row of plan.rows) {
            if (row.action === 'conflict')
                continue;
            if (row.skippedReason !== null)
                continue;
            if (row.localHash === null && row.remoteHash === null)
                continue;
            const localEntry = plan.localPaths?.get(row.sessionId);
            if (localEntry === undefined)
                continue;
            // Only store bytes that really match the agreed hash; a skipped
            // download leaves the local copy stale and must not become a base.
            const current = await hashFile(localEntry).catch(() => null);
            if (current === null)
                continue;
            if (row.action === 'push' && current !== row.localHash)
                continue;
            if (row.action === 'pull' && current !== row.remoteHash)
                continue;
            await rememberBaseline(config, row.sessionId, localEntry);
        }
    }

    /**
     * Record a successful or failed operation on the state document.
     *
     * The state is re-read here on purpose: the operation body writes its own
     * baselines and saves them, and recording the outcome on a snapshot taken
     * before the task ran would silently discard those updates.
     */
    async function record(state, operationName, outcome) {
        const fresh = await loadState(paths);
        Object.assign(state, fresh);
        state.lastOperation = { operation: operationName, at: new Date().toISOString(), ...outcome };
        if (outcome.ok === false) {
            state.lastError = {
                at: new Date().toISOString(),
                operation: operationName,
                message: redactText(outcome.error ?? 'unknown error'),
            };
        }
        else {
            state.lastError = null;
            state.lastSyncAt = new Date().toISOString();
            if (outcome.commit !== null && outcome.commit !== undefined)
                state.lastCommit = outcome.commit;
        }
        await saveState(paths, state);
    }

    /** Wrap an operation: serialize, record the outcome, normalize errors. */
    async function operation(name, task) {
        const state = await loadState(paths);
        try {
            const value = await exclusive(task);
            await record(state, name, { ok: true, ...(value.summary ?? {}) });
            logger.info(`${TITLE_ZH} ${name} 完成 / finished`, value.summary);
            return value;
        }
        catch (error) {
            const syncError = toSyncError(error);
            await record(state, name, { ok: false, error: syncError.message });
            logger.error(`${TITLE_ZH} ${name} 失败 / failed: ${syncError.message}`);
            throw syncError;
        }
    }

    /** Check out the configured branch, creating it when it is empty. */
    async function checkoutBranch(config) {
        const hasBranch = await fetchBranch(config);
        if (!hasBranch) {
            await git(['checkout', '-q', '-B', config.branch], config);
            return false;
        }
        try {
            await git(['checkout', '-q', '-B', config.branch, `origin/${config.branch}`], config);
        }
        catch {
            await git(['fetch', 'origin', `refs/heads/${config.branch}`], config);
            await git(['checkout', '-q', '-B', config.branch, 'FETCH_HEAD'], config);
        }
        return true;
    }

    return {
        /** The stored configuration. */
        async getConfig() {
            return loadConfig(paths);
        },

        /** Validate, persist and return a new configuration. */
        async saveConfig(input) {
            const config = normalizeConfig(input, defaultDeviceName());
            await saveConfig(paths, config);
            logger.info('配置已保存 / configuration saved', { repo: config.repoUrl === '' ? '(none)' : 'configured' });
            return config;
        },

        /** Test connectivity without changing anything. */
        async testConnection(input) {
            const config = normalizeConfig(input ?? (await loadConfig(paths)), defaultDeviceName());
            if (config.repoUrl === '')
                throw new SyncError('not-configured', '请先填写仓库地址 / enter a repository URL first');
            await ensureRepo(config);
            const hasBranch = await remoteHasBranch(config);
            const result = { ok: true, branch: config.branch, hasBranch };
            if (hasBranch) {
                const { stdout } = await git(['ls-remote', '--heads', 'origin', config.branch], config, { timeoutMs: 60_000 });
                result.head = stdout.split(/\s+/)[0] ?? null;
            }
            return result;
        },

        /** Local archive summary plus the last recorded outcome. */
        async status() {
            const config = await loadConfig(paths);
            const state = await loadState(paths);
            const local = await scanSessions(dshHome);
            const allowed = local.filter(entry => workspaceAllowed(config, entry));
            const workspaces = new Map();
            for (const entry of local) {
                const current = workspaces.get(entry.workspaceKey) ??
                    { key: entry.workspaceKey, title: entry.workspaceTitle, sessions: 0, bytes: 0 };
                current.sessions += 1;
                current.bytes += entry.size;
                if (current.title === null && entry.workspaceTitle !== null)
                    current.title = entry.workspaceTitle;
                workspaces.set(entry.workspaceKey, current);
            }
            return {
                configured: config.repoUrl !== '',
                // The stored configuration, minus anything secret (there is
                // nothing secret in it: a token only ever travels as an
                // environment variable name).
                config,
                repo: { url: config.repoUrl, branch: config.branch, transport: describeTransport(config.repoUrl) },
                device: deviceInfo(config),
                local: {
                    sessions: allowed.length,
                    totalSessions: local.length,
                    bytes: allowed.reduce((sum, entry) => sum + entry.size, 0),
                    workspaces: [...workspaces.values()].sort((left, right) => right.bytes - left.bytes),
                },
                lastSyncAt: state.lastSyncAt,
                lastCommit: state.lastCommit,
                lastOperation: state.lastOperation,
                lastError: state.lastError,
                tracked: Object.keys(state.baseline ?? {}).length,
                conflict: state.pendingConflict,
                autoSync: state.autoSync,
                working,
            };
        },

        /** Every local session log, for the table and the list tool. */
        async localSessions() {
            const config = await loadConfig(paths);
            const entries = await scanSessions(dshHome);
            const sessions = entries.map(entry => ({
                sessionId: entry.sessionId,
                workspace: entry.workspaceTitle ?? entry.workspaceKey,
                workspaceKey: entry.workspaceKey,
                fileName: entry.fileName,
                size: entry.size,
                createdAt: new Date(entry.createdAt).toISOString(),
                mtime: new Date(entry.mtimeMs).toISOString(),
                included: workspaceAllowed(config, entry) &&
                    (config.includeSubagentSessions || !isSubagentSession(entry)),
            }));
            return { total: sessions.length, bytes: sessions.reduce((sum, item) => sum + item.size, 0), sessions };
        },

        /** One session's raw file and its header-derived id. */
        async inspectSession(sessionId) {
            const sessions = await scanSessions(dshHome);
            const entry = sessions.find(item => sessionIdMatches(item.sessionId, sessionId));
            if (entry === undefined)
                throw new SyncError('not-found', `找不到会话 / session not found: ${redactText(sessionId)}`);
            return {
                sessionId: entry.sessionId,
                headerId: await readSessionHeaderId(entry.file),
                workspaceKey: entry.workspaceKey,
                workspaceTitle: entry.workspaceTitle,
                fileName: entry.fileName,
                size: entry.size,
                createdAt: new Date(entry.createdAt).toISOString(),
                mtime: new Date(entry.mtimeMs).toISOString(),
                path: displayPath(entry.file),
            };
        },

        /** Read-only three-way comparison. */
        async diff() {
            const config = await loadConfig(paths);
            if (config.repoUrl === '')
                throw new SyncError('not-configured', '尚未填写 Git 仓库地址 / no repository configured yet');
            const state = await loadState(paths);
            const plan = await exclusive(async () => {
                await ensureRepo(config);
                await fetchBranch(config);
                return buildPlan(config, state);
            });
            return {
                counts: plan.counts,
                rows: plan.rows.map(row => ({
                    sessionId: row.sessionId,
                    workspace: row.workspaceTitle ?? row.workspaceKey,
                    action: row.action,
                    reason: row.reason,
                    localSize: row.localSize,
                    remoteSize: row.remoteSize,
                    createdAt: row.createdAt === null ? null : new Date(row.createdAt).toISOString(),
                })),
            };
        },

        /** Two-way sync: pull what is safe, push what is local, stop on conflict. */
        async sync(input = {}) {
            const config = await loadConfig(paths);
            if (config.repoUrl === '')
                throw new SyncError('not-configured', '尚未填写 Git 仓库地址 / no repository configured yet');
            const options = input ?? {};
            const pending = await loadState(paths);
            const state = pending;
            await ensureRepo(config);
            await checkoutBranch(config);
            const plan = await buildPlan(config, state, options);
            if (plan.counts.conflict > 0 && options.allowConflicts !== true) {
                state.pendingConflict = {
                    at: new Date().toISOString(),
                    sessions: plan.rows.filter(row => row.action === 'conflict').map(row => row.sessionId).slice(0, 50),
                };
                await saveState(paths, state);
                const message = `有 ${plan.counts.conflict} 个会话两边都改了，需要你选择保留哪一边 / ${plan.counts.conflict} conflicting sessions need a decision`;
                throw new SyncError('conflict-present', message, {
                    plan: {
                        counts: plan.counts,
                        rows: plan.rows.filter(row => row.action === 'conflict').slice(0, 50)
                            .map(row => ({ sessionId: row.sessionId, workspace: row.workspaceTitle ?? row.workspaceKey })),
                    },
                });
            }
            const applied = await exclusive(async () => applyPlan(config, state, plan, 'sync'));
            await updateBaseline(state, plan);
            await refreshBaselineBytes(config, plan).catch(() => undefined);
            state.pendingConflict = null;
            await saveState(paths, state);
            await record(state, 'sync', {
                ok: plan.counts.conflict === 0,
                pulled: applied.pulled.length,
                pushed: applied.pushed.length,
                conflicts: plan.counts.conflict,
                skipped: plan.counts.skipped,
                commit: applied.commit,
            });
            return {
                summary: {
                    ok: plan.counts.conflict === 0,
                    pulled: applied.pulled.length,
                    pushed: applied.pushed.length,
                    forked: applied.forked.length,
                    conflicts: plan.counts.conflict,
                    skipped: plan.counts.skipped,
                    commit: applied.commit,
                },
                counts: plan.counts,
                ...applied,
                error: plan.counts.conflict > 0 ? `${plan.counts.conflict} 个冲突未处理 / ${plan.counts.conflict} conflicts left` : undefined,
            };
        },

        /** Upload-only sync. */
        async backup(input = {}) {
            const config = await loadConfig(paths);
            const narrowed = { ...config, pullEnabled: false, allowOverwrite: false };
            return operation('backup', async () => {
                const state = await loadState(paths);
                await ensureRepo(narrowed);
                await fetchBranch(narrowed);
                const plan = await buildPlan(narrowed, state, input);
                const applied = await applyPlan(narrowed, state, plan, 'backup');
                await updateBaseline(state, plan);
            await refreshBaselineBytes(config, plan).catch(() => undefined);
                await saveState(paths, state);
                return {
                    summary: { ok: true, pushed: applied.pushed.length, commit: applied.commit },
                    counts: plan.counts,
                    ...applied,
                };
            });
        },

        /** Download-only sync; replaces locally changed logs after a backup. */
        async restore(input = {}) {
            const config = await loadConfig(paths);
            const narrowed = { ...config, pushEnabled: false, allowOverwrite: true };
            return operation('restore', async () => {
                const state = await loadState(paths);
                await ensureRepo(narrowed);
                const hasBranch = await fetchBranch(narrowed);
                if (!hasBranch)
                    throw new SyncError('not-found', `分支 ${config.branch} 在仓库中不存在 / branch does not exist in the repository`);
                const plan = await buildPlan(narrowed, state, input);
                const applied = await applyPlan(narrowed, state, plan, 'restore');
                await updateBaseline(state, plan);
            await refreshBaselineBytes(config, plan).catch(() => undefined);
                await saveState(paths, state);
                return {
                    summary: {
                        ok: plan.counts.conflict === 0,
                        pulled: applied.pulled.length,
                        forked: applied.forked.length,
                        conflicts: plan.counts.conflict,
                        skipped: plan.counts.skipped,
                    },
                    counts: plan.counts,
                    ...applied,
                    error: plan.counts.conflict > 0 ? `${plan.counts.conflict} 个冲突未处理 / ${plan.counts.conflict} conflicts left` : undefined,
                };
            });
        },

        /** Recent commits of the backup branch. */
        async history(input = {}) {
            const config = await loadConfig(paths);
            if (config.repoUrl === '')
                throw new SyncError('not-configured', '尚未填写 Git 仓库地址 / no repository configured yet');
            const limit = Math.max(1, Math.min(200, Number(input.limit) || 20));
            const stdout = await exclusive(async () => {
                await ensureRepo(config);
                await fetchBranch(config);
                try {
                    return (await git(['log', `--max-count=${limit}`, '--date=iso-strict', '--pretty=format:%H%x1f%ad%x1f%s%x1e', `origin/${config.branch}`], config)).stdout;
                }
                catch {
                    return '';
                }
            });
            const entries = stdout.split('\x1e').map(line => line.trim()).filter(Boolean).map(line => {
                const [hash, date, subject] = line.split('\x1f');
                return { hash, date, subject };
            });
            return { count: entries.length, entries };
        },

        /** The most recent log entries. */
        async logs(input = {}) {
            const limit = Math.max(1, Math.min(300, Number(input.limit) || 100));
            return { entries: logger.recent(limit) };
        },

        /** Clear a recorded conflict without resolving it. */
        async clearConflict() {
            const state = await loadState(paths);
            state.pendingConflict = null;
            await saveState(paths, state);
            return { ok: true };
        },
    };
}

/** Device name lookup kept local so the module has no host dependency. */
function defaultDeviceName() {
    return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'DSH device';
}

/** Re-exported helpers used by the tests. */
export { assertSafeRelative as _assertSafeRelative, commitSubject as _commitSubject, inside as _inside };
