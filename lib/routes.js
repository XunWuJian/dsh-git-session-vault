/**
 * Host HTTP routes for the Web settings page.
 *
 * Routes register on the Host connection's authenticated shared channel
 * (`connection.registerFetchRoute`), so they inherit the deployment's
 * host/origin fence instead of inventing a second gate. Every route is
 * POST + JSON and answers with one envelope: `{ ok: true, value }` or
 * `{ ok: false, error }`.
 * @module routes
 */
import { API_PREFIX } from './constants.js';
import { SyncError, errorMessage, toSyncError } from './util.js';

/** Maximum JSON body accepted by one route. */
const MAX_BODY_BYTES = 64 * 1024;

/** JSON response helper. */
function json(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
        },
    });
}

/** Error envelope. */
function failure(error) {
    const envelope = { code: error.code, message: error.message };
    if (error.details !== undefined)
        envelope.details = error.details;
    return json({ ok: false, error: envelope });
}

/** Read and validate one JSON body. */
async function readBody(request) {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES)
        throw new SyncError('invalid-config', '请求内容过大 / request body too large');
    if (text.trim() === '')
        return {};
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new SyncError('invalid-config', '请求内容不是合法 JSON / request body is not JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SyncError('invalid-config', '请求内容必须是 JSON 对象 / request body must be a JSON object');
    }
    return parsed;
}

/** Register every route; returns a disposer removing all of them. */
export function registerHttpRoutes(options) {
    const disposers = [];
    const routeDisposer = options.ctx.inject(['connection'], scoped => {
        const connection = scoped.get('connection');
        // Two shapes exist in the wild: a registry object with `register()`
        // (older builds) and the Connection service's own
        // `registerFetchRoute(owner, route)` (current builds). Support both so
        // the settings page is not silently dead on either.
        const registry = connection?.fetch;
        const register = typeof registry?.register === 'function'
            ? route => registry.register(route)
            : typeof connection?.registerFetchRoute === 'function'
                ? route => connection.registerFetchRoute(scoped, route)
                : null;
        if (register === null) {
            options.logger.warn('Web 设置页不可用：connection 服务没有路由注册接口 / settings page unavailable: the connection service exposes no route registry');
            return () => undefined;
        }
        const handlers = {
            status: async () => options.engine.status(),
            'config/get': async () => options.engine.getConfig(),
            'config/save': async body => options.engine.saveConfig(body.config ?? body),
            'connection/test': async body => options.engine.testConnection(body.config ?? body),
            // A local-only comparison, used right after a save so the panel
            // never blocks on `git fetch` just to confirm the write.
            peek: async () => options.engine.peek(),
            // Polled by the settings page while an action is in flight.
            progress: async () => options.engine.getProgress(),
            diff: async () => options.engine.diff(),
            sync: async body => options.engine.sync({
                resolve: body.resolve !== null && typeof body.resolve === 'object' ? body.resolve : undefined,
                allowConflicts: body.allowConflicts === true,
            }),
            backup: async body => options.engine.backup({
                resolve: body.resolve !== null && typeof body.resolve === 'object' ? body.resolve : undefined,
            }),
            restore: async body => options.engine.restore({
                resolve: body.resolve !== null && typeof body.resolve === 'object' ? body.resolve : undefined,
            }),
            history: async body => options.engine.history({ limit: Number(body.limit) || 20 }),
            sessions: async () => options.engine.localSessions(),
            inspect: async body => options.engine.inspectSession(String(body.sessionId ?? '')),
            logs: async body => options.engine.logs({ limit: Number(body.limit) || 100 }),
            'conflict/clear': async () => options.engine.clearConflict(),
        };
        const prefixes = [API_PREFIX];
        let registered = 0;
        for (const [name, handler] of Object.entries(handlers)) {
            for (const prefix of prefixes) {
                const path = `${prefix}/${name}`;
                try {
                    disposers.push(register({
                        path,
                        methods: ['POST'],
                        requestBody: 'buffered',
                        fetch: async request => {
                            try {
                                const body = await readBody(request);
                                const value = await handler(body);
                                return json({ ok: true, value });
                            }
                            catch (error) {
                                const syncError = toSyncError(error);
                                if (syncError.code === 'internal')
                                    options.logger.error(`API 失败 / API failure: ${name}: ${syncError.message}`);
                                return failure(syncError);
                            }
                        },
                    }));
                    registered += 1;
                }
                catch (error) {
                    // One rejected path must not take the other routes with it.
                    options.logger.warn(`接口未注册 / route not registered: ${path}: ${errorMessage(error)}`);
                }
            }
        }
        options.logger.info(`已注册 ${registered} 个 Web 接口 / registered settings-page routes`);
        return () => {
            for (const disposer of disposers.splice(0)) {
                try {
                    void disposer();
                }
                catch {
                    // Disposal is best effort; the owning fiber tears down.
                }
            }
        };
    });
    return () => {
        try {
            void routeDisposer();
        }
        catch {
            // Ignore: the fiber is going away.
        }
    };
}
