/**
 * Agent tools.
 *
 * Every tool calls the same engine method the settings page calls, so no logic
 * is duplicated here. Operations that can change a local session log are
 * two-phase for the model: without `confirm: true` the tool returns the plan,
 * and only an explicit confirmation executes it.
 * @module tools
 */
import { SyncError, errorMessage } from './util.js';

/** Render a JSON value as the model-facing text block. */
function renderJson(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

/** Project a result onto lossless JSON. */
function lossless(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

/** Normalize a thrown error into a tool result instead of a crash. */
function errorResult(error) {
    if (error instanceof SyncError) {
        if (error.code === 'conflict-present') {
            return lossless({ ok: false, needsUserDecision: true, error: { code: error.code, message: error.message }, conflicts: error.details?.plan });
        }
        return { ok: false, error: { code: error.code, message: error.message } };
    }
    return { ok: false, error: { code: 'internal', message: errorMessage(error) } };
}

const CONFIRM_PARAMETER = {
    type: 'boolean',
    description: 'Execute for real. Omit or false to receive a preview of what would change first.',
};

/** Build the tool definitions. */
export function buildToolDefinitions(engine) {
    return [
        {
            name: 'dsh_session_sync_status',
            description: 'Show the DSH Session Sync status: configured repository and branch, device name, local session counts and size per workspace, last sync time/commit, and the last error. Read-only.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            output: { schema: { type: 'object' }, render: renderJson },
            timeoutMs: 60_000,
            isConcurrencySafe: () => true,
            execute: async () => {
                try {
                    return lossless({ ok: true, ...(await engine.status()) });
                }
                catch (error) {
                    return errorResult(error);
                }
            },
        },
        {
            name: 'dsh_session_sync_list',
            description: 'List this device\'s stored DSH sessions with workspace, session id, file size and creation time, optionally filtered by workspace. Read-only.',
            parameters: {
                type: 'object',
                properties: {
                    workspace: { type: 'string', description: 'Only sessions whose workspace key or title contains this text.' },
                    limit: { type: 'number', description: 'Maximum sessions to return (default 50, max 500).' },
                },
                additionalProperties: false,
            },
            output: { schema: { type: 'object' }, render: renderJson },
            timeoutMs: 60_000,
            isConcurrencySafe: () => true,
            execute: async (args) => {
                try {
                    const raw = (args ?? {});
                    const filter = typeof raw.workspace === 'string' ? raw.workspace.trim().toLowerCase() : '';
                    const limit = Math.max(1, Math.min(500, Math.round(Number(raw.limit)) || 50));
                    const diff = await engine.localSessions();
                    const sessions = diff.sessions.filter(session => filter === '' ||
                        session.workspace.toLowerCase().includes(filter) ||
                        session.sessionId.toLowerCase().includes(filter));
                    return lossless({ ok: true, total: sessions.length, sessions: sessions.slice(0, limit) });
                }
                catch (error) {
                    return errorResult(error);
                }
            },
        },
        {
            name: 'dsh_session_sync_diff',
            description: 'Compare local sessions with the Git backup without changing anything: which sessions would be uploaded, downloaded, skipped or conflict. Read-only.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            output: { schema: { type: 'object' }, render: renderJson },
            timeoutMs: 300_000,
            isConcurrencySafe: () => false,
            execute: async () => {
                try {
                    return lossless({ ok: true, ...(await engine.diff()) });
                }
                catch (error) {
                    return errorResult(error);
                }
            },
        },
        {
            name: 'dsh_session_sync_sync',
            description: 'Synchronize DSH sessions with the configured private Git repository: download sessions the repository changed, upload sessions changed locally. Conflicting sessions are never resolved automatically. Pass confirm: true to execute; otherwise the plan is returned.',
            parameters: {
                type: 'object',
                properties: {
                    confirm: CONFIRM_PARAMETER,
                },
                additionalProperties: false,
            },
            output: { schema: { type: 'object' }, render: renderJson },
            timeoutMs: 600_000,
            isConcurrencySafe: () => false,
            execute: async (args) => {
                try {
                    const raw = (args ?? {});
                    if (raw.confirm !== true) {
                        const preview = await engine.diff();
                        return lossless({ ok: true, requiresConfirmation: true, plan: preview });
                    }
                    return lossless({ ok: true, ...(await engine.sync()) });
                }
                catch (error) {
                    return errorResult(error);
                }
            },
        },
        {
            name: 'dsh_session_sync_backup',
            description: 'Upload local DSH sessions to the configured Git repository only, without downloading anything. Pass confirm: true to execute.',
            parameters: {
                type: 'object',
                properties: {
                    confirm: CONFIRM_PARAMETER,
                },
                additionalProperties: false,
            },
            output: { schema: { type: 'object' }, render: renderJson },
            timeoutMs: 600_000,
            isConcurrencySafe: () => false,
            execute: async (args) => {
                try {
                    const raw = (args ?? {});
                    if (raw.confirm !== true) {
                        const preview = await engine.diff();
                        return lossless({ ok: true, requiresConfirmation: true, plan: preview });
                    }
                    return lossless({ ok: true, ...(await engine.backup()) });
                }
                catch (error) {
                    return errorResult(error);
                }
            },
        },
        {
            name: 'dsh_session_sync_restore',
            description: 'Download sessions from the Git backup onto this device. A local log is only replaced after a copy is kept under the plugin data directory. Pass confirm: true to execute.',
            parameters: {
                type: 'object',
                properties: {
                    overwrite: { type: 'boolean', description: 'Allow replacing a local session log that changed since the last sync (a backup copy is kept first).' },
                    confirm: CONFIRM_PARAMETER,
                },
                additionalProperties: false,
            },
            output: { schema: { type: 'object' }, render: renderJson },
            timeoutMs: 600_000,
            isConcurrencySafe: () => false,
            execute: async (args) => {
                try {
                    const raw = (args ?? {});
                    if (raw.confirm !== true) {
                        const preview = await engine.diff();
                        return lossless({ ok: true, requiresConfirmation: true, plan: preview });
                    }
                    return lossless({ ok: true, ...(await engine.restore({ overwrite: raw.overwrite === true })) });
                }
                catch (error) {
                    return errorResult(error);
                }
            },
        },
        {
            name: 'dsh_session_sync_history',
            description: 'List recent commits of the session backup branch: time, commit hash and subject. Read-only.',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Maximum commits to return (default 20, max 200).' },
                },
                additionalProperties: false,
            },
            output: { schema: { type: 'object' }, render: renderJson },
            timeoutMs: 120_000,
            isConcurrencySafe: () => true,
            execute: async (args) => {
                try {
                    const raw = (args ?? {});
                    const limit = Math.max(1, Math.min(200, Math.round(Number(raw.limit)) || 20));
                    return lossless({ ok: true, ...(await engine.history({ limit })) });
                }
                catch (error) {
                    return errorResult(error);
                }
            },
        },
    ];
}

/** Register every tool on the scoped context; returns a disposer. */
export function registerTools(options) {
    const tools = options.ctx.get('tools');
    if (tools === undefined || typeof tools.register !== 'function') {
        options.logger.warn('当前 DSH 环境未注册 Agent 工具服务 / agent tool service unavailable');
        return () => undefined;
    }
    const disposers = [];
    for (const definition of buildToolDefinitions(options.engine)) {
        try {
            disposers.push(tools.register(definition));
        }
        catch (error) {
            options.logger.error(`注册工具失败 / failed to register tool ${definition.name}: ${errorMessage(error)}`);
        }
    }
    options.logger.info(`已注册 ${disposers.length} 个 Agent 工具 / registered agent tools`);
    return () => {
        for (const disposer of disposers.splice(0)) {
            try {
                void disposer();
            }
            catch {
                // Owned by the plugin fiber anyway.
            }
        }
    };
}
