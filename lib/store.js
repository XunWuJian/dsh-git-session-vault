/**
 * Configuration and state persistence.
 *
 * Configuration lives in `$DSH_HOME/dsh-git-session-vault/config.json` and holds
 * no secrets: a token is referenced by the *name* of an environment variable,
 * never by value. State holds the last commit, the baseline and the error
 * record behind the status page; it is machine-local and never pushed.
 * @module store
 */
import { hostname, arch, platform } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AUTO_SYNC, DEFAULT_BRANCH, SCHEMA_VERSION } from './constants.js';
import { readJsonFile, sanitizeRepoUrl, writeJsonFile } from './util.js';

/** Default device display name. */
export function defaultDeviceName() {
    try {
        return hostname() || 'DSH device';
    }
    catch {
        return 'DSH device';
    }
}

/** Paths used by this plugin inside the DSH home. */
export function resolvePaths(dshHome) {
    const dataDir = join(dshHome, 'dsh-git-session-vault');
    return {
        dataDir,
        configPath: join(dataDir, 'config.json'),
        statePath: join(dataDir, 'state.json'),
        logPath: join(dataDir, 'sync.log'),
        workRoot: join(dataDir, 'work'),
        backupRoot: join(dataDir, 'backups'),
    };
}

/** A backup directory may not escape the repository or shadow plugin files. */
export function normalizeBackupDir(input) {
    const text = String(input ?? '').trim().replaceAll('\\', '/');
    if (text === '' || text === '.' || text === './')
        return '';
    const trimmed = text.replace(/^\.\//, '').replace(/\/+$/, '');
    if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed) || trimmed.split('/').some(seg => seg === '' || seg === '.' || seg === '..'))
        throw new Error('备份目录必须是仓库内的相对路径 / backup directory must be a relative path inside the repository');
    if (trimmed === '.git' || trimmed.startsWith('.git/'))
        throw new Error('备份目录不能使用 .git / backup directory must not be .git');
    return trimmed;
}

/** Normalize user input into a complete configuration object. */
export function normalizeConfig(input, deviceName = defaultDeviceName()) {
    const raw = input !== null && typeof input === 'object' ? input : {};
    const auto = raw.autoSync !== null && typeof raw.autoSync === 'object' ? raw.autoSync : {};
    const browserInclude = Array.isArray(raw.includeWorkspaces)
        ? raw.includeWorkspaces.filter(item => typeof item === 'string' && item !== '')
        : [];
    const browserExclude = Array.isArray(raw.excludeWorkspaces)
        ? raw.excludeWorkspaces.filter(item => typeof item === 'string' && item !== '')
        : [];
    return {
        repoUrl: sanitizeRepoUrl(typeof raw.repoUrl === 'string' ? raw.repoUrl : ''),
        branch: (typeof raw.branch === 'string' && raw.branch.trim() !== '' ? raw.branch.trim() : DEFAULT_BRANCH),
        backupDir: normalizeBackupDir(raw.backupDir),
        authMode: raw.authMode === 'https-token' ? 'https-token' : 'credential-helper',
        tokenEnvVar: typeof raw.tokenEnvVar === 'string' ? raw.tokenEnvVar.trim() : '',
        username: typeof raw.username === 'string' ? raw.username.trim() : '',
        gatewayUrl: typeof raw.gatewayUrl === 'string' ? raw.gatewayUrl.trim() : '',
        includeWorkspaces: browserInclude,
        excludeWorkspaces: browserExclude,
        maxSessionMb: Number.isFinite(raw.maxSessionMb) ? Math.max(0, Math.min(2048, Number(raw.maxSessionMb))) : 200,
        includeSubagentSessions: raw.includeSubagentSessions !== false,
        pushEnabled: raw.pushEnabled !== false,
        pullEnabled: raw.pullEnabled !== false,
        allowOverwrite: raw.allowOverwrite === true,
        autoSync: {
            enabled: auto.enabled === true,
            onStartup: auto.onStartup === true,
            onSessionChange: auto.onSessionChange === true,
            startupDelayMs: Number.isFinite(auto.startupDelayMs)
                ? Math.max(5_000, Math.min(600_000, Math.round(Number(auto.startupDelayMs))))
                : DEFAULT_AUTO_SYNC.startupDelayMs,
            debounceMs: Number.isFinite(auto.debounceMs)
                ? Math.max(5_000, Math.min(3_600_000, Math.round(Number(auto.debounceMs))))
                : DEFAULT_AUTO_SYNC.debounceMs,
        },
        deviceName: (typeof raw.deviceName === 'string' && raw.deviceName.trim() !== '' ? raw.deviceName.trim() : deviceName).slice(0, 64),
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    };
}

/** Read (or create) the configuration file. */
export async function loadConfig(paths) {
    const raw = await readJsonFile(paths.configPath);
    const config = normalizeConfig(raw ?? {}, defaultDeviceName());
    if (raw === null)
        await writeJsonFile(paths.configPath, config).catch(() => undefined);
    return config;
}

/** Persist the configuration file. */
export async function saveConfig(paths, config) {
    await writeJsonFile(paths.configPath, config);
    return config;
}

/** Device identity recorded in every manifest entry. */
export function deviceInfo(config) {
    return {
        id: stableDeviceId(config.deviceName),
        name: config.deviceName,
        platform: platform(),
        arch: arch(),
    };
}

/** Stable, path-free device id derived from the display name. */
function stableDeviceId(name) {
    let hash = 0x811c9dc5;
    const text = `dsh-git-session-vault:${name}`;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `dev-${hash.toString(16).padStart(8, '0')}`;
}

/** Default state document. */
export function defaultState() {
    return {
        schemaVersion: SCHEMA_VERSION,
        lastSyncAt: null,
        lastCommit: null,
        lastOperation: null,
        lastError: null,
        baseline: {},
        remoteBaseline: {},
        pendingConflict: null,
        autoSync: { lastRunAt: null, lastResult: null, failures: 0 },
    };
}

/** Read (or create) the state file. */
export async function loadState(paths) {
    const raw = await readJsonFile(paths.statePath);
    if (raw === null || typeof raw !== 'object')
        return defaultState();
    return {
        ...defaultState(),
        ...raw,
        baseline: raw.baseline !== null && typeof raw.baseline === 'object' ? raw.baseline : {},
        remoteBaseline: raw.remoteBaseline !== null && typeof raw.remoteBaseline === 'object' ? raw.remoteBaseline : {},
        autoSync: { ...defaultState().autoSync, ...(raw.autoSync ?? {}) },
    };
}

/** Persist the state file. */
export async function saveState(paths, state) {
    await writeJsonFile(paths.statePath, state);
    return state;
}
