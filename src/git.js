/**
 * Git process runner.
 *
 * Every Git invocation goes through here so that these invariants hold
 * everywhere:
 *
 * - arguments are passed as an array (no shell, so a repository URL cannot
 *   inject a command);
 * - the verb is on a whitelist and destructive flags are refused *at runtime*,
 *   so a future edit cannot quietly introduce a force push or a hard reset;
 * - prompts are disabled (an operation never blocks waiting for a password);
 * - credentials in remote URLs are stripped from captured output before it
 *   reaches a log or the browser.
 * @module git
 */
import { spawn } from 'node:child_process';
import { MAX_GIT_OUTPUT_BYTES } from './constants.js';
import { SyncError, errorMessage, redactText, sanitizeRepoUrl } from './util.js';

/**
 * Verbs this plugin may run.
 *
 * Deliberately absent: `reset`, `clean`, `rebase`, `rm`, `filter-branch`,
 * `gc`, `prune`. None of them is needed to move session bytes, and each can
 * destroy history or working-tree state.
 */
export const ALLOWED_VERBS = new Set([
    'init',
    'config',
    'remote',
    'add',
    'commit',
    'push',
    'fetch',
    'merge',
    'merge-base',
    'rev-parse',
    'log',
    'diff',
    'cat-file',
    'show',
    'checkout',
    'ls-files',
    'ls-tree',
    'ls-remote',
    'status',
    'hash-object',
    'rev-list',
]);

/** Flags that would let a command rewrite or discard history. */
const FORBIDDEN_PUSH_FLAGS = new Set(['-f', '--force', '--force-with-lease', '--mirror', '--prune-tags', '--delete']);

/** Reject one command that is not a safe primitive. */
export function assertSafeGitArgs(args) {
    const verb = args[0] ?? '';
    if (!ALLOWED_VERBS.has(verb)) {
        throw new SyncError('git-refused', `禁止的 git 子命令 / forbidden git verb: ${JSON.stringify(verb)}`);
    }
    for (const arg of args.slice(1)) {
        if (verb === 'push' && (FORBIDDEN_PUSH_FLAGS.has(arg) || arg.startsWith('+') || arg.startsWith('--force'))) {
            throw new SyncError('git-refused', `禁止强推 / refusing to force-push: ${JSON.stringify(arg)}`);
        }
        if (arg === '--hard' || arg === '--force') {
            throw new SyncError('git-refused', `禁止的破坏性参数 / destructive flag refused: ${JSON.stringify(arg)}`);
        }
    }
    if (verb === 'commit' && args.includes('--amend')) {
        throw new SyncError('git-refused', '禁止改写历史 / git commit --amend is refused (history is append-only)');
    }
    if (verb === 'checkout' && !args.includes('--ours') && !args.includes('--theirs') &&
        !args.some(arg => arg === '-b' || arg === '-B')) {
        throw new SyncError('git-refused', 'checkout 仅允许 --ours/--theirs 或新建分支 / checkout is only allowed for explicit paths or a new branch');
    }
    if (verb === 'merge' && !args.includes('--no-commit') && !args.includes('--abort') && !args.includes('--ff-only')) {
        throw new SyncError('git-refused', 'merge 必须显式声明策略 / merge requires --no-commit, --abort or --ff-only');
    }
}

/** Environment overrides that make Git deterministic and non-interactive. */
function gitEnvironment(token) {
    const env = { ...process.env };
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_ASKPASS = env.GIT_ASKPASS ?? 'echo';
    env.GCM_INTERACTIVE = 'never';
    env.LC_ALL = 'C';
    env.LANG = 'C';
    env.GIT_PAGER = 'cat';
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    if (token !== undefined && token !== '') {
        // A one-shot credential helper: the token never appears in argv (visible
        // in the process list) and never touches disk.
        env.DSH_SESSION_SYNC_GIT_USERNAME = token.username;
        env.DSH_SESSION_SYNC_GIT_PASSWORD = token.password;
        env.GIT_CONFIG_COUNT = '1';
        env.GIT_CONFIG_KEY_0 = 'credential.helper';
        env.GIT_CONFIG_VALUE_0 = '!f() { echo "username=${DSH_SESSION_SYNC_GIT_USERNAME}"; echo "password=${DSH_SESSION_SYNC_GIT_PASSWORD}"; }; f';
    }
    return env;
}

/**
 * Run one Git command; resolve with stdout/stderr, reject with a SyncError.
 *
 * `options.binary` keeps stdout as a `Buffer`. Session logs are zstd-compressed
 * binary files, so decoding them as UTF-8 would corrupt every byte above 0x7f
 * and change their hash. Text callers keep the decoded string.
 */
export function runGit(args, options = {}) {
    return new Promise((resolve, reject) => {
        // Runtime guard, not a comment: a caller that invents a destructive
        // command fails here instead of damaging the user's repository.
        try {
            assertSafeGitArgs(args);
        }
        catch (error) {
            reject(error);
            return;
        }
        let child;
        try {
            child = spawn('git', args, {
                cwd: options.cwd,
                env: gitEnvironment(options.token),
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                maxBuffer: MAX_GIT_OUTPUT_BYTES,
            });
        }
        catch (error) {
            reject(new SyncError('git-unavailable', `无法启动 git / cannot start git: ${redactText(errorMessage(error))}`));
            return;
        }
        const out = [];
        const err = [];
        let outBytes = 0;
        let killed = false;
        const timer = options.timeoutMs === undefined
            ? null
            : setTimeout(() => {
                killed = true;
                child.kill();
            }, options.timeoutMs);
        child.stdout.on('data', chunk => {
            outBytes += chunk.length;
            if (outBytes > MAX_GIT_OUTPUT_BYTES) {
                killed = true;
                child.kill();
                return;
            }
            out.push(chunk);
        });
        child.stderr.on('data', chunk => {
            if (err.length < 512)
                err.push(chunk);
        });
        child.on('error', error => {
            if (timer !== null)
                clearTimeout(timer);
            const code = error && error.code === 'ENOENT' ? 'git-unavailable' : 'git-failed';
            reject(new SyncError(code, code === 'git-unavailable'
                ? '未找到 git，请先安装 Git 并加入 PATH / git was not found; install Git and add it to PATH'
                : redactText(errorMessage(error))));
        });
        child.on('close', status => {
            if (timer !== null)
                clearTimeout(timer);
            const stdoutBuffer = Buffer.concat(out);
            const stdout = stdoutBuffer.toString('utf8');
            const stderr = redactText(Buffer.concat(err).toString('utf8'));
            if (killed) {
                reject(new SyncError('git-failed', 'git 操作超时或被中断 / git operation timed out or was interrupted', { stderr }));
                return;
            }
            if (status !== 0) {
                reject(new SyncError('git-failed', redactText(stderr.trim() || `git exited with ${status}`), {
                    args: redactArgs(args),
                    code: status,
                }));
                return;
            }
            resolve({ stdout, stdoutBuffer, stderr });
        });
    });
}

/** Hide remote URLs that may embed credentials from error details. */
function redactArgs(args) {
    return args.map(arg => (/^https?:\/\//i.test(arg) ? sanitizeRepoUrl(arg) : /^git@/.test(arg) ? arg.replace(/\/\/[^/@]*@/, '//') : arg));
}

/** Git version string, or `null` when Git is unusable. */
export async function gitVersion() {
    try {
        const { stdout } = await runGit(['--version'], { timeoutMs: 15_000 });
        return stdout.trim();
    }
    catch {
        return null;
    }
}

/** Split NUL-separated `git ls-tree -r --name-only` output into paths. */
export function splitPaths(stdout) {
    return stdout.split('\0').map(line => line.trim()).filter(line => line !== '');
}
