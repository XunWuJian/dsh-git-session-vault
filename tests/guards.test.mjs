/**
 * Unit tests for the pieces that guard against data loss and secret leakage.
 *
 * These are pure functions, so they run without a repository, a device or a
 * clock: the merge verdicts, the fork naming, the git verb guard and the
 * redaction rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MERGE_KINDS, classifyPath, forkFileName, isForkFile, planMerge } from '../src/merge.js';
import { ALLOWED_VERBS, assertSafeGitArgs, gitVersion } from '../src/git.js';
import { redactText, sanitizeRepoUrl } from '../src/util.js';

const bytes = value => Buffer.from(value);

test('append-only merge keeps both lineages instead of choosing one', () => {
    const base = bytes('turn-1');

    // Identical content is never a conflict.
    assert.equal(classifyPath(base, bytes('same'), bytes('same')).kind, MERGE_KINDS.IDENTICAL);

    // One side only: the other still holds the agreed base.
    assert.equal(classifyPath(base, bytes('turn-1turn-2'), base).kind, MERGE_KINDS.OURS_ONLY);
    assert.equal(classifyPath(base, base, bytes('turn-1turn-3')).kind, MERGE_KINDS.THEIRS_ONLY);

    // Both appended to the same base: ours stays, theirs is forked.
    const both = classifyPath(base, bytes('turn-1turn-2'), bytes('turn-1turn-3'));
    assert.equal(both.kind, MERGE_KINDS.APPEND_BOTH);
    assert.equal(both.keepOurs, true, 'the local log is kept in place');
    assert.equal(both.forkTheirs, true, 'the remote lineage is preserved');

    // A rewrite is a real divergence: still never discards a side.
    const diverged = classifyPath(base, bytes('rewritten'), bytes('turn-1turn-3'));
    assert.equal(diverged.kind, MERGE_KINDS.DIVERGED);
    assert.equal(diverged.keepOurs, true);
    assert.equal(diverged.forkTheirs, true);
});

test('binary content follows the same merge rules as text', () => {
    // A zstd frame: bytes above 0x7f and not valid UTF-8.
    const base = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]);
    const ours = Buffer.concat([base, Buffer.from([0xff, 0xfe])]);
    const theirs = Buffer.concat([base, Buffer.from([0x80, 0xc3])]);
    const verdict = classifyPath(base, ours, theirs);
    assert.equal(verdict.kind, MERGE_KINDS.APPEND_BOTH, 'a binary append is detected as an append');
});

test('a merge plan reports every verdict and collects the fork paths', () => {
    const base = bytes('base');
    const { resolutions, summary } = planMerge([
        { path: 'a', base, ours: bytes('base+1'), theirs: bytes('base+2') },
        { path: 'b', base, ours: base, theirs: bytes('base+3') },
        { path: 'c', base, ours: bytes('x'), theirs: bytes('y') },
    ]);
    assert.equal(resolutions.length, 3);
    assert.equal(summary.appended, 1);
    assert.equal(summary.adopted, 1);
    assert.equal(summary.diverged, 1);
    assert.deepEqual(summary.forkPaths.sort(), ['a', 'c'], 'only conflicting lineages are forked');
});

test('fork names are sortable, device-tagged and never mistaken for a session', () => {
    const name = forkFileName('session.v4.jsonl.zstd', 'device-a-0001', new Date('2026-11-01T12:34:56Z'));
    assert.equal(name, 'session.v4.jsonl.zstd.remote-fork-20261101123456-devicea0');
    assert.equal(isForkFile(name), true);
    assert.equal(isForkFile('session.v4.jsonl.zstd'), false, 'a normal log is not a fork file');
    // A different device must not produce the same name for the same second.
    const other = forkFileName('session.v4.jsonl.zstd', 'device-b-0002', new Date('2026-11-01T12:34:56Z'));
    assert.notEqual(name, other);
});

test('the git guard refuses force pushes and history rewrites', () => {
    // Everything the plugin actually runs must be allowed.
    for (const verb of ['fetch', 'push', 'merge', 'ls-tree', 'show', 'rev-parse', 'commit', 'add', 'checkout'])
        assert.ok(ALLOWED_VERBS.has(verb), `${verb} is allowed`);

    const refused = [
        ['push', '--force'],
        ['push', '-f'],
        ['push', '--force-with-lease'],
        ['push', 'origin', '+refs/heads/main:refs/heads/main'],
        ['reset', '--hard'],
        ['clean', '-fdx'],
        ['rebase', 'main'],
        ['commit', '--amend', '-m', 'x'],
        ['checkout', 'main'],
        ['merge', 'origin/main'],
    ];
    for (const args of refused) {
        assert.throws(
            () => assertSafeGitArgs(args),
            error => error.code === 'git-refused',
            `${args.join(' ')} is refused`,
        );
    }

    // The safe spellings the engine uses must pass.
    assertSafeGitArgs(['merge', '--ff-only', 'origin/main']);
    assertSafeGitArgs(['checkout', '-q', '-B', 'main', 'origin/main']);
    assertSafeGitArgs(['push', 'origin', 'HEAD:refs/heads/main']);
    // A read-only capability probe is not a repository action.
    assertSafeGitArgs(['--version']);
});

test('the version probe still works through the guarded runner', async () => {
    // A whitelist that also rejects `--version` would silently disable every
    // git-dependent feature, so the probe is asserted directly.
    const version = await gitVersion();
    assert.match(String(version), /^git version \d+\./u, 'git --version runs through the guard');
});

test('redaction covers token shapes, URL userinfo and key=value secrets', () => {
    const secrets = [
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
        'sk-proj-abcdefgh12345678',
        'glpat-abcdefghijklmnopqrst',
        'npm_abcdefghijklmnopqrstuvwxyz0123456789',
        'AKIAIOSFODNN7EXAMPLE',
    ];
    for (const secret of secrets) {
        const out = redactText(`pushed to ${secret} now`);
        assert.doesNotMatch(out, new RegExp(secret.slice(0, 12)), `the token is masked: ${secret.slice(0, 8)}…`);
    }

    // `user:password@` and the PAT-in-username form both leak a secret.
    assert.doesNotMatch(redactText('https://user:secret123@github.com/a/b.git'), /secret123/);
    assert.doesNotMatch(redactText('https://ghp_abcdefghijklmnopqrstuvwxyz@github.com/a/b.git'), /ghp_abc/);

    // key=value and Authorization headers.
    assert.doesNotMatch(redactText('token=abc123secret&x=1'), /abc123secret/);
    assert.doesNotMatch(redactText('password: hunter2'), /hunter2/);
    assert.doesNotMatch(redactText('Authorization: Bearer abcdefghijkl'), /abcdefghijkl/);

    // A harmless URL is left alone so logs stay readable.
    assert.match(redactText('https://github.com/team/repo.git'), /github\.com\/team\/repo\.git/);
});

test('a repository URL never carries credentials into configuration', () => {
    assert.equal(
        sanitizeRepoUrl('https://alice:ghp_secret@github.com/team/repo.git'),
        'https://github.com/team/repo.git',
    );
    assert.equal(sanitizeRepoUrl('git@github.com:team/repo.git'), 'git@github.com:team/repo.git');
});
