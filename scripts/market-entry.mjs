/**
 * Generate the format-1 market index entry for this plugin.
 *
 * `dsh-plugin-market` reads a JSON index whose schema is defined by
 * `@deepseek-ai/dsh-plugin-market-index`. The published index is not writable by
 * plugin authors — dsh.so curates it, and every entry there carries
 * `install-verified` plus `risk-low` labels this file cannot grant itself.
 *
 * What this script produces is therefore the **submission payload**: the exact
 * record a maintainer (or an annotation tool) can paste into an index, built
 * from this repository's own metadata so it cannot drift from the package it
 * describes.
 *
 *   node scripts/market-entry.mjs > market-entry.json
 *
 * Two facts it encodes that are easy to get wrong by hand:
 *
 * - `versions[].source` for a Git plugin needs the **full 40-hex commit**, not a
 *   branch or a short SHA; the validator rejects anything else.
 * - `keywords` is the only field search can match on for the words a user
 *   actually types. The market tokenizes CJK into overlapping character pairs
 *   and requires every term of a multi-word query to match, so "消息备份" only
 *   reaches this plugin when that exact four-character run is in the keywords.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

/** Full commit SHA of HEAD, which the index requires for a Git source. */
function headCommit() {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

/** Unix seconds, the only timestamp unit the format accepts. */
function publishTimestamp() {
    return Math.floor(Date.now() / 1000);
}

/**
 * Keywords the market can search on.
 *
 * Grouped by the query a user might type rather than by how the feature is
 * implemented: someone looking for this plugin types "聊天记录备份" or
 * "换机", not "three-way sync keyed by content hash".
 */
const KEYWORDS = [
    // English
    'session', 'sessions', 'backup', 'backups', 'restore', 'sync', 'synchronize',
    'git', 'vault', 'archive', 'archive-sessions', 'cross-device', 'multi-device',
    'migrate', 'migration', 'private-repository',
    // Chinese: the storage nouns
    '会话', '会话记录', '聊天记录', '对话', '消息', '历史记录',
    // Chinese: the actions
    '备份', '备份会话', '会话备份', '聊天记录备份', '消息备份', '对话备份',
    '恢复', '还原', '同步', '存档', '归档', '导出', '导入',
    // Chinese: the reason people search for it
    '多设备', '多端', '换机', '迁移', '跨设备', '私有仓库',
];

/** The repository URL without the `git+` decoration npm accepts. */
function plainRepoUrl(value) {
    return String(value ?? '')
        .replace(/^git\+/, '')
        .replace(/\.git#?$/, '')
        .replace(/^git@github\.com:/, 'https://github.com/');
}

const commit = headCommit();
const repoUrl = plainRepoUrl(packageJson.repository?.url);

const entry = {
    name: packageJson.name,
    title: {
        en: 'Session Vault',
        zh: '会话保险库',
    },
    description: {
        en: 'Back up, restore, and synchronize DSH session archives and chat history across devices using your own private Git repository. Three-way merge stops on a real conflict instead of overwriting.',
        zh: '用你自己的私有 Git 仓库备份、恢复并在多台设备之间同步 DSH 的会话记录与聊天记录。三向合并遇到真实分歧时停下来问你，绝不静默覆盖。',
    },
    author: typeof packageJson.author === 'string' ? packageJson.author : packageJson.author?.name,
    homepage: packageJson.homepage,
    repository: { url: repoUrl },
    metadata: {
        category: 'session',
        keywords: KEYWORDS,
        labels: [],
        // `sortKeys` and `labels` may only reference ids the *index* declares,
        // and an author cannot know those. The curating index fills them in
        // (dsh.so adds `install-verified`, `risk-low`, `stars-…`), so leave them
        // empty here: a made-up key fails validation with
        // "references undeclared id".
        sortKeys: {},
    },
    versions: [
        {
            version: packageJson.version,
            publishTimestamp: publishTimestamp(),
            source: {
                type: 'git',
                url: repoUrl,
                commit,
            },
            engines: {
                dsh: packageJson.engines?.dsh ?? '>=0.2.0',
            },
        },
    ],
};

process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
