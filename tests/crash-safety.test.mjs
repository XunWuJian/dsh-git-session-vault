/**
 * Crash-safety tests for the host entry.
 *
 * The plugin runs inside the DSH host process, so an uncaught throw from a
 * callback does not just fail a feature — it takes the whole application down
 * (observed as "应用无法启动或已意外停止" with
 * `cannot get property "timer" without inject`). These tests pin the two rules
 * that prevent it: every required service is declared in `inject`, and the
 * session watcher callback never throws.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Build a minimal DSH home with one session file. */
async function makeHome() {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'vault-crash-')));
    const dir = join(home, 'sessions', '--E-test--', 'session-1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x', 'utf8');
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
        tables: { workspaces: { one: { path: 'E:\\test', title: 'test', sessionIds: ['session-1'] } } },
    }), 'utf8');
    return home;
}

test('every service the entry touches is declared in inject', async () => {
    const plugin = await import('../src/index.js');
    assert.ok(Array.isArray(plugin.inject), 'inject is a service list');
    // `timer` is read from the watcher callback; Cordis throws on an undeclared
    // access, and that throw is uncaught inside `fs.watch`.
    assert.ok(plugin.inject.includes('timer'), 'timer is a declared dependency');
});

test('a context without an injected timer cannot crash the watcher', async () => {
    const home = await makeHome();
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
        const plugin = await import('../src/index.js');
        const routes = new Map();
        const logs = [];

        // A hostile context: `timer` is missing even though it is declared, and
        // every optional service is absent. The entry must survive.
        const ctx = {
            logger: {
                debug() {},
                info: message => logs.push(['info', String(message)]),
                warn: message => logs.push(['warn', String(message)]),
                error: message => logs.push(['error', String(message)]),
            },
            timer: undefined,
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
                // Report no service as available, which is the worst case.
                void services;
                void callback;
                return () => {};
            },
            effect(callback) {
                const disposer = callback();
                return typeof disposer === 'function' ? disposer : () => {};
            },
        };

        plugin.apply(ctx, { repoUrl: '', branch: 'main' });
        // Give the asynchronous start a chance to touch every service.
        await new Promise(resolve => setTimeout(resolve, 1200));

        assert.ok(routes.size > 0, `HTTP routes registered despite the missing timer (${routes.size})`);
        assert.ok(
            !logs.some(([level]) => level === 'error'),
            `nothing was logged as an error (${JSON.stringify(logs.filter(([l]) => l === 'error'))})`,
        );
    }
    finally {
        if (previousHome === undefined)
            delete process.env.DSH_HOME;
        else
            process.env.DSH_HOME = previousHome;
        await rm(home, { recursive: true, force: true });
    }
});

test('the watcher callback stays silent when the plugin is disposed', async () => {
    const home = await makeHome();
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
        const plugin = await import('../src/index.js');
        let lifecycleDisposer = null;
        const ctx = {
            logger: { debug() {}, info() {}, warn() {}, error() {} },
            timer: { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: handle => clearTimeout(handle) },
            get() {
                return undefined;
            },
            inject() {
                return () => {};
            },
            effect(callback) {
                const disposer = callback();
                lifecycleDisposer = typeof disposer === 'function' ? disposer : () => {};
                return lifecycleDisposer;
            },
        };

        plugin.apply(ctx, { repoUrl: '', branch: 'main' });
        await new Promise(resolve => setTimeout(resolve, 800));

        // Touching the archive after teardown must not throw into the host.
        assert.equal(typeof lifecycleDisposer, 'function', 'the lifecycle disposer exists');
        assert.doesNotThrow(() => lifecycleDisposer());
        await writeFile(join(home, 'sessions', '--E-test--', 'session-1', 'session.v4.jsonl.zstd'), 'y', 'utf8');
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    finally {
        if (previousHome === undefined)
            delete process.env.DSH_HOME;
        else
            process.env.DSH_HOME = previousHome;
        await rm(home, { recursive: true, force: true });
    }
});
