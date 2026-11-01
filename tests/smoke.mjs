/**
 * Smoke test of the built host half against a fake Cordis context.
 *
 * It proves the plugin can boot without any real Host service: `apply` must
 * survive a context that offers only `effect`, `get`, `inject`, `timer` and
 * `logger`, must register its HTTP routes, and must register its agent tools
 * once a `tools` service appears.
 */
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-smoke-')));
process.env.DSH_HOME = home;

// A session archive so the engine has something to report.
const workspace = '--E-temp-smoke--';
const sessionDir = join(home, 'sessions', workspace, 'session-smoke');
await mkdir(sessionDir, { recursive: true });
await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'smoke', 'utf8');
await mkdir(join(home, 'storages'), { recursive: true });
await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: { one: { path: 'E:\\temp\\smoke', title: 'smoke', sessionIds: ['session-smoke'] } } },
}), 'utf8');

const routes = new Map();
const tools = [];
const logs = [];
const effects = [];

const fakeConnection = {
    fetch: {
        register(options) {
            routes.set(options.path, options);
            return () => routes.delete(options.path);
        },
    },
};

const fakeTools = {
    register(definition) {
        tools.push(definition);
        return () => undefined;
    },
};

const ctx = {
    logger: {
        debug: message => logs.push(['debug', message]),
        info: message => logs.push(['info', message]),
        warn: message => logs.push(['warn', message]),
        error: message => logs.push(['error', message]),
    },
    timer: {
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: handle => clearTimeout(handle),
    },
    effect(callback) {
        effects.push(callback());
        return () => undefined;
    },
    get(service) {
        if (service === 'connection')
            return fakeConnection;
        if (service === 'tools')
            return fakeTools;
        return undefined;
    },
    inject(services, callback) {
        const available = services.filter(service => this.get(service) !== undefined);
        if (available.length === services.length)
            callback(this);
        return () => undefined;
    },
};

const plugin = await import('../lib/index.js');
assert.equal(plugin.name, 'dsh-session-vault', 'plugin name matches the package name');
assert.deepEqual(plugin.inject, [], 'no hard service dependency');
plugin.apply(ctx);

// `apply` starts asynchronously inside an effect; give it a moment to settle.
await new Promise(resolve => setTimeout(resolve, 1500));

const routeNames = [...routes.keys()].sort();
assert.ok(routeNames.length > 0, 'HTTP routes were registered');
assert.ok(routeNames.includes('/api/dsh-session-vault/status'), 'the status route exists');
assert.ok(routeNames.includes('/api/dsh-session-vault/sync'), 'the sync route exists');

const toolNames = tools.map(tool => tool.name).sort();
assert.ok(toolNames.includes('dsh_session_sync_status'), 'the status tool exists');
assert.ok(toolNames.includes('dsh_session_sync_diff'), 'the diff tool exists');
assert.ok(toolNames.includes('dsh_session_sync_sync'), 'the sync tool exists');

// Exercise one route end to end through its registered handler.
const statusRoute = routes.get('/api/dsh-session-vault/status');
const response = await statusRoute.fetch(new Request('http://localhost/api/dsh-session-vault/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
}));
const payload = await response.json();
assert.equal(payload.ok, true, 'the status route answers with a success envelope');
assert.equal(payload.value.configured, false, 'nothing is configured yet');
assert.equal(payload.value.local.sessions, 1, 'the fake session archive is counted');

// A bad body must come back as a typed failure, not an exception.
const badBody = await statusRoute.fetch(new Request('http://localhost/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
}));
const badPayload = await badBody.json();
assert.equal(badPayload.ok, false, 'an invalid body is refused');
assert.equal(badPayload.error.code, 'invalid-config');

const errors = logs.filter(([level]) => level === 'error');
assert.equal(errors.length, 0, `no errors were logged (got ${JSON.stringify(errors)})`);

console.log('smoke ok');
console.log('  routes:', routeNames.length);
console.log('  tools:', toolNames.join(', '));
console.log('  sessions counted:', payload.value.local.sessions);
console.log('  log levels:', [...new Set(logs.map(([level]) => level))].join(','));

await rm(home, { recursive: true, force: true });
// The archive watcher keeps a libuv handle open on Windows; exit explicitly.
process.exit(0);
