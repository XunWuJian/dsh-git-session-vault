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
import { resolvePaths, loadConfig, loadState, normalizeConfig, saveConfig, saveState } from './store.js';
import { registerTools } from './tools.js';
import { createLogger, displayPath, ensurePrivateDir, errorMessage } from './util.js';

/** Cordis plugin name; equals the bundle row id and the npm package name. */
export const name = PACKAGE_NAME;

/**
 * Hard service dependencies.
 *
 * `timer` must be declared here: Cordis throws
 * `cannot get property "timer" without inject` on any access to an undeclared
 * service, and the session watcher touches it from an `fs.watch` callback —
 * an uncaught throw inside that callback takes the whole host down.
 *
 * Everything else (connection, tools, profileContext, logger) is reached
 * through `ctx.get()` / `ctx.inject()` and is genuinely optional.
 */
export const inject = ['timer'];

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

    /**
     * The timer service, resolved defensively.
     *
     * `inject: ['timer']` guarantees it is present in a healthy host; the
     * fallback keeps a teardown path working if the service is already gone
     * during shutdown, where throwing from an `fs.watch` callback would take
     * the whole host down.
     */
    const timerService = () => {
        const service = ctx.get('timer');
        return service !== undefined && service !== null ? service : globalThis;
    };

    const clearTimer = () => {
        if (timer !== null) {
            try {
                timerService().clearTimeout(timer);
            }
            catch {
                // The host is shutting down; the pending timer is harmless.
            }
            timer = null;
        }
    };

    const schedule = (delayMs) => {
        if (disposed || config === null || config.autoSync.enabled !== true)
            return;
        clearTimer();
        try {
            timer = timerService().setTimeout(() => {
                timer = null;
                void run('event').catch(error => {
                    logger.warn(`自动同步异常 / automatic sync failed: ${errorMessage(error)}`);
                });
            }, delayMs);
        }
        catch (error) {
            logger.warn(`无法安排自动同步 / cannot schedule automatic sync: ${errorMessage(error)}`);
        }
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
                    // An exception thrown from this callback is uncaught: it
                    // reaches the host's process handler and kills DSH. Every
                    // step inside is therefore wrapped, not just the sync.
                    try {
                        if (disposed || config === null)
                            return;
                        schedule(config.autoSync.debounceMs);
                    }
                    catch (error) {
                        try {
                            logger.warn(`监听回调异常 / watch callback failed: ${errorMessage(error)}`);
                        }
                        catch {
                            // Nothing left to report to; stay silent rather than crash.
                        }
                    }
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
 * Declared configuration.
 *
 * Cordis validates the `config:` block of a profile patch against a
 * Schemastery schema and projects it for the settings UI. A hand-written
 * look-alike object is *not* accepted — the loader reports it as
 * `unsupported` and the row never mounts — so the real library is used.
 *
 * `@deepseek-ai/schemastery` is resolved through a guarded dynamic import: it
 * is present in every profile that composes the storage stack, but if a future
 * host drops it the plugin must still load and simply run unconfigured from the
 * profile patch rather than disappear.
 */
const Schema = await (async () => {
    try {
        const loaded = await import('@deepseek-ai/schemastery');
        return loaded.default ?? loaded;
    }
    catch {
        return null;
    }
})();

/** The declared configuration, or `undefined` when Schemastery is unavailable. */
export const Config = Schema === null
    ? undefined
    : Schema.object({
        repoUrl: Schema.string().default(''),
        branch: Schema.string().default(DEFAULT_BRANCH),
        backupDir: Schema.string().default(''),
        authMode: Schema.union(['credential-helper', 'https-token']).default('credential-helper'),
        tokenEnvVar: Schema.string().default(''),
        username: Schema.string().default(''),
        includeSubagentSessions: Schema.boolean().default(true),
        pushEnabled: Schema.boolean().default(true),
        pullEnabled: Schema.boolean().default(true),
        allowOverwrite: Schema.boolean().default(false),
        maxSessionMb: Schema.number().default(200),
        autoSync: Schema.object({
            enabled: Schema.boolean().default(true),
            onStartup: Schema.boolean().default(false),
            onSessionChange: Schema.boolean().default(false),
            startupDelayMs: Schema.number().default(25_000),
            debounceMs: Schema.number().default(30_000),
        }).default({}),
    });

/**
 * Merge a profile-patch configuration over the stored one.
 *
 * The patch wins where it *says something*, the saved file fills the rest.
 *
 * Cordis validates the `config:` block against the Schemastery schema before
 * the plugin ever sees it, so every declared key arrives filled in with its
 * default: an untouched `repoUrl` is `''` and looks identical to an author who
 * deliberately wrote `repoUrl: ''`. Comparing each value against the normalized
 * default is what tells the two apart — without it a restart overwrote the
 * repository the user saved in the browser with the schema's empty default.
 */
function mergeConfig(patch, stored, deviceName) {
    const merged = { ...stored };
    const defaults = normalizeConfig({}, deviceName);
    for (const [key, value] of Object.entries(patch ?? {})) {
        if (value === undefined || value === null)
            continue;
        // Machine-local identity is never taken from a shared patch.
        if (key === 'deviceName' || key === 'createdAt')
            continue;
        if (key === 'autoSync' && typeof value === 'object') {
            const auto = { ...(merged.autoSync ?? {}) };
            for (const [inner, innerValue] of Object.entries(value)) {
                if (innerValue === undefined || innerValue === null)
                    continue;
                if (innerValue === defaults.autoSync[inner])
                    continue;
                auto[inner] = innerValue;
            }
            merged.autoSync = auto;
            continue;
        }
        if (value === defaults[key])
            continue;
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
        // `ctx.logger` is optional here; the file-backed logger works without it.
        const hostLogger = ctx.get('logger');
        const logger = createLogger({ filePath: paths.logPath, host: hostLogger, ringSize: 400 });
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
        // Saving settings in the browser must take effect immediately. Without
        // this the watcher kept running with the configuration read at boot, so
        // turning automatic sync on did nothing until the next restart.
        engine.setConfigListener(next => autoSync.applyConfig(next));
        disposers.push({ dispose: () => engine.setConfigListener(null) });
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
