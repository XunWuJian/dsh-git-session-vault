/**
 * Host entry of **DSH 会话同步 / DSH Session Sync**.
 *
 * Wires the pieces together and stays inert when an optional Host service is
 * missing: a plugin that throws during profile boot can take the whole profile
 * down, so every step here is defensive.
 *
 * No runtime dependency on any `@deepseek-ai/*` package is used; services are
 * reached through `ctx.get()` / `ctx.inject()`.
 * @module index
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_NAME, TITLE_EN, TITLE_ZH, IDLE_SESSION_MS, DEFAULT_BRANCH } from './constants.js';
import { createEngine } from './engine.js';
import { gitVersion } from './git.js';
import { registerHttpRoutes } from './routes.js';
import { resolvePaths, loadConfig, loadState, normalizeConfig, saveConfig } from './store.js';
import { registerTools } from './tools.js';
import { createLogger, displayPath, ensurePrivateDir, errorMessage } from './util.js';

/** Cordis plugin name; equals the bundle row id and the npm package name. */
export const name = PACKAGE_NAME;

/** No hard service dependency: every service is feature detected. */
export const inject = [];

/** Resolve the DSH home from the environment or the running profile. */
function resolveDshHome(profileContext) {
    const configured = (process.env.DSH_HOME ?? '').trim();
    if (configured !== '')
        return configured;
    const profileDir = (profileContext?.dir ?? '').trim();
    if (profileDir !== '')
        return dirname(dirname(profileDir));
    return join(homedir(), '.dsh');
}

/** Read this plugin's own version from its package manifest. */
async function readPluginVersion() {
    try {
        const text = await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8');
        const parsed = JSON.parse(text);
        return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}

/**
 * Watch the session archive and run an automatic sync after the archive has
 * been quiet for the configured debounce. Events never sync directly: a burst
 * of writes is coalesced into one run, and only sessions older than
 * {@link IDLE_SESSION_MS} count as finished, so a log that is being written
 * during sync is not captured half finished.
 */
function createAutoSync(ctx, engine, logger) {
    let config = null;
    let state = null;
    let watcher = null;
    let timer = null;
    let disposed = false;
    let running = false;
    let paths = null;
    let dshHome = null;

    const clearTimer = () => {
        if (timer !== null) {
            ctx.timer.clearTimeout(timer);
            timer = null;
        }
    };

    const schedule = (delayMs) => {
        if (disposed || config === null || config.autoSync.enabled !== true)
            return;
        clearTimer();
        timer = ctx.timer.setTimeout(() => {
            timer = null;
            void run('event');
        }, delayMs);
    };

    const run = async (trigger) => {
        if (disposed || running || config === null || config.autoSync.enabled !== true)
            return;
        const idle = await sessionsIdle();
        if (!idle) {
            schedule(config.autoSync.debounceMs);
            return;
        }
        running = true;
        try {
            const result = await engine.sync({ allowConflicts: false });
            logger.info(`自动同步完成 / automatic sync finished (${trigger})`, result.counts);
            await noteAutoSync({ lastRunAt: new Date().toISOString(), lastResult: { ok: true, counts: result.counts }, failures: 0 });
        }
        catch (error) {
            const message = errorMessage(error);
            const paused = /conflict/i.test(message) || error.code === 'conflict-present';
            logger.warn(`自动同步暂停 / automatic sync paused (${trigger}): ${message}`);
            await noteAutoSync({
                lastRunAt: new Date().toISOString(),
                lastResult: { ok: false, message, needsDecision: paused },
                failures: (state?.autoSync?.failures ?? 0) + 1,
            });
        }
        finally {
            running = false;
        }
    };

    /** Record the automatic-sync outcome without disturbing the engine's own state. */
    const noteAutoSync = async (autoSync) => {
        try {
            state = await loadState(paths);
            state.autoSync = autoSync;
            await saveState(paths, state);
        }
        catch (error) {
            logger.warn(`自动同步状态未保存 / automatic sync state not saved: ${errorMessage(error)}`);
        }
    };

    const sessionsIdle = async () => {
        const root = join(dshHome, 'sessions');
        const now = Date.now();
        const workspaces = await readdir(root, { withFileTypes: true }).catch(() => []);
        for (const workspace of workspaces) {
            if (!workspace.isDirectory())
                continue;
            const sessionDirs = await readdir(join(root, workspace.name), { withFileTypes: true }).catch(() => []);
            for (const dir of sessionDirs) {
                if (!dir.isDirectory())
                    continue;
                const files = await readdir(join(root, workspace.name, dir.name), { withFileTypes: true }).catch(() => []);
                for (const file of files) {
                    if (!file.isFile())
                        continue;
                    const info = await stat(join(root, workspace.name, dir.name, file.name)).catch(() => null);
                    if (info !== null && now - info.mtimeMs < IDLE_SESSION_MS)
                        return false;
                }
            }
        }
        return true;
    };

    return {
        async start(options) {
            paths = options.paths;
            dshHome = options.dshHome;
            config = await loadConfig(paths);
            state = await loadState(paths);
            const root = join(options.dshHome, 'sessions');
            try {
                watcher = watch(root, { recursive: true, persistent: false }, () => {
                    if (disposed)
                        return;
                    schedule(config.autoSync.debounceMs);
                });
                watcher.on('error', error => logger.warn(`会话目录监听失败 / session watch failed: ${errorMessage(error)}`));
            }
            catch (error) {
                logger.warn(`无法监听会话目录 / cannot watch the session archive: ${errorMessage(error)}`);
            }
            if (config.autoSync.enabled && config.autoSync.onStartup)
                schedule(config.autoSync.startupDelayMs);
        },
        async applyConfig(nextConfig) {
            config = nextConfig;
            clearTimer();
            if (nextConfig.autoSync.enabled && nextConfig.autoSync.onStartup)
                schedule(nextConfig.autoSync.startupDelayMs);
        },
        notifyChange() {
            if (config?.autoSync.enabled === true && config.autoSync.onSessionChange === true)
                schedule(config.autoSync.debounceMs);
        },
        dispose() {
            disposed = true;
            clearTimer();
            try {
                watcher?.close();
            }
            catch {
                // Ignore.
            }
            watcher = null;
        },
    };
}

/**
 * A tiny schema builder.
 *
 * The host's `@deepseek-ai/schemastery` is not a runtime dependency of this
 * plugin on purpose: importing it would make the plugin unresolvable from a
 * profile's `node_modules` and the whole plugin would fail to load. Cordis only
 * needs an object that can validate and default a config value, which is what
 * these few methods provide.
 */
function field(kind, fallback, allowed) {
    const schema = {
        type: kind,
        default: fallback,
        /** Accept a value or fall back to the default. */
        parse(value) {
            if (value === undefined || value === null)
                return fallback;
            if (kind === 'string')
                return typeof value === 'string' ? value : fallback;
            if (kind === 'number')
                return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
            if (kind === 'boolean')
                return typeof value === 'boolean' ? value : fallback;
            if (kind === 'union')
                return allowed.includes(value) ? value : fallback;
            return value;
        },
        /** Minimal JSON Schema projection for the loader's inspector. */
        toJSON() {
            return kind === 'union'
                ? { type: 'string', enum: [...allowed], default: fallback }
                : { type: kind, default: fallback };
        },
    };
    return schema;
}

/** Nested object schema. */
function objectSchema(shape) {
    const defaults = {};
    for (const [key, schema] of Object.entries(shape))
        defaults[key] = schema.default;
    return {
        type: 'object',
        default: defaults,
        parse(value) {
            const source = value !== null && typeof value === 'object' ? value : {};
            const out = {};
            for (const [key, schema] of Object.entries(shape))
                out[key] = schema.parse(source[key]);
            return out;
        },
        toJSON() {
            const properties = {};
            for (const [key, schema] of Object.entries(shape))
                properties[key] = schema.toJSON();
            return { type: 'object', properties, default: defaults };
        },
    };
}

/**
 * Declared configuration.
 *
 * Cordis validates the `config:` block of a profile patch against this schema
 * and passes the result to `apply(ctx, config)`. Values left out fall back to
 * whatever the settings page last saved, so a profile patch and the Web UI can
 * both configure the plugin.
 */
export const Config = objectSchema({
    repoUrl: field('string', ''),
    branch: field('string', DEFAULT_BRANCH),
    backupDir: field('string', ''),
    authMode: field('union', 'credential-helper', ['credential-helper', 'https-token']),
    tokenEnvVar: field('string', ''),
    username: field('string', ''),
    includeSubagentSessions: field('boolean', true),
    pushEnabled: field('boolean', true),
    pullEnabled: field('boolean', true),
    allowOverwrite: field('boolean', false),
    maxSessionMb: field('number', 200),
    autoSync: objectSchema({
        enabled: field('boolean', true),
        onStartup: field('boolean', false),
        onSessionChange: field('boolean', false),
        startupDelayMs: field('number', 25_000),
        debounceMs: field('number', 30_000),
    }),
});

/**
 * Merge a profile-patch configuration over the stored one.
 *
 * The patch wins where it says something, the saved file fills the rest. This
 * keeps a hand-written patch authoritative without wiping settings the user
 * made in the browser.
 */
function mergeConfig(patch, stored, deviceName) {
    const merged = { ...stored };
    for (const [key, value] of Object.entries(patch ?? {})) {
        if (value === undefined || value === null)
            continue;
        if (key === 'autoSync' && typeof value === 'object') {
            merged.autoSync = { ...(stored?.autoSync ?? {}), ...value };
            continue;
        }
        merged[key] = value;
    }
    return normalizeConfig(merged, deviceName);
}

/** Plugin entry point. */
export function apply(ctx, config = {}) {
    let running = null;
    let disposed = false;
    const disposers = [];

    const start = async () => {
        const profileContext = ctx.get('profileContext');
        const dshHome = resolveDshHome(profileContext);
        const paths = resolvePaths(dshHome);
        const pluginVersion = await readPluginVersion();
        const git = await gitVersion();
        const logger = createLogger({ filePath: paths.logPath, host: ctx.logger, ringSize: 400 });
        await ensurePrivateDir(paths.dataDir);
        await ensurePrivateDir(paths.workRoot);
        await ensurePrivateDir(paths.backupRoot);

        // A profile patch is configuration, not a secret store: apply it once at
        // startup so the Web UI and the agent tools see the same values.
        if (config !== null && typeof config === 'object' && Object.keys(config).length > 0) {
            try {
                const stored = await loadConfig(paths);
                const effective = mergeConfig(config, stored, process.env.COMPUTERNAME ?? 'DSH device');
                if (effective.repoUrl !== stored.repoUrl || effective.branch !== stored.branch) {
                    await saveConfig(paths, effective);
                    logger.info('已应用 profile 配置 / profile configuration applied', {
                        repo: effective.repoUrl === '' ? '(none)' : 'configured',
                        branch: effective.branch,
                    });
                }
            }
            catch (error) {
                logger.warn(`profile 配置无效，已忽略 / profile configuration ignored: ${errorMessage(error)}`);
            }
        }

        const engine = createEngine({
            dshHome,
            workDir: join(paths.workRoot, 'repo'),
            paths,
            logger,
        });
        const autoSync = createAutoSync(ctx, engine, logger);
        await autoSync.start({ dshHome, paths }).catch(error => {
            logger.warn(`自动同步未启动 / automatic sync not started: ${errorMessage(error)}`);
        });
        disposers.push(registerHttpRoutes({ ctx, engine, logger }));
        disposers.push(ctx.inject(['tools'], scoped => registerTools({ ctx: scoped, engine, logger })));
        running = { autoSync, logger };
        logger.info(`${TITLE_ZH} / ${TITLE_EN} 已加载 / loaded`, {
            version: pluginVersion,
            git: git ?? 'missing',
            dataDir: displayPath(paths.dataDir),
            home: displayPath(dshHome),
        });
        if (git === null)
            logger.warn('未找到 git，同步功能不可用 / git not found; synchronization is unavailable');
        if (disposed)
            stop();
    };

    const stop = () => {
        running?.autoSync.dispose();
        running = null;
        for (const disposer of disposers.splice(0)) {
            try {
                void disposer();
            }
            catch {
                // The owning fiber tears down anyway.
            }
        }
    };

    ctx.effect(() => {
        void start().catch(error => {
            try {
                ctx.logger.error(`[${PACKAGE_NAME}] 加载失败 / failed to load: ${errorMessage(error)}`);
            }
            catch {
                // Nothing left to report to.
            }
        });
        return () => {
            disposed = true;
            stop();
        };
    }, `${PACKAGE_NAME}: lifecycle`);
}

export { apply as start };
export { createEngine };
