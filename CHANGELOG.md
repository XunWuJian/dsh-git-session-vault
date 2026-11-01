# 更新日志 · Changelog

本文件记录 dsh-session-sync 的所有重要变更。
All notable changes to dsh-session-sync are documented here.

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-01

首个可用版本。 / First usable release.

### 新增 / Added

- **三向会话同步**：以内容哈希 `sha256` 作为会话身份，比较 `基线 / 本地 / 远端` 决定上传、下载、跳过或冲突。
  Three-way sync keyed by `sha256` content identity, comparing `baseline / local / remote`.
- **Git 仓库备份布局**：`profiles/<工作区>/sessions/<会话 id>/` 原样保存 DSH 会话文件，附带 `manifest.json` 与 `metadata/schema.json`。
  Repository layout storing DSH session files unchanged, with an index and a self-describing schema.
- **冲突保护**：两边都改动时停止并列出冲突会话，用户逐条选择「保留本地」或「保留远端」后再同步。
  Conflict protection: stop and list both-sides-changed sessions, resolved per session before syncing.
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

### 已知限制 / Known limitations

- Git 历史会持续增长：会话日志是整文件快照，仓库体积随时间上升。
  Git history grows: session logs are whole-file snapshots, so the repository keeps growing.
- 会话 id 冲突时不会尝试合并内容，只提供保留某一边。
  Conflicting session ids are never merged; only picking a side is offered.
