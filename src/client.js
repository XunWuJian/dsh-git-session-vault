/**
 * Browser half of DSH Session Vault.
 *
 * Registers one `settings.section` page. Everything it shows comes from the
 * host half over the plugin's own HTTP routes, so this file never touches the
 * session archive directly and never needs the filesystem.
 *
 * The page is deliberately plain: no JSX (the bundle is hand-rolled CommonJS
 * via esbuild) and no CSS framework, only theme tokens so the panel follows
 * the shell's light/dark appearance.
 */
import * as React from 'react';

/** Route prefix registered by the host half (absolute, `/api` channel included). */
const PREFIX = '/api/dsh-git-session-vault';
/** One request may wait this long before it is reported as a timeout. */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Mutating actions shell out to git against the user's remote, so a sync of a
 * few hundred sessions over a slow link legitimately runs for minutes. The
 * panel shows the stage while it waits instead of aborting it.
 */
const ACTION_TIMEOUT_MS = 15 * 60_000;
/** How often the progress bar re-reads the host's current stage. */
const PROGRESS_POLL_MS = 700;

/**
 * Strings used by the panel. The host also ships `locale/*.json` for the
 * marketplace listing; these are the runtime dictionary and are registered
 * through the locale service when it is available.
 */
const zh = {
    nav: '会话保险库',
    title: '会话保险库',
    intro: '用你自己的 Git 仓库备份、恢复并在多台设备之间同步 DSH 的会话记录。仓库必须保持私有 —— 会话文件包含完整对话。',
    loading: '正在加载…',
    retry: '重试',
    sectionRepo: '仓库',
    sectionRepoHint: '填写一个空仓库的地址。首次同步会创建分支与备份布局。',
    repoUrl: '仓库地址',
    repoUrlPlaceholder: 'git@github.com:you/private-sessions.git',
    branch: '分支',
    device: '设备名',
    authMode: '认证方式',
    authHelper: '系统凭据助手（推荐）',
    authToken: '从环境变量读取令牌',
    tokenEnvVar: '令牌环境变量名',
    tokenEnvVarHint: '例如 DSH_SYNC_TOKEN。令牌本身不会写入配置。',
    save: '保存',
    test: '测试连接',
    saving: '正在保存…',
    testing: '正在测试…',
    sectionStatus: '状态',
    lastSync: '上次同步',
    lastCommit: '最近提交',
    lastOperation: '最近操作',
    lastError: '最近错误',
    never: '从未',
    sessions: '本地会话',
    workspaces: '工作区',
    tracked: '已记录基线',
    sectionSessions: '本地会话',
    sessionsHint: '这些是该设备上待同步的会话文件。',
    columnSession: '会话',
    columnWorkspace: '工作区',
    columnSize: '大小',
    columnTime: '更新时间',
    columnAction: '动作',
    more: '还有 {count} 个未显示',
    sectionActions: '操作',
    sectionActionsHint: '同步会先拉取安全的新内容，再上传本地新内容；两边都改动时停止并请你决定。',
    actionSync: '同步',
    actionBackup: '仅上传备份',
    actionRestore: '仅下载恢复',
    actionHistory: '查看历史',
    running: '正在执行…',
    stageFetching: '正在连接仓库…',
    stagePlanning: '正在比较本地与远端…',
    stageTransferring: '正在传输会话…',
    stagePublishing: '正在提交…',
    stageReading: '正在读取提交记录…',
    progressElapsed: '已用 {seconds} 秒',
    historyEmpty: '仓库里还没有提交记录。',
    historyCount: '最近 {count} 次提交',
    peekStale: '本地比较，未联网刷新',
    sectionConflict: '需要决定',
    conflictHint: '下列会话在两边都被修改过。选择保留哪一边，然后再次同步。',
    keepLocal: '保留本地',
    keepRemote: '保留远端',
    applyResolution: '应用选择',
    clearConflict: '忽略冲突提示',
    sectionOptions: '同步选项',
    includeSubagent: '包含子代理会话',
    pushEnabled: '允许上传',
    pullEnabled: '允许下载',
    allowOverwrite: '允许覆盖本地已修改的会话',
    allowOverwriteHint: '覆盖前会把原文件复制到插件数据目录的 backups/ 下。',
    maxSessionMb: '单个会话大小上限（MB）',
    autoSync: '自动同步',
    autoStartup: '启动后自动同步一次',
    autoChange: '会话变化后自动同步',
    saved: '已保存。',
    testOk: '连接正常：{message}',
    notConfigured: '尚未配置仓库。填写上方的仓库地址并保存即可开始。',
    noSessions: '还没有可同步的会话。',
    loadFailed: '加载失败：{message}',
    actionFailed: '操作失败：{message}',
    actionDone: '完成：上传 {pushed}，下载 {pulled}，跳过 {skipped}',
    conflictBlocked: '{count} 个会话需要你先决定保留哪一边。',
    historyTitle: '提交历史',
};

const en = {
    nav: 'Session Vault',
    title: 'Session Vault',
    intro: 'Back up, restore, and synchronize DSH session archives across devices with your own Git repository. Keep the repository private — session files contain full conversations.',
    loading: 'Loading…',
    retry: 'Retry',
    sectionRepo: 'Repository',
    sectionRepoHint: 'Point at an empty repository. The first sync creates the branch and the backup layout.',
    repoUrl: 'Repository URL',
    repoUrlPlaceholder: 'git@github.com:you/private-sessions.git',
    branch: 'Branch',
    device: 'Device name',
    authMode: 'Authentication',
    authHelper: 'System credential helper (recommended)',
    authToken: 'Read a token from an environment variable',
    tokenEnvVar: 'Token environment variable',
    tokenEnvVarHint: 'For example DSH_SYNC_TOKEN. The token itself is never stored in the configuration.',
    save: 'Save',
    test: 'Test connection',
    saving: 'Saving…',
    testing: 'Testing…',
    sectionStatus: 'Status',
    lastSync: 'Last sync',
    lastCommit: 'Latest commit',
    lastOperation: 'Last operation',
    lastError: 'Last error',
    never: 'never',
    sessions: 'Local sessions',
    workspaces: 'Workspaces',
    tracked: 'Tracked baselines',
    sectionSessions: 'Local sessions',
    sessionsHint: 'These are the session files on this device that are considered for sync.',
    columnSession: 'Session',
    columnWorkspace: 'Workspace',
    columnSize: 'Size',
    columnTime: 'Updated',
    columnAction: 'Action',
    more: '{count} more not shown',
    sectionActions: 'Actions',
    sectionActionsHint: 'A sync pulls safe remote content first, then uploads local content. When both sides changed it stops and asks you.',
    actionSync: 'Sync',
    actionBackup: 'Upload only',
    actionRestore: 'Download only',
    actionHistory: 'Show history',
    running: 'Working…',
    stageFetching: 'Contacting the repository…',
    stagePlanning: 'Comparing local and remote…',
    stageTransferring: 'Transferring sessions…',
    stagePublishing: 'Committing…',
    stageReading: 'Reading commits…',
    progressElapsed: '{seconds}s elapsed',
    historyEmpty: 'The repository has no commits yet.',
    historyCount: 'Last {count} commits',
    peekStale: 'Compared locally, not refreshed from the remote',
    sectionConflict: 'Needs a decision',
    conflictHint: 'These sessions changed on both sides. Choose which side to keep, then sync again.',
    keepLocal: 'Keep local',
    keepRemote: 'Keep remote',
    applyResolution: 'Apply choice',
    clearConflict: 'Dismiss',
    sectionOptions: 'Sync options',
    includeSubagent: 'Include sub-agent sessions',
    pushEnabled: 'Allow uploads',
    pullEnabled: 'Allow downloads',
    allowOverwrite: 'Overwrite locally modified sessions',
    allowOverwriteHint: 'The replaced file is copied into backups/ under the plugin data directory first.',
    maxSessionMb: 'Per-session size limit (MB)',
    autoSync: 'Automatic sync',
    autoStartup: 'Sync once after startup',
    autoChange: 'Sync after sessions change',
    saved: 'Saved.',
    testOk: 'Connection OK: {message}',
    notConfigured: 'No repository configured yet. Enter a URL above and save to begin.',
    noSessions: 'There are no sessions to synchronize yet.',
    loadFailed: 'Failed to load: {message}',
    actionFailed: 'The operation failed: {message}',
    actionDone: 'Done: {pushed} uploaded, {pulled} downloaded, {skipped} skipped',
    conflictBlocked: '{count} sessions need you to pick a side first.',
    historyTitle: 'Commit history',
};

const NS = 'dsh-git-session-vault';

/** Fill `{name}` placeholders in a dictionary string. */
function format(template, values) {
    return String(template).replaceAll(/\{(\w+)\}/g, (match, key) => (
        values !== null && values !== undefined && key in values ? String(values[key]) : match
    ));
}

/** Browser-language fallback when the locale service is unavailable. */
function fallbackTranslate() {
    const preferred = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en';
    const table = preferred.toLowerCase().startsWith('zh') ? zh : en;
    return (key, values) => format(table[key] ?? key, values);
}

/** Wrap a bound locale translator, keeping the `format` helper. */
function createTranslate(bound) {
    return (key, values) => format(bound(key), values);
}

/** One failed route call, carrying the host's error code. */
class ApiError extends Error {
    constructor(code, message, details) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.details = details;
    }
}

/** POST one route and unwrap the `{ok, value}` envelope. */
async function request(route, body = {}, options = {}) {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        // `fetch` first so a network failure is not reported as a timeout.
        response = fetch(`${PREFIX}/${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
            credentials: 'same-origin',
            signal: controller.signal,
        });
    }
    catch (error) {
        window.clearTimeout(timer);
        throw new ApiError('network', String(error));
    }
    try {
        response = await response;
    }
    catch (error) {
        const aborted = controller.signal.aborted;
        throw new ApiError(
            aborted ? 'timeout' : 'network',
            aborted
                ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）/ request timed out`
                : String(error?.message ?? error),
        );
    }
    finally {
        window.clearTimeout(timer);
    }
    let payload = null;
    try {
        payload = await response.json();
    }
    catch {
        payload = null;
    }
    if (payload !== null && typeof payload === 'object') {
        if (payload.ok === true)
            return payload.value;
        const failure = payload.error ?? {};
        throw new ApiError(failure.code ?? 'unknown', failure.message ?? `HTTP ${response.status}`, failure.details);
    }
    throw new ApiError('bad-response', `HTTP ${response.status} ${response.statusText}`.trim());
}

/** Human-readable size. */
function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024)
        return `${value} B`;
    const units = ['KiB', 'MiB', 'GiB'];
    let scaled = value / 1024;
    let index = 0;
    while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024;
        index += 1;
    }
    return `${scaled.toFixed(1)} ${units[index]}`;
}

/** Local time for an ISO stamp, or a dash. */
function formatTime(iso, never) {
    if (iso === null || iso === undefined || iso === '')
        return never;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
}

/** Short commit id. */
function shortCommit(hash) {
    return typeof hash === 'string' && hash.length >= 7 ? hash.slice(0, 7) : (hash ?? '—');
}

const styles = {
    page: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 2px 32px' },
    pageTitle: { margin: 0, fontSize: '19px', fontWeight: 650, letterSpacing: '-0.01em' },
    intro: { margin: 0, fontSize: '13px', lineHeight: 1.65, color: 'var(--dsw-alias-text-secondary, #6b7280)' },
    card: {
        border: '1px solid var(--dsw-alias-border, rgba(0,0,0,0.10))',
        borderRadius: '12px',
        padding: '16px 18px',
        // A hair of elevation so sections separate without a heavy frame.
        background: 'var(--dsw-alias-surface, transparent)',
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
    },
    cardTitle: {
        margin: 0,
        fontSize: '13px',
        fontWeight: 650,
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-text-secondary, #6b7280)',
    },
    hint: { margin: 0, fontSize: '12px', lineHeight: 1.55, color: 'var(--dsw-alias-text-secondary, #6b7280)' },
    /** A heading subdividing one card, so it is not the same weight as the card title. */
    subTitle: {
        margin: '4px 0 0',
        paddingTop: '12px',
        fontSize: '13px',
        fontWeight: 600,
        borderTop: '1px solid var(--dsw-alias-border, rgba(0,0,0,0.08))',
    },
    row: { display: 'flex', flexWrap: 'wrap', gap: '12px' },
    field: { display: 'flex', flexDirection: 'column', gap: '6px', flex: '1 1 220px', minWidth: 0 },
    label: { fontSize: '12px', fontWeight: 500 },
    input: {
        padding: '7px 10px',
        borderRadius: '8px',
        fontSize: '13px',
        border: '1px solid var(--dsw-alias-border, rgba(0,0,0,0.16))',
        background: 'var(--dsw-alias-surface-sunken, rgba(0,0,0,0.03))',
        color: 'var(--dsw-alias-text, inherit)',
        minWidth: 0,
    },
    select: {
        padding: '7px 10px',
        borderRadius: '8px',
        fontSize: '13px',
        border: '1px solid var(--dsw-alias-border, rgba(0,0,0,0.16))',
        background: 'var(--dsw-alias-surface-sunken, rgba(0,0,0,0.03))',
        color: 'var(--dsw-alias-text, inherit)',
    },
    buttons: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
    button: {
        padding: '7px 14px',
        borderRadius: '8px',
        fontSize: '13px',
        fontWeight: 500,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border, rgba(0,0,0,0.16))',
        background: 'var(--dsw-alias-surface-raised, rgba(0,0,0,0.04))',
        color: 'var(--dsw-alias-text, inherit)',
        transition: 'background 120ms ease, border-color 120ms ease, opacity 120ms ease',
    },
    primary: {
        padding: '7px 14px',
        borderRadius: '8px',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-accent, #2563eb)',
        color: 'var(--dsw-alias-accent-text, #fff)',
        transition: 'filter 120ms ease, opacity 120ms ease',
    },
    grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: '10px',
    },
    stat: {
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        padding: '10px 12px',
        borderRadius: '9px',
        background: 'var(--dsw-alias-surface-sunken, rgba(0,0,0,0.03))',
        minWidth: 0,
    },
    statLabel: {
        fontSize: '10px',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        fontWeight: 600,
        color: 'var(--dsw-alias-text-secondary, #6b7280)',
    },
    statValue: {
        fontSize: '14px',
        fontWeight: 600,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px', fontVariantNumeric: 'tabular-nums' },
    th: {
        textAlign: 'left',
        padding: '7px 8px',
        borderBottom: '1px solid var(--dsw-alias-border, rgba(0,0,0,0.12))',
        color: 'var(--dsw-alias-text-secondary, #6b7280)',
        fontWeight: 600,
        fontSize: '11px',
        textTransform: 'uppercase',
        letterSpacing: '0.03em',
        whiteSpace: 'nowrap',
    },
    td: { padding: '7px 8px', borderBottom: '1px solid var(--dsw-alias-border, rgba(0,0,0,0.06))', verticalAlign: 'top' },
    mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' },
    notice: { margin: 0, fontSize: '12px', lineHeight: 1.5 },
    ok: { color: 'var(--dsw-alias-success, #15803d)' },
    error: { color: 'var(--dsw-alias-danger, #b91c1c)' },
    pill: {
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        fontWeight: 500,
        border: '1px solid var(--dsw-alias-border, rgba(0,0,0,0.16))',
        whiteSpace: 'nowrap',
    },
    pillPush: { background: 'rgba(37,99,235,0.10)', borderColor: 'rgba(37,99,235,0.35)', color: 'var(--dsw-alias-accent, #2563eb)' },
    pillPull: { background: 'rgba(21,128,61,0.10)', borderColor: 'rgba(21,128,61,0.35)', color: 'var(--dsw-alias-success, #15803d)' },
    pillConflict: { background: 'rgba(185,28,28,0.10)', borderColor: 'rgba(185,28,28,0.35)', color: 'var(--dsw-alias-danger, #b91c1c)' },
    pillIdle: { color: 'var(--dsw-alias-text-secondary, #6b7280)' },
    /** Applied to a button whose action is currently running. */
    buttonBusy: { opacity: 0.72, cursor: 'progress' },
    checkboxRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' },
    progressWrap: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        marginTop: '10px',
        padding: '10px 12px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border, rgba(0,0,0,0.10))',
        background: 'var(--dsw-alias-surface-sunken, rgba(0,0,0,0.03))',
    },
    progressHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', fontSize: '12px' },
    progressStage: { fontWeight: 600 },
    progressElapsed: { color: 'var(--dsw-alias-text-secondary, #6b7280)', fontVariantNumeric: 'tabular-nums' },
    progressTrack: {
        height: '6px',
        borderRadius: '999px',
        overflow: 'hidden',
        background: 'var(--dsw-alias-border, rgba(0,0,0,0.12))',
    },
    progressBar: {
        height: '100%',
        borderRadius: '999px',
        background: 'var(--dsw-alias-accent, #2563eb)',
        // Indeterminate: the host reports stages, not a percentage, so the bar
        // sweeps instead of inventing a number it cannot back up.
        transition: 'width 240ms ease-out',
    },
    noticeBox: {
        margin: 0,
        padding: '9px 12px',
        borderRadius: '10px',
        fontSize: '12px',
        lineHeight: 1.5,
    },
    spinner: {
        display: 'inline-block',
        width: '11px',
        height: '11px',
        marginRight: '7px',
        borderRadius: '50%',
        border: '2px solid currentColor',
        borderTopColor: 'transparent',
        animation: 'dsh-vault-spin 0.7s linear infinite',
        verticalAlign: '-1px',
    },
};

/**
 * Style one `action` pill by what it means.
 *
 * The raw values are the host's (`push` / `pull` / `conflict` / `skip`), which
 * read fine but all looked identical before: a red-coded conflict was
 * indistinguishable from an ordinary skip.
 */
function actionPillStyle(action) {
    if (action === 'push')
        return { ...styles.pill, ...styles.pillPush };
    if (action === 'pull' || action === 'fork')
        return { ...styles.pill, ...styles.pillPull };
    if (action === 'conflict')
        return { ...styles.pill, ...styles.pillConflict };
    return { ...styles.pill, ...styles.pillIdle };
}

/** The style for a button in the given busy state. */
function buttonStyle(busyNow, primary) {
    const base = primary ? styles.primary : styles.button;
    return busyNow ? { ...base, ...styles.buttonBusy } : base;
}

const h = React.createElement;

/** A labelled text input. */
function Field({ label, hint, children, compact }) {
    const fieldStyle = compact
        ? { ...styles.field, flex: '0 0 auto', width: '160px' }
        : styles.field;
    return h('div', { style: fieldStyle },
        h('span', { style: styles.label }, label),
        children,
        hint !== undefined && hint !== null ? h('span', { style: styles.hint }, hint) : null);
}

/** A checkbox with its label. */
function Check({ label, checked, onChange, hint }) {
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
        h('label', { style: styles.checkboxRow },
            h('input', { type: 'checkbox', checked: Boolean(checked), onChange: event => onChange(event.target.checked) }),
            h('span', null, label)),
        hint !== undefined && hint !== null ? h('span', { style: styles.hint }, hint) : null);
}

/** The stage of a running action, so a long sync never looks like a hang. */
function Progress({ t, value }) {
    if (value === null || value === undefined || value.running === false)
        return null;
    const stageKey = `stage${String(value.stage ?? 'starting').replace(/^./, character => character.toUpperCase())}`;
    const label = t(stageKey) === stageKey ? t('running') : t(stageKey);
    const elapsed = Math.max(0, Math.round((Number(value.elapsedMs) || 0) / 1000));
    return h('div', { style: styles.progressWrap, role: 'status', 'aria-live': 'polite' },
        h('div', { style: styles.progressHead },
            h('span', { style: styles.progressStage }, label),
            h('span', { style: styles.progressElapsed }, t('progressElapsed', { seconds: elapsed }))),
        h('div', { style: styles.progressTrack },
            h('div', {
                style: {
                    ...styles.progressBar,
                    width: '100%',
                    opacity: 0.55,
                    animation: 'dsh-vault-pulse 1.4s ease-in-out infinite',
                },
            })));
}

/** Inline animation keyframes; the shell offers no stylesheet hook for plugins. */
const ANIMATION_ID = 'dsh-git-session-vault-animations';
function ensureAnimations() {
    if (typeof document === 'undefined' || document.getElementById(ANIMATION_ID) !== null)
        return;
    const style = document.createElement('style');
    style.id = ANIMATION_ID;
    style.textContent = `
@keyframes dsh-vault-spin { to { transform: rotate(360deg); } }
@keyframes dsh-vault-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 0.75; } }
@media (prefers-reduced-motion: reduce) {
  @keyframes dsh-vault-spin { to { transform: none; } }
  @keyframes dsh-vault-pulse { 0%, 100% { opacity: 0.55; } }
}`;
    document.head.appendChild(style);
}

/** Coerce a stored configuration into the shape the form edits. */
function toForm(config) {
    return {
        repoUrl: config?.repoUrl ?? '',
        branch: config?.branch ?? 'main',
        deviceName: config?.deviceName ?? '',
        authMode: config?.authMode ?? 'credential-helper',
        tokenEnvVar: config?.tokenEnvVar ?? '',
        includeSubagentSessions: Boolean(config?.includeSubagentSessions),
        pushEnabled: config?.pushEnabled !== false,
        pullEnabled: config?.pullEnabled !== false,
        allowOverwrite: Boolean(config?.allowOverwrite),
        maxSessionMb: Number(config?.maxSessionMb ?? 200),
        autoStartup: Boolean(config?.autoSync?.onStartup),
        autoChange: Boolean(config?.autoSync?.onSessionChange),
    };
}

/**
 * Style one notice banner.
 *
 * Errors were previously rendered as bare red text with no box, which read as
 * an unrelated line of prose rather than as the outcome of the button that was
 * just pressed.
 */
function noticeStyle(notice) {
    const kind = notice?.kind ?? 'ok';
    const tint = kind === 'error'
        ? { border: '1px solid var(--dsw-alias-danger, #b91c1c)', color: 'var(--dsw-alias-danger, #b91c1c)' }
        : kind === 'warn'
            ? { border: '1px solid var(--dsw-alias-warning, #b45309)', color: 'var(--dsw-alias-warning, #b45309)' }
            : { border: '1px solid var(--dsw-alias-success, #15803d)', color: 'var(--dsw-alias-success, #15803d)' };
    return { ...styles.noticeBox, ...tint };
}

/** The settings page itself. */
function Page({ t }) {
    const [config, setConfig] = React.useState(null);
    const [form, setForm] = React.useState(() => toForm(null));
    const [status, setStatus] = React.useState(null);
    const [diff, setDiff] = React.useState(null);
    const [history, setHistory] = React.useState(null);
    const [busy, setBusy] = React.useState('');
    const [notice, setNotice] = React.useState(null);
    const [resolution, setResolution] = React.useState({});
    /** Current stage of the running action, polled from the host. */
    const [progress, setProgress] = React.useState(null);
    /** Set while a full remote comparison is running, to show it is not frozen. */
    const [comparing, setComparing] = React.useState(false);
    const alive = React.useRef(true);
    /** Set while a progress poll loop owns the interval. */
    const pollRef = React.useRef(null);

    React.useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            if (pollRef.current !== null) {
                window.clearInterval(pollRef.current);
                pollRef.current = null;
            }
        };
    }, []);

    const update = React.useCallback(patch => {
        setForm(current => ({ ...current, ...patch }));
    }, []);

    /** Stop polling the host for a stage. */
    const stopPolling = React.useCallback(() => {
        if (pollRef.current !== null) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
        }
        setProgress(null);
    }, []);

    /** Start polling the host for the stage of the action just launched. */
    const startPolling = React.useCallback(operation => {
        stopPolling();
        setProgress({ running: true, operation, stage: 'starting', done: 0, total: 0, elapsedMs: 0 });
        pollRef.current = window.setInterval(() => {
            request('progress', {})
                .then(value => {
                    if (!alive.current)
                        return;
                    if (value?.running === false) {
                        setProgress(current => (current === null ? current : { ...current, stage: 'finishing' }));
                        return;
                    }
                    setProgress(value ?? null);
                })
                .catch(() => undefined);
        }, PROGRESS_POLL_MS);
    }, [stopPolling]);

    /**
     * Reload status, then compare.
     *
     * `mode: 'remote'` (the default) asks the host for a real three-way
     * comparison, which blocks on `git fetch`. `mode: 'local'` uses `peek`,
     * which compares against what the repository already knows locally — the
     * right choice right after saving, where waiting seconds just to confirm a
     * write reads as a hang.
     */
    const refresh = React.useCallback(async (options = {}) => {
        const loaded = await request('status');
        if (!alive.current)
            return null;
        setStatus(loaded);
        // Only rewrite the form when the caller did not just build it, so a
        // refresh never discards what the user is typing.
        if (options.keepForm !== true && loaded?.config !== undefined && loaded?.config !== null) {
            setConfig(loaded.config);
            setForm(toForm(loaded.config));
        }
        if (loaded?.configured !== true) {
            if (alive.current)
                setDiff(null);
            return loaded;
        }
        const local = options.mode === 'local';
        if (local) {
            // Local comparison is milliseconds; no need to announce it.
            const compared = await request('peek').catch(() => null);
            if (alive.current)
                setDiff(compared);
            return loaded;
        }
        if (alive.current)
            setComparing(true);
        try {
            const compared = await request('diff').catch(() => null);
            if (alive.current)
                setDiff(compared);
        }
        finally {
            if (alive.current)
                setComparing(false);
        }
        return loaded;
    }, []);

    React.useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                await refresh();
            }
            catch (error) {
                if (!cancelled && alive.current)
                    setNotice({ kind: 'error', text: t('loadFailed', { message: error.message }) });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [refresh, t]);

    /** Run one mutating action, keeping the panel responsive. */
    const run = React.useCallback(async (label, action) => {
        setBusy(label);
        setNotice(null);
        // Mutating actions talk to the remote, so they get the long timeout
        // and the progress bar instead of a 30 s abort.
        startPolling(label);
        try {
            const value = await action();
            if (!alive.current)
                return value;
            if (value !== undefined && value !== null && value.counts !== undefined) {
                const pushed = Number(value.summary?.pushed ?? value.counts.push ?? 0);
                const pulled = Number(value.summary?.pulled ?? value.counts.pull ?? 0);
                const skipped = Number(value.counts.skipped ?? 0);
                setNotice({
                    kind: value.error === undefined ? 'ok' : 'warn',
                    text: value.error ?? t('actionDone', { pushed, pulled, skipped }),
                });
            }
            await refresh();
            return value;
        }
        catch (error) {
            if (alive.current) {
                if (error.code === 'conflict-present') {
                    const count = error.details?.plan?.counts?.conflict ?? 0;
                    setNotice({ kind: 'error', text: t('conflictBlocked', { count }) });
                    setResolution({});
                }
                else {
                    setNotice({ kind: 'error', text: t('actionFailed', { message: error.message }) });
                }
            }
            return null;
        }
        finally {
            stopPolling();
            if (alive.current)
                setBusy('');
        }
    }, [refresh, startPolling, stopPolling, t]);

    /** Upload only, with the same feedback as a full sync. */
    const backupNow = React.useCallback(() => run('backup', () => request('backup', {}, {
        timeoutMs: ACTION_TIMEOUT_MS,
    })), [run]);

    /** Download only. */
    const restoreNow = React.useCallback(() => run('restore', () => request('restore', {}, {
        timeoutMs: ACTION_TIMEOUT_MS,
    })), [run]);

    /** Load the commit history and show it. */
    const showHistory = React.useCallback(async () => {
        setBusy('history');
        setNotice(null);
        startPolling('history');
        try {
            const value = await request('history', { limit: 20 }, { timeoutMs: ACTION_TIMEOUT_MS });
            if (!alive.current)
                return;
            setHistory(value);
            const count = Array.isArray(value?.entries) ? value.entries.length : 0;
            setNotice(count === 0
                ? { kind: 'warn', text: t('historyEmpty') }
                : { kind: 'ok', text: t('historyCount', { count }) });
        }
        catch (error) {
            if (alive.current)
                setNotice({ kind: 'error', text: t('actionFailed', { message: error.message }) });
        }
        finally {
            stopPolling();
            if (alive.current)
                setBusy('');
        }
    }, [startPolling, stopPolling, t]);

    const save = React.useCallback(async () => {
        setBusy('save');
        setNotice(null);
        try {
            const saved = await request('config/save', {
                repoUrl: form.repoUrl,
                branch: form.branch,
                deviceName: form.deviceName,
                authMode: form.authMode,
                tokenEnvVar: form.tokenEnvVar,
                includeSubagentSessions: form.includeSubagentSessions,
                pushEnabled: form.pushEnabled,
                pullEnabled: form.pullEnabled,
                allowOverwrite: form.allowOverwrite,
                maxSessionMb: form.maxSessionMb,
                autoSync: {
                    // Without `enabled` the scheduler stays off no matter what
                    // the two switches say, which is why arming automatic sync
                    // from the UI appeared to do nothing.
                    enabled: form.autoStartup || form.autoChange,
                    onStartup: form.autoStartup,
                    onSessionChange: form.autoChange,
                },
            });
            if (!alive.current)
                return;
            setConfig(saved);
            setForm(toForm(saved));
            setNotice({ kind: 'ok', text: t('saved') });
            // `mode: 'local'`: confirming a write must not block on `git fetch`.
            // The session table refreshes from the local comparison in
            // milliseconds; a full remote comparison happens on the next sync
            // or on the explicit refresh button.
            await refresh({ mode: 'local' });
        }
        catch (error) {
            if (alive.current)
                setNotice({ kind: 'error', text: t('actionFailed', { message: error.message }) });
        }
        finally {
            if (alive.current)
                setBusy('');
        }
    }, [form, refresh, t]);

    const test = React.useCallback(async () => {
        setBusy('test');
        setNotice(null);
        try {
            const result = await request('connection/test', { repoUrl: form.repoUrl, branch: form.branch });
            if (!alive.current)
                return;
            setNotice({
                kind: 'ok',
                text: t('testOk', { message: `${result.branch}${result.hasBranch === true ? '' : ' (empty)'}` }),
            });
        }
        catch (error) {
            if (alive.current)
                setNotice({ kind: 'error', text: t('actionFailed', { message: error.message }) });
        }
        finally {
            if (alive.current)
                setBusy('');
        }
    }, [form.branch, form.repoUrl, t]);

    const upload = React.useCallback(() => run('sync', () => request('sync', {
        allowConflicts: true,
        resolve: resolution,
    }, { timeoutMs: ACTION_TIMEOUT_MS })), [resolution, run]);

    const conflicts = status?.conflict?.sessions ?? [];

    if (status === null) {
        return h('div', { style: styles.page },
            h('p', { style: styles.hint },
                h('span', { style: styles.spinner, 'aria-hidden': 'true' }),
                t('loading')),
            notice !== null ? h('p', { style: noticeStyle(notice) }, notice.text) : null);
    }

    return h('div', { style: styles.page },
        h('h2', { style: styles.pageTitle }, t('title')),
        h('p', { style: styles.intro }, t('intro')),

        notice !== null ? h('p', { style: noticeStyle(notice) }, notice.text) : null,

        // Repository form.
        h('section', { style: styles.card },
            h('h3', { style: styles.cardTitle }, t('sectionRepo')),
            h('p', { style: styles.hint }, t('sectionRepoHint')),
            h('div', { style: styles.row },
                h(Field, { label: t('repoUrl') },
                    h('input', {
                        style: styles.input,
                        type: 'text',
                        spellCheck: false,
                        value: form.repoUrl,
                        placeholder: t('repoUrlPlaceholder'),
                        onChange: event => update({ repoUrl: event.target.value }),
                    }))),
            h('div', { style: styles.row },
                h(Field, { label: t('branch') },
                    h('input', {
                        style: styles.input,
                        type: 'text',
                        value: form.branch,
                        onChange: event => update({ branch: event.target.value }),
                    })),
                h(Field, { label: t('device') },
                    h('input', {
                        style: styles.input,
                        type: 'text',
                        value: form.deviceName,
                        onChange: event => update({ deviceName: event.target.value }),
                    })),
                h(Field, { label: t('authMode') },
                    h('select', {
                        style: styles.select,
                        value: form.authMode,
                        onChange: event => update({ authMode: event.target.value }),
                    },
                    h('option', { value: 'credential-helper' }, t('authHelper')),
                    h('option', { value: 'https-token' }, t('authToken'))))),
            form.authMode === 'https-token'
                ? h(Field, { label: t('tokenEnvVar'), hint: t('tokenEnvVarHint') },
                    h('input', {
                        style: styles.input,
                        type: 'text',
                        value: form.tokenEnvVar,
                        onChange: event => update({ tokenEnvVar: event.target.value }),
                    }))
                : null,
            h('div', { style: styles.buttons },
                h('button', { type: 'button', style: buttonStyle(busy === 'save', true), disabled: busy !== '', onClick: save },
                    busy === 'save' ? t('saving') : t('save')),
                h('button', { type: 'button', style: buttonStyle(busy === 'test', false), disabled: busy !== '', onClick: test },
                    busy === 'test' ? t('testing') : t('test')))),

        // Status.
        h('section', { style: styles.card },
            h('h3', { style: styles.cardTitle }, t('sectionStatus')),
            status.configured === false
                ? h('p', { style: styles.hint }, t('notConfigured'))
                : h('div', { style: styles.grid },
                    h('div', { style: styles.stat },
                        h('span', { style: styles.statLabel }, t('sessions')),
                        h('span', { style: styles.statValue }, `${status.local?.sessions ?? 0} / ${formatBytes(status.local?.bytes ?? 0)}`)),
                    h('div', { style: styles.stat },
                        h('span', { style: styles.statLabel }, t('workspaces')),
                        h('span', { style: styles.statValue }, String(status.local?.workspaces?.length ?? 0))),
                    h('div', { style: styles.stat },
                        h('span', { style: styles.statLabel }, t('tracked')),
                        h('span', { style: styles.statValue }, String(status.tracked ?? 0))),
                    h('div', { style: styles.stat },
                        h('span', { style: styles.statLabel }, t('lastSync')),
                        h('span', { style: styles.statValue }, formatTime(status.lastSyncAt, t('never')))),
                    h('div', { style: styles.stat },
                        h('span', { style: styles.statLabel }, t('lastCommit')),
                        h('span', { style: { ...styles.statValue, ...styles.mono } }, shortCommit(status.lastCommit))),
                    h('div', { style: styles.stat },
                        h('span', { style: styles.statLabel }, t('lastOperation')),
                        h('span', { style: styles.statValue }, status.lastOperation?.operation ?? t('never')))),
            status.lastError !== null && status.lastError !== undefined
                ? h('p', { style: { ...styles.notice, ...styles.error } },
                    `${t('lastError')}: ${formatTime(status.lastError.at, '')} ${status.lastError.message}`)
                : null),

        // Conflict resolution.
        conflicts.length > 0
            ? h('section', { style: styles.card },
                h('h3', { style: styles.cardTitle }, t('sectionConflict')),
                h('p', { style: styles.hint }, t('conflictHint')),
                ...conflicts.map(sessionId => h('div', { key: sessionId, style: { ...styles.checkboxRow, ...styles.mono } },
                    h('span', { style: { flex: '1 1 auto' } }, sessionId),
                    h('label', { style: styles.checkboxRow },
                        h('input', {
                            type: 'radio',
                            name: `conflict-${sessionId}`,
                            checked: resolution[sessionId] === 'local',
                            onChange: () => setResolution(current => ({ ...current, [sessionId]: 'local' })),
                        }),
                        h('span', null, t('keepLocal'))),
                    h('label', { style: styles.checkboxRow },
                        h('input', {
                            type: 'radio',
                            name: `conflict-${sessionId}`,
                            checked: resolution[sessionId] === 'remote',
                            onChange: () => setResolution(current => ({ ...current, [sessionId]: 'remote' })),
                        }),
                        h('span', null, t('keepRemote'))))),
                h('div', { style: styles.buttons },
                    h('button', {
                        type: 'button',
                        style: styles.primary,
                        disabled: busy !== '' || Object.keys(resolution).length === 0,
                        onClick: () => run('sync', () => request('sync', { resolve: resolution })),
                    }, t('applyResolution')),
                    h('button', {
                        type: 'button',
                        style: styles.button,
                        disabled: busy !== '',
                        onClick: () => run('clear', () => request('conflict/clear')),
                    }, t('clearConflict'))))
            : null,

        // Actions.
        h('section', { style: styles.card },
            h('h3', { style: styles.cardTitle }, t('sectionActions')),
            h('p', { style: styles.hint }, t('sectionActionsHint')),
            h('div', { style: styles.buttons },
                h('button', {
                    type: 'button',
                    style: buttonStyle(busy === 'sync', true),
                    disabled: busy !== '' || status.configured === false,
                    onClick: () => run('sync', () => request('sync', { resolve: resolution }, { timeoutMs: ACTION_TIMEOUT_MS })),
                }, busy === 'sync' ? t('running') : t('actionSync')),
                h('button', {
                    type: 'button',
                    style: buttonStyle(busy === 'backup', false),
                    disabled: busy !== '' || status.configured === false,
                    onClick: backupNow,
                }, busy === 'backup' ? t('running') : t('actionBackup')),
                h('button', {
                    type: 'button',
                    style: buttonStyle(busy === 'restore', false),
                    disabled: busy !== '' || status.configured === false,
                    onClick: restoreNow,
                }, busy === 'restore' ? t('running') : t('actionRestore')),
                h('button', {
                    type: 'button',
                    style: buttonStyle(busy === 'history', false),
                    disabled: busy !== '' || status.configured === false,
                    onClick: showHistory,
                }, busy === 'history' ? t('running') : t('actionHistory'))),
            h(Progress, { t, value: progress })),

        // History.
        history !== null
            ? h('section', { style: styles.card },
                h('h3', { style: styles.cardTitle }, t('historyTitle')),
                Array.isArray(history.entries) && history.entries.length > 0
                    ? h('table', { style: styles.table },
                        h('tbody', null,
                            ...history.entries.map(entry => h('tr', { key: entry.hash },
                                h('td', { style: { ...styles.td, ...styles.mono } }, shortCommit(entry.hash)),
                                h('td', { style: styles.td }, formatTime(entry.date, '')),
                                h('td', { style: styles.td }, entry.subject)))))
                    : h('p', { style: styles.hint }, t('historyEmpty')))
            : null,

        // Options.
        h('section', { style: styles.card },
            h('h3', { style: styles.cardTitle }, t('sectionOptions')),
            h('div', { style: styles.row },
                h(Check, {
                    label: t('pushEnabled'),
                    checked: form.pushEnabled,
                    onChange: value => update({ pushEnabled: value }),
                }),
                h(Check, {
                    label: t('pullEnabled'),
                    checked: form.pullEnabled,
                    onChange: value => update({ pullEnabled: value }),
                })),
            h(Check, {
                label: t('includeSubagent'),
                checked: form.includeSubagentSessions,
                onChange: value => update({ includeSubagentSessions: value }),
            }),
            h(Check, {
                label: t('allowOverwrite'),
                hint: t('allowOverwriteHint'),
                checked: form.allowOverwrite,
                onChange: value => update({ allowOverwrite: value }),
            }),
            h(Field, { label: t('maxSessionMb'), compact: true },
                h('input', {
                    style: styles.input,
                    type: 'number',
                    min: 0,
                    value: form.maxSessionMb,
                    onChange: event => update({ maxSessionMb: Number(event.target.value) }),
                })),
            h('h3', { style: styles.subTitle }, t('autoSync')),
            h('div', { style: styles.row },
                h(Check, {
                    label: t('autoStartup'),
                    checked: form.autoStartup,
                    onChange: value => update({ autoStartup: value }),
                }),
                h(Check, {
                    label: t('autoChange'),
                    checked: form.autoChange,
                    onChange: value => update({ autoChange: value }),
                })),
            h('div', { style: styles.buttons },
                h('button', { type: 'button', style: buttonStyle(busy === 'save', true), disabled: busy !== '', onClick: save },
                    busy === 'save' ? t('saving') : t('save')))),

        // Session table and diff actions.
        h('section', { style: styles.card },
            h('h3', { style: styles.cardTitle }, t('sectionSessions')),
            h('p', { style: styles.hint }, t('sessionsHint')),
            comparing
                ? h('p', { style: styles.hint },
                    h('span', { style: styles.spinner, 'aria-hidden': 'true' }),
                    t('stagePlanning'))
                : null,
            Array.isArray(diff?.rows) && diff.rows.length > 0
                ? h('table', { style: styles.table },
                    h('thead', null,
                        h('tr', null,
                            h('th', { style: styles.th }, t('columnSession')),
                            h('th', { style: styles.th }, t('columnWorkspace')),
                            h('th', { style: styles.th }, t('columnAction')),
                            h('th', { style: styles.th }, t('columnSize')))),
                    h('tbody', null,
                        ...diff.rows.slice(0, 200).map(row => h('tr', { key: row.sessionId },
                            h('td', { style: { ...styles.td, ...styles.mono } }, row.sessionId),
                            h('td', { style: styles.td }, row.workspace ?? '—'),
                            h('td', { style: styles.td },
                                h('span', { style: actionPillStyle(row.action) },
                                    `${row.action}${row.reason !== undefined && row.reason !== null ? ` · ${row.reason}` : ''}`)),
                            h('td', { style: styles.td }, formatBytes(row.localSize ?? row.remoteSize ?? 0))))),
                    diff.rows.length > 200
                        ? h('caption', { style: { ...styles.hint, textAlign: 'left', paddingTop: '8px' } },
                            t('more', { count: diff.rows.length - 200 }))
                        : null)
                : h('p', { style: styles.hint }, t('noSessions'))),

        // Manual refresh: a full remote comparison, with its own indicator.
        h('div', { style: styles.buttons },
            h('button', {
                type: 'button',
                style: buttonStyle(comparing, false),
                disabled: busy !== '' || comparing,
                onClick: () => refresh(),
            }, comparing ? t('stagePlanning') : t('retry'))),
    );
}

/** Keep one broken panel from taking the whole Settings page down. */
class SectionBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { failed: false, message: '' };
    }

    static getDerivedStateFromError(error) {
        return { failed: true, message: error?.message ?? String(error) };
    }

    componentDidCatch(error) {
        console.error('[dsh-git-session-vault] settings section crashed:', error);
    }

    render() {
        if (this.state.failed) {
            return h('div', { style: styles.page },
                h('p', { style: noticeStyle({ kind: 'error' }) }, this.state.message));
        }
        return this.props.children;
    }
}

const name = NS;
const inject = ['slots', 'locale', 'theme'];

/** Register the settings page. */
function apply(ctx) {
    let t;
    // Keyframes for the progress sweep and the inline spinner; the shell offers
    // plugins no stylesheet hook, so they are injected once into <head>.
    try {
        ensureAnimations();
    }
    catch {
        // A missing document only means no animation, never a failed mount.
    }
    try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-git-session-vault: locale dictionaries');
        t = createTranslate(ctx.locale.bind(NS));
    }
    catch (error) {
        console.warn('[dsh-git-session-vault] locale service unavailable, using browser language:', error);
        t = fallbackTranslate();
    }
    try {
        const Section = props => h(SectionBoundary, null, h(Page, { t: props.t ?? t }));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'session-sync',
            order: 43,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ t }),
        }, Section));
    }
    catch (error) {
        console.warn('[dsh-git-session-vault] settings section registration failed; the rest of Settings is unaffected:', error);
    }
}

export { apply, inject, name };
export default { apply, inject, name };
