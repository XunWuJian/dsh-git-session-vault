/**
 * Session titles: the settings table shows the name the sidebar uses, not the
 * opaque id.
 *
 * Two sources exist and both are exercised here:
 *
 *   1. `storages/session_projcache/sessions/<id>.json` — what the desktop
 *      caches, fast but only present for sessions this machine has opened;
 *   2. a `session/title` event inside the log — authoritative, but it costs a
 *      decompression, so it is the fallback.
 *
 * A session with neither is reported as untitled rather than inheriting a
 * neighbour's name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
    readCachedTitles,
    readSessionTitleFromLog,
    readWorkspaceTitles,
    readableWorkspaceKey,
    scanSessions,
} from '../src/sessions.js';

const WORKSPACE = '--E-temp-test--';

/** One zstd frame holding `events` as JSONL. */
function frame(events) {
    return zstdCompressSync(Buffer.from(`${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8'));
}

/** Build a DSH home with the given sessions. */
async function makeHome(sessions, cached = {}) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'vault-titles-')));
    for (const session of sessions) {
        const dir = join(home, 'sessions', WORKSPACE, session.id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'session.v4.jsonl.zstd'), session.content);
    }
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
        tables: { workspaces: { one: { path: 'E:\\temp\\test', title: 'test', sessionIds: sessions.map(s => s.id) } } },
    }), 'utf8');
    const cacheDir = join(home, 'storages', 'session_projcache', 'sessions');
    await mkdir(cacheDir, { recursive: true });
    for (const [id, title] of Object.entries(cached)) {
        await writeFile(join(cacheDir, `${id}.json`), JSON.stringify({
            version: 7,
            record: { rows: { title: { ver: 1, seq: 2402, val: title } } },
        }), 'utf8');
    }
    return home;
}

test('a title in the projection cache is read without touching the log', async () => {
    const home = await makeHome(
        [{ id: 'session-one', content: frame([{ type: 'session', id: 'session-one' }]) }],
        { 'session-one': '安装并排查消息备份插件' },
    );
    try {
        const titles = await readCachedTitles(home);
        assert.equal(titles.get('session-one'), '安装并排查消息备份插件');
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('the last session/title event in a log wins over the fallback', async () => {
    const home = await makeHome([{
        id: 'session-two',
        content: frame([
            { type: 'session', id: 'session-two' },
            { type: 'session/title', data: { title: '帮我检查消息备份这个插件，', source: { kind: 'fallback' } } },
            { type: 'session/title', data: { title: '安装并排查消息备份插件', source: { kind: 'provider' } } },
        ]),
    }]);
    try {
        const entries = await scanSessions(home);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].title, '安装并排查消息备份插件');
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('a title written in a later zstd frame is still found', async () => {
    const home = await makeHome([{
        id: 'session-three',
        // Two frames concatenated: the title only appears in the second.
        content: Buffer.concat([
            frame([{ type: 'session', id: 'session-three' }]),
            frame([{ type: 'session/title', data: { title: '跨帧标题', source: { kind: 'provider' } } }]),
        ]),
    }]);
    try {
        const title = await readSessionTitleFromLog(join(home, 'sessions', WORKSPACE, 'session-three', 'session.v4.jsonl.zstd'));
        assert.equal(title, '跨帧标题');
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('an untitled session reports null instead of borrowing a name', async () => {
    const home = await makeHome([
        { id: 'session-titled', content: frame([{ type: 'session/title', data: { title: '有标题' } }]) },
        { id: 'session-bare', content: frame([{ type: 'session', id: 'session-bare' }]) },
    ]);
    try {
        const entries = await scanSessions(home);
        const byId = new Map(entries.map(entry => [entry.sessionId, entry]));
        assert.equal(byId.get('session-titled').title, '有标题');
        assert.equal(byId.get('session-bare').title, null);
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('the cache wins over the log, and titles can be skipped entirely', async () => {
    const home = await makeHome(
        [{ id: 'session-four', content: frame([{ type: 'session/title', data: { title: '日志里的旧标题' } }]) }],
        { 'session-four': '缓存里的新标题' },
    );
    try {
        const [entry] = await scanSessions(home);
        assert.equal(entry.title, '缓存里的新标题', 'the cache is authoritative when present');

        const [bare] = await scanSessions(home, { titles: false });
        // Without the log walk only the cache can answer.
        assert.equal(bare.title, '缓存里的新标题');
        assert.equal(bare.sessionId, 'session-four');
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('an uncompressed session log is read too', async () => {
    const home = await makeHome([{
        id: 'session-plain',
        content: Buffer.from(`${JSON.stringify({ type: 'session/title', data: { title: '明文日志标题' } })}\n`, 'utf8'),
    }]);
    try {
        const [entry] = await scanSessions(home);
        assert.equal(entry.title, '明文日志标题');
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('a workspace directory name is decoded only as a last resort', () => {
    // The lossless case: the platform separator comes back.
    assert.equal(readableWorkspaceKey('--E-IFile-temp-douyin--'), 'E:\\IFile\\temp\\douyin');
    // The lossy case this function exists to paper over: `ds-test` and
    // `ds\test` encode identically, so callers must prefer the recorded path.
    assert.equal(readableWorkspaceKey('--E-temp-ds-test--'), 'E:\\temp\\ds\\test');
    // Anything not in the encoded shape is left alone.
    assert.equal(readableWorkspaceKey('weird-key'), 'weird-key');
    assert.equal(readableWorkspaceKey(''), '');
});

test('the recorded workspace path is exposed per session', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'vault-wspath-')));
    const dir = join(home, 'sessions', WORKSPACE, 'session-five');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), frame([{ type: 'session', id: 'session-five' }]));
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
        tables: {
            workspaces: {
                one: {
                    // The real path keeps its hyphen, which the directory name
                    // cannot express.
                    path: 'E:\\temp\\ds-test',
                    title: 'ds-test',
                    sessionIds: ['session-five'],
                },
            },
        },
    }), 'utf8');
    try {
        const { byPath, bySession } = await readWorkspaceTitles(home);
        assert.equal(byPath.get('session-five'), 'E:\\temp\\ds-test');
        assert.equal(bySession.get('session-five'), 'ds-test');

        const [entry] = await scanSessions(home);
        assert.equal(entry.workspacePath, 'E:\\temp\\ds-test');
        assert.equal(entry.workspaceTitle, 'ds-test');
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});
