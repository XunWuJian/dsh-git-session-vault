/**
 * Regression tests for two defects found by installing the plugin into a real
 * profile and starting the host:
 *
 * 1. `noteAutoSync` called `saveState` without importing it. Every automatic
 *    sync then threw `saveState is not defined`, so the outcome was never
 *    recorded — the settings page kept showing the previous run and the failure
 *    counter never moved.
 *
 * 2. `mergeConfig` treated the schema's filled-in defaults as if the profile
 *    patch had written them. Cordis validates `config:` against the Schemastery
 *    schema first, so an untouched `repoUrl` arrives as `''` — identical to an
 *    author who deliberately cleared it. The result was that a restart replaced
 *    the repository saved in the browser with `''`, and the next sync failed
 *    with `not-configured`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A DSH home containing one session and nothing else. */
async function makeHome() {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'vault-regress-')));
    const dir = join(home, 'sessions', '--E-test--', 'session-1');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'session.v4.jsonl.zstd');
    await writeFile(file, 'x', 'utf8');
    // The archive is idle-gated at 20s: a file fresh from `writeFile` blocks
    // every automatic run, so backdate it the way a finished session looks.
    const past = new Date(Date.now() - 60_000);
    await utimes(file, past, past);
    return home;
}

/** A context with the services the entry reaches for. */
function makeContext() {
    const routes = new Map();
    const logs = [];
    let disposeLifecycle = null;
    const ctx = {
        logger: {
            debug() {},
            info: message => logs.push(['info', String(message)]),
            warn: message => logs.push(['warn', String(message)]),
            error: message => logs.push(['error', String(message)]),
        },
        timer: {
            setTimeout: (callback, ms) => setTimeout(callback, ms),
            clearTimeout: handle => clearTimeout(handle),
        },
        get(service) {
            if (service === 'connection') {
                return {
                    registerFetchRoute: (owner, route) => {
                        routes.set(route.path, route);
                        return () => {};
                    },
                };
            }
            return undefined;
        },
        inject(services, callback) {
            // Cordis runs the callback once every named service is available.
            // `connection` is the only one this plugin asks for this way.
            const available = services.every(service => ctx.get(service) !== undefined);
            if (available)
                callback(ctx);
            return () => {};
        },
        effect(callback) {
            const disposer = callback();
            const teardown = typeof disposer === 'function' ? disposer : () => {};
            disposeLifecycle = teardown;
            return teardown;
        },
    };
    // Auto-sync keeps rescheduling while a session file is fresh, which would
    // hold the test process open forever; every test tears its fiber down.
    const dispose = () => {
        if (disposeLifecycle !== null)
            disposeLifecycle();
        disposeLifecycle = null;
    };
    return { ctx, routes, logs, dispose };
}

test('an automatic sync records its outcome instead of throwing on saveState', async () => {
    const home = await makeHome();
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    const { ctx, routes, logs, dispose } = makeContext();
    try {
        const plugin = await import('../src/index.js');
        plugin.apply(ctx, {});
        await new Promise(resolve => setTimeout(resolve, 1500));
        assert.ok(routes.size > 0, 'the plugin mounted');

        // Arm automatic sync through the settings page, exactly as the Web UI
        // does. `autoSync` is deliberately not passed to `apply`: the schema
        // fills it with `enabled: false`, which would never schedule a run.
        const save = routes.get('/api/dsh-git-session-vault/config/save');
        const armed = await save.fetch(new Request('http://localhost/api/dsh-git-session-vault/config/save', {
            method: 'POST',
            body: JSON.stringify({
                config: { autoSync: { enabled: true, onSessionChange: false, debounceMs: 5000 } },
            }),
        }));
        assert.equal(armed.status, 200, 'automatic sync was armed');

        // Trigger the watcher-driven run: an archive event schedules it.
        const session = join(home, 'sessions', '--E-test--', 'session-1', 'session.v4.jsonl.zstd');
        await writeFile(session, 'changed', 'utf8');
        const past = new Date(Date.now() - 60_000);
        await utimes(session, past, past);
        await new Promise(resolve => setTimeout(resolve, 7000));

        const undefinedReference = logs.filter(([, message]) => /is not defined/.test(message));
        assert.deepEqual(
            undefinedReference,
            [],
            `no undefined identifier was hit (${JSON.stringify(undefinedReference)})`,
        );

        // `noteAutoSync` writes this file; a `saveState is not defined` throw
        // left it missing entirely.
        const state = JSON.parse(await readFile(join(home, 'dsh-git-session-vault', 'state.json'), 'utf8'));
        assert.ok(state.autoSync, 'the automatic-sync block was persisted');
        assert.notEqual(state.autoSync.lastRunAt, null, 'the run outcome was recorded');
    }
    finally {
        dispose();
        if (previousHome === undefined)
            delete process.env.DSH_HOME;
        else
            process.env.DSH_HOME = previousHome;
        await rm(home, { recursive: true, force: true });
    }
});

test('a schema-filled profile patch does not erase the repository saved in the browser', async () => {
    const home = await makeHome();
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    const first = makeContext();
    const second = makeContext();
    try {
        const plugin = await import('../src/index.js');

        // First boot: the user saves a repository through the settings page.
        plugin.apply(first.ctx, {});
        await new Promise(resolve => setTimeout(resolve, 1500));
        const route = first.routes.get('/api/dsh-git-session-vault/config/save');
        assert.ok(route, 'the config/save route exists');
        const saved = await route.fetch(new Request('http://localhost/api/dsh-git-session-vault/config/save', {
            method: 'POST',
            body: JSON.stringify({ config: { repoUrl: 'https://example.invalid/private.git' } }),
        }));
        assert.equal(saved.status, 200, 'the repository was saved');

        // Second boot: Cordis hands over the whole schema, defaults included.
        // Every field below is exactly what an untouched `config:` block yields.
        plugin.apply(second.ctx, {
            repoUrl: '',
            branch: 'main',
            backupDir: '',
            authMode: 'credential-helper',
            tokenEnvVar: '',
            username: '',
            includeSubagentSessions: true,
            pushEnabled: true,
            pullEnabled: true,
            allowOverwrite: false,
            maxSessionMb: 200,
            autoSync: {
                enabled: false,
                onStartup: false,
                onSessionChange: false,
                startupDelayMs: 25000,
                debounceMs: 30000,
            },
        });
        await new Promise(resolve => setTimeout(resolve, 1500));

        const config = JSON.parse(await readFile(join(home, 'dsh-git-session-vault', 'config.json'), 'utf8'));
        assert.equal(
            config.repoUrl,
            'https://example.invalid/private.git',
            'the saved repository survived the restart',
        );
    }
    finally {
        first.dispose();
        second.dispose();
        if (previousHome === undefined)
            delete process.env.DSH_HOME;
        else
            process.env.DSH_HOME = previousHome;
        await rm(home, { recursive: true, force: true });
    }
});
