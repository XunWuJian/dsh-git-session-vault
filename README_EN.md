# Session Sync · DSH Session Sync

Back up, restore, and synchronize DeepSeek Harness session archives across devices using **your own Git repository**.

> ⚠️ **The repository must be private.** Session files contain full conversations — everything you typed, every code block and file path you pasted. A public repository publishes all of it.

## What it solves

DSH stores each session as a local file at `DSH_HOME/sessions/<workspace>/<session id>/session.v4.jsonl.zstd`. Move to another machine and the old conversations are gone; lose the disk and everything is gone.

This plugin puts those files into a Git repository so several devices converge on the same state:

- **New device**: one sync brings back the whole history.
- **Backup**: every sync is a descriptive commit you can roll back to.
- **Multiple devices**: when two machines changed the same session, it **stops and asks** — it never overwrites silently.

## Install

```powershell
dsh plugin add dsh-session-sync
```

Or into a specific profile:

```powershell
dsh plugin add dsh-session-sync --profile web
```

Then open **Settings → Session Sync**.

### From source

```powershell
git clone https://github.com/XunWuJian/dsh-session-sync.git
cd dsh-session-sync
pnpm install
pnpm run build
dsh plugin add .
```

## Quick start

1. Create a **new empty private repository** on GitHub / GitLab / Gitee / your own Git server.
2. Open **Settings → Session Sync** and enter the URL, e.g. `git@github.com:you/private-sessions.git`.
3. Click **Test connection** to confirm access.
4. Click **Sync**. The first run creates the branch, writes the backup layout, and pushes it.

After that: install the plugin on the new device → enter the same repository → click **Sync**.

## Authentication

| Mode | When to use | Configuration |
| --- | --- | --- |
| System credential helper (recommended) | You already have an SSH key or Git credential | Nothing to fill in |
| Environment-variable token | HTTPS + PAT, no credential helper | Enter the variable name, e.g. `DSH_SYNC_TOKEN` |

The token is **never** written to the configuration file — only the variable name is stored. A URL containing credentials (`https://user:token@host/repo`) is stripped and refused.

## Three-way rules

For every session the plugin records a baseline (`base`, the content hash both sides last agreed on). A sync compares `base / local / remote`:

| Local | Remote | Action |
| --- | --- | --- |
| unchanged | unchanged | skip |
| changed | unchanged | **upload** |
| unchanged | changed | **download** (local file backed up first) |
| both changed, same content | | skip |
| both changed, different content | | **conflict: stop and ask** |
| missing | present | **download** |
| present | missing | **upload** |
| first sync, same id, different content | | **conflict** |

Hard rules:

- **A local file is never deleted.** Sessions removed from the repository stay on the device.
- **Every overwrite is backed up first**, into `backups/<timestamp>/` under the plugin data directory.
- **Local edits are never overwritten silently.** A locally modified session requires either explicit *Allow overwrite* or a manual side choice.
- **A failed push is not swallowed.** The commit stays local, the error is reported, the next run retries.

## Repository layout

```
manifest.json                                backup index (workspaces, session list, last operation)
metadata/schema.json                         layout description, self-explanatory for humans
profiles/<workspace>/sessions/<id>/*.zstd    raw session files, stored unchanged
```

Session files keep DSH's own format — **no conversion** — so any machine running DSH can read them directly.

## Settings page

**Settings → Session Sync** provides:

- Repository URL, branch, device name, authentication mode
- Status tiles: local sessions, workspaces, baselines, last sync, latest commit, last operation, last error
- Conflict panel: choose *Keep local* or *Keep remote* per session
- Actions: Sync / Upload only / Download only / Show history
- Options: sub-agent sessions, upload and download switches, overwrite protection, per-session size limit
- Automatic sync: once after startup, and after sessions change (debounced, idle-gated)

## Agent tools

| Tool | Purpose |
| --- | --- |
| `dsh_session_sync_status` | Status, local size, last outcome |
| `dsh_session_sync_list` | List local sessions |
| `dsh_session_sync_diff` | Read-only three-way comparison |
| `dsh_session_sync_sync` | Two-way sync (two-phase confirm) |
| `dsh_session_sync_backup` | Upload only (two-phase confirm) |
| `dsh_session_sync_restore` | Download only (two-phase confirm) |
| `dsh_session_sync_history` | Commit history |

Every mutating tool must be called once without `confirm` to obtain the plan, then again with `confirm: true`.

## Caveats

- **The repository grows forever.** Git keeps history and each session log is a whole-file snapshot. Rebuild the repository periodically, or use a shallow clone.
- **Do not push to a public repository.** The plugin cannot stop you; verify visibility yourself.
- **Conflicts are intentional.** When two devices edited the same session, the plugin does not guess.
- **The first sync uploads every local session.** Make sure the repository is empty, or that merging is what you want.

## Development

```powershell
pnpm install
pnpm run build     # lib/index.js + lib/client.js
pnpm test          # integration test: two devices, one bare repository
```

`src/` is the host half (plain ESM, no `@deepseek-ai/*` runtime dependencies); `src/client.js` is the browser half (esbuild-bundled into a `window.__ModuleLoader__` module). `lib/` is build output — do not edit it by hand.

## License

MIT
