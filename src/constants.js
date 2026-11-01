/**
 * Shared constants for the host and browser halves.
 * @module constants
 */

/** npm package name; also the Cordis plugin name and the bundle row id. */
export const PACKAGE_NAME = 'dsh-session-vault';

/** Display name, Chinese / English. */
export const TITLE_ZH = '会话保险库';
export const TITLE_EN = 'Session Vault';

/** Data directory under the DSH home: `$DSH_HOME/dsh-session-vault/`. */
export const APP_DIR_NAME = 'dsh-session-vault';

/** Backup schema written into the repository; a newer version is refused. */
export const SCHEMA_VERSION = 1;

/**
 * Host route prefix for the settings page.
 *
 * The Connection service validates every exact Fetch route with
 * `endpointFromPath('/api', path)`, so the leading slash and the `/api`
 * channel are part of the registered path itself.
 */
export const API_PREFIX = `/api/${PACKAGE_NAME}`;

/** Default branch when the user leaves the field empty. */
export const DEFAULT_BRANCH = 'main';

/** Reserved backup directory names a user must not pick. */
export const RESERVED_BACKUP_DIRS = ['.git', 'config.json', 'state.json', 'sync.log', 'work'];

/** Auto-sync defaults: event driven, never a bare interval timer. */
export const DEFAULT_AUTO_SYNC = {
    enabled: false,
    onStartup: false,
    onSessionChange: false,
    startupDelayMs: 25_000,
    debounceMs: 30_000,
};

/** A session file is considered idle after this long without writes. */
export const IDLE_SESSION_MS = 20_000;

/** Upper bound for one Git invocation's captured stdout. */
export const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
