# 更新日志 · Changelog

本文件记录 dsh-git-session-vault 的所有重要变更。
All notable changes to dsh-git-session-vault are documented here.

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-01

首个可用版本。 / First usable release.

### 新增 / Added

- **三向同步**：以内容哈希 `sha256` 作为会话身份，比较 `基线 / 本地 / 远端` 决定上传、下载、跳过或冲突。
  Three-way sync keyed by `sha256` content identity, comparing `baseline / local / remote`.
- **Git 仓库备份布局**：`profiles/<工作区>/sessions/<会话 id>/` 原样保存 DSH 会话文件，附带 `manifest.json` 与 `metadata/schema.json`。
  Repository layout storing DSH session files unchanged, with an index and a self-describing schema.
- **冲突保护**：两边都改动时停止并列出冲突会话，用户逐条选择「保留本地」或「保留远端」后再同步。
  Conflict protection: stop and list both-sides-changed sessions, resolved per session before syncing.
- **append-only 合并**：会话日志只增不改，因此两边各自追加时不再打断用户——本地日志留在原位，远端内容另存为 `<文件>.remote-fork-<UTC 时间戳>-<设备>`，两条线都完整保留。真正分歧（重写、重新压缩、单侧删除）仍然停下来询问。
  Append-only merge: when both sides merely appended, the local log stays in place and the remote lineage is preserved as a fork file instead of interrupting the user. A real divergence still asks.
- **覆盖前备份**：被替换的本地文件先复制到插件数据目录的 `backups/<时间戳>/`。
  Local logs are copied into `backups/<timestamp>/` before being replaced.
- **上传/下载开关**：可单独允许或禁止某个方向，`backup` 与 `restore` 提供单向操作。
  Per-direction switches, plus one-way `backup` and `restore`.
- **自动同步**：启动后延迟同步一次、会话变化后防抖同步，两者都带空闲判断。
  Automatic sync after startup and after session changes, debounced and idle-gated.
- **Web 设置页**：仓库配置、状态卡片、会话表格、冲突面板、历史提交、自动化选项。
  Web settings page with repository form, status tiles, session table, conflict panel, history, and automation options.
- **Agent 工具**：`status` / `list` / `diff` / `sync` / `backup` / `restore` / `history`，写操作需二次确认。
  Agent tools with two-phase confirmation for mutating operations.
- **认证**：系统凭据助手，或从环境变量读取令牌；令牌不落盘，带凭据的 URL 会被剥离并拒绝。
  Credential helper, or a token read from an environment variable; tokens never stored, credentialed URLs stripped and refused.

### 安全 / Security

- 配置与状态文件不保存令牌，只保存环境变量名。
  Configuration and state never store a token, only the variable name.
- 仓库路径经过校验，越界路径（绝对路径、`..`）被拒绝。
  Repository-relative paths are validated; absolute and `..` paths are refused.
- 日志中的仓库地址经过凭据脱敏。
  Repository URLs are redacted in logs.
- **Git 动词白名单**：只允许搬运会话所需的子命令；`push --force`、`reset`、`clean`、`rebase`、`commit --amend` 与隐式切换分支的 `checkout` 在运行时被拒绝，未来改动也无法悄悄引入。
  A runtime Git verb whitelist refuses force pushes, `reset`, `clean`, `rebase`, `commit --amend` and branch-switching `checkout`.
- **更广的脱敏**：GitHub PAT（含 `github_pat_` 新形态）、`sk-`、`glpat-`、`npm_`、`AKIA`、`AIza`、JWT、`Bearer` 头，以及「用户名位置就是令牌」的 `https://<token>@host` 写法。
  Broader redaction: GitHub PATs (including the fine-grained form), `sk-`, `glpat-`, `npm_`, `AKIA`, `AIza`, JWTs, `Bearer` headers, and the PAT-in-username URL form.

### 修复 / Fixed

- 操作结束时写入结果会覆盖同一操作刚保存的基线，导致下一轮同步把普通追加误判为冲突。现在记录结果前会重新读取状态。
  Recording an operation outcome could overwrite the baselines that same operation had just saved, making the next sync misread an ordinary append as a conflict.

### 已知限制 / Known limitations

- Git 历史会持续增长：会话日志是整文件快照，仓库体积随时间上升。
  Git history grows: session logs are whole-file snapshots, so the repository keeps growing.
- 真实分歧（重写、重新压缩、单侧删除）不会自动合并，只提供保留某一边或保留 fork。
  A genuine divergence is never auto-merged; only keeping a side (or the fork) is offered.
