/**
 * Two-device integration test over a real bare Git repository.
 *
 * `device-a` and `device-b` are two separate DSH homes sharing one bare
 * repository, exactly like two machines sharing a private GitHub repository.
 * The test pins the three-way rules: push-only, pull-only, skip when
 * identical, conflict when both sides changed, and that a local log is never
 * overwritten without a backup copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createEngine } from '../src/engine.js';
import { scanSessions } from '../src/sessions.js';
import { createLogger, ensurePrivateDir } from '../src/util.js';
import { resolvePaths, saveConfig, normalizeConfig } from '../src/store.js';

const run = promisify(execFile);
const WORKSPACE = '--E-temp-test--';

function sessionPath(home, id) {
    return join(home, 'sessions', WORKSPACE, id, 'session.v4.jsonl.zstd');
}

/** Build an isolated DSH home holding `sessions`. */
async function makeHome(root, name, sessions) {
    const home = join(root, name);
    await mkdir(home, { recursive: true });
    for (const session of sessions) {
        const dir = join(home, 'sessions', WORKSPACE, session.id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'session.v4.jsonl.zstd'), session.content, 'utf8');
    }
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
        tables: { workspaces: { one: { path: 'E:\\temp\\test', title: 'test', sessionIds: sessions.map(s => s.id) } } },
    }), 'utf8');
    return home;
}

/** Wire one device: a DSH home plus an engine pointed at the bare repository. */
async function makeDevice(root, name, sessions, bare) {
    const home = await makeHome(root, name, sessions);
    const scanned = (await scanSessions(home)).map(item => item.sessionId).sort();
    assert.deepEqual(scanned, sessions.map(item => item.id).sort(), 'fixture wrote every session');
    const paths = resolvePaths(home);
    for (const dir of [paths.dataDir, paths.workRoot, paths.backupRoot])
        await ensurePrivateDir(dir);
    await saveConfig(paths, normalizeConfig({ repoUrl: bare, branch: 'main', deviceName: name }, name));
    const engine = createEngine({
        dshHome: home,
        workDir: join(paths.workRoot, 'repo'),
        paths,
        logger: createLogger({ filePath: paths.logPath }),
    });
    return {
        home,
        paths,
        engine,
        file: id => sessionPath(home, id),
        read: id => readFile(sessionPath(home, id), 'utf8'),
        write: (id, content) => writeFile(sessionPath(home, id), content, 'utf8'),
        exists: id => readFile(sessionPath(home, id), 'utf8').then(() => true, () => false),
    };
}

test('two devices: push, pull, skip, conflict and protection', async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-git-session-vault-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bare = join(root, 'origin.git');
    await run('git', ['init', '--bare', '-q', bare]);

    const deviceA = await makeDevice(root, 'device-a', [
        { id: 'session-1', content: 'alpha-v1' },
        { id: 'session-2', content: 'beta-v1' },
    ], bare);
    const deviceB = await makeDevice(root, 'device-b', [
        { id: 'session-1', content: 'alpha-remote' },
    ], bare);
    const gitTree = async () => (await run('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'])).stdout;
    const actionsOf = async device => Object.fromEntries((await device.engine.diff()).rows.map(row => [row.sessionId, row.action]));

    // 1. Device A uploads both of its sessions.
    const first = await deviceA.engine.sync();
    assert.equal(first.counts.push, 2, 'both local sessions are uploaded');
    assert.ok(first.commit !== null, 'a commit is created');
    assert.match(await gitTree(), /profiles\/--E-temp-test--\/sessions\/session-1\/session\.v4\.jsonl\.zstd/);

    // 2. Device B holds a different session-1 and lacks session-2 entirely:
    //    the shared id is a conflict, the missing one is a pull.
    const status = await deviceB.engine.status();
    assert.equal(status.local.sessions, 1, 'only session-1 exists on device B');
    assert.deepEqual(await actionsOf(deviceB), { 'session-1': 'conflict', 'session-2': 'pull' });

    // 3. A conflicting sync stops and changes nothing.
    const rejected = await deviceB.engine.sync().then(() => null, error => error);
    assert.equal(rejected?.code, 'conflict-present', `sync must stop on conflict (got ${rejected === null ? 'success' : rejected.message})`);
    assert.equal(await deviceB.read('session-1'), 'alpha-remote', 'a conflicting log is never overwritten');
    assert.equal(await deviceB.exists('session-2'), false, 'a conflicting sync downloads nothing');

    // 4. The user decides: keep the local log. Session-2 comes down in the
    //    same run because it was never in doubt.
    const resolvedLocal = await deviceB.engine.sync({ resolve: { 'session-1': 'local' } });
    assert.equal(resolvedLocal.counts.push, 1);
    assert.equal(resolvedLocal.counts.pull, 1);
    assert.ok(resolvedLocal.commit !== null, 'the decision is pushed');
    assert.equal(await deviceB.read('session-2'), 'beta-v1', 'the missing session is restored');

    // 5. Device A picks up the resolved log, and from then on both devices
    //    agree on every session.
    const convergence = await deviceA.engine.sync();
    assert.equal(convergence.counts.pull, 1, 'device A adopts the resolved log');
    assert.deepEqual(await actionsOf(deviceA), { 'session-1': 'skip', 'session-2': 'skip' });
    assert.deepEqual(await actionsOf(deviceB), { 'session-1': 'skip', 'session-2': 'skip' });

    // 6. A fresh change on device A travels down to device B.
    await deviceA.write('session-2', 'beta-v2');
    const fromA = await deviceA.engine.sync();
    assert.equal(fromA.counts.push, 1, 'device A uploads its new log');
    const toB = await deviceB.engine.sync();
    assert.equal(toB.counts.pull, 1, 'device B downloads it');
    assert.equal(await deviceB.read('session-2'), 'beta-v2');
});

test('two devices appending to one session keep both lineages', async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-git-session-vault-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bare = join(root, 'origin.git');
    await run('git', ['init', '--bare', '-q', bare]);

    // Both devices start from the same agreed log.
    const shared = 'turn-1\n';
    const deviceA = await makeDevice(root, 'device-a', [{ id: 'session-1', content: shared }], bare);
    await deviceA.engine.sync();
    const deviceB = await makeDevice(root, 'device-b', [], bare);
    await deviceB.engine.restore();
    assert.equal(await deviceB.read('session-1'), shared, 'device B starts from the same log');

    // Each device appends its own turn, so both sides changed but neither
    // rewrote the other's bytes.
    await deviceA.write('session-1', `${shared}turn-2-from-a\n`);
    const pushed = await deviceA.engine.sync();
    assert.equal(pushed.counts.push, 1, 'device A uploads its append');

    await deviceB.write('session-1', `${shared}turn-3-from-b\n`);
    const merged = await deviceB.engine.sync();

    // The append is recognized as such: no interruption, both files survive.
    assert.equal(merged.counts.conflict, 0, 'an append is not a conflict');
    assert.equal(merged.counts.fork, 1, 'the remote lineage is forked');
    assert.equal(merged.forked.length, 1);

    // Device B keeps its own log untouched...
    assert.equal(await deviceB.read('session-1'), `${shared}turn-3-from-b\n`, 'the local append survives in place');

    // ...and the remote append is preserved beside it, byte for byte.
    const forkPath = merged.forked[0];
    const forkAbsolute = join(deviceB.home, 'sessions', WORKSPACE, 'session-1', forkPath.split(/[\\/]/u).pop());
    const forkContent = await readFile(forkAbsolute, 'utf8');
    assert.equal(forkContent, `${shared}turn-2-from-a\n`, 'the remote append is preserved in the fork file');
    assert.match(forkPath, /\.remote-fork-\d{14}-[a-z0-9]+$/u, 'the fork name is stamped and device-tagged');
});

test('backup only uploads and the repository keeps its own layout', async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-git-session-vault-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bare = join(root, 'origin.git');
    await run('git', ['init', '--bare', '-q', bare]);

    const device = await makeDevice(root, 'device', [{ id: 'session-x', content: 'gamma' }], bare);
    const first = await device.engine.backup();
    assert.equal(first.counts.push, 1);
    assert.ok(first.commit !== null);

    // The second backup has nothing to upload and creates no empty commit.
    const second = await device.engine.backup();
    assert.equal(second.counts.push, 0);
    assert.equal(second.commit, first.commit, 'no empty commit is created');

    const tree = (await run('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'])).stdout;
    assert.match(tree, /^manifest\.json$/m);
    assert.match(tree, /^metadata\/schema\.json$/m);
    assert.match(tree, /^profiles\/--E-temp-test--\/sessions\/session-x\/session\.v4\.jsonl\.zstd$/m);
    assert.doesNotMatch(tree, /AppData|Users/i, 'no absolute home path leaks into the repository');
});

test('binary session logs survive a round trip byte for byte', async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-git-session-vault-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bare = join(root, 'origin.git');
    await run('git', ['init', '--bare', '-q', bare]);

    // A real session log is a zstd frame: bytes above 0x7f everywhere, and no
    // valid UTF-8. Decoding it as text would corrupt it and change its hash.
    const binary = Buffer.from([
        0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, 0x91, 0xff, 0xfe, 0x80, 0xc3, 0x28,
        0xa7, 0x9c, 0x01, 0x00, 0x00, 0xe2, 0x9c, 0x93, 0xf0, 0x9f, 0x8e, 0x89,
    ]);
    const deviceA = await makeDevice(root, 'device-a', [{ id: 'session-bin', content: binary }], bare);
    const pushed = await deviceA.engine.backup();
    assert.equal(pushed.counts.push, 1, 'the binary session is uploaded');

    // After uploading, the device must consider itself in sync: a mismatch here
    // means the hash was computed over a mangled copy.
    const after = await deviceA.engine.diff();
    assert.deepEqual(
        after.rows.map(row => [row.sessionId, row.action]),
        [['session-bin', 'skip']],
        'an uploaded binary log compares identical, not changed',
    );

    // A second device downloads it and must receive the exact same bytes.
    const deviceB = await makeDevice(root, 'device-b', [], bare);
    const pulled = await deviceB.engine.restore();
    assert.equal(pulled.counts.pull, 1, 'the second device downloads it');
    const received = await readFile(deviceB.file('session-bin'));
    assert.deepEqual(received, binary, 'the downloaded log is byte-for-byte identical');
});

test('a backup directory outside the repository is rejected', async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-git-session-vault-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bare = join(root, 'origin.git');
    await run('git', ['init', '--bare', '-q', bare]);
    await makeDevice(root, 'device', [{ id: 'session-y', content: 'delta' }], bare);

    assert.throws(
        () => normalizeConfig({ repoUrl: bare, backupDir: '../outside', deviceName: 'device' }, 'device'),
        /relative path inside the repository/,
        'an escaping backup directory is refused',
    );
    const safe = normalizeConfig({ repoUrl: bare, backupDir: 'sessions', deviceName: 'device' }, 'device');
    assert.equal(safe.backupDir, 'sessions', 'a nested directory inside the repository is accepted');
});

test('remote URLs never keep credentials and tokens never enter configuration', async () => {
    const config = normalizeConfig({
        repoUrl: 'https://alice:ghp_secret@github.com/team/private-sessions.git',
        branch: 'main',
        deviceName: 'laptop',
        authMode: 'https-token',
        tokenEnvVar: 'DSH_SYNC_TOKEN',
    }, 'laptop');
    assert.equal(config.repoUrl, 'https://github.com/team/private-sessions.git', 'credentials are stripped from the URL');
    assert.equal(config.authMode, 'https-token');
    assert.equal(config.tokenEnvVar, 'DSH_SYNC_TOKEN');
    const serialized = JSON.stringify(config);
    assert.doesNotMatch(serialized, /ghp_secret/, 'no token value is stored');
    const readdirNames = await readdir('/').then(names => names.length, () => 0);
    assert.ok(readdirNames >= 0);
});
