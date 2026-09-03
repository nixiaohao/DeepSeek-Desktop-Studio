# DeepSeek Desktop Studio

> Electron desktop shell for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

DeepSeek Desktop Studio wraps the `dsh` command-line workflow in a native
desktop app, then adds a real workbench around it: a three-column layout with
a file/git sidebar, a change-review and health panel, a bottom log bar, a
command palette, and guarded git operations — without touching a terminal.

It is deliberately **not** a heavyweight IDE. Everything it adds is a shell
around the dsh page; the coding itself still happens in your editor and in
the agent.

## Features

### Workbench layout

- **File/git sidebar** (left) — directory tree with change badges, one-click
  diff with lightweight syntax highlighting, and the dsh session directories
  as one-click workspace suggestions. Its **Sessions** tab lists dsh's
  sessions grouped by project: click one to re-root the tree at its
  directory, double-click to narrow the log bar to that conversation's agent
  activity (subagents included).
- **Monitoring panel** (right) — change review with per-tool approval and
  batch allow/reject, backend health readout, and the backend's raw output.
- **Bottom log bar** — shell, backend and agent activity in one place, with
  per-source filters, a session filter set from the sidebar's Sessions tab,
  and drag-to-resize.
- **Status bar** — dsh version/port/channel, plus live aggregated agent
  stats (LLM time, tool time, tokens up/down, subagent count) covering main
  and subagents alike.
- Every panel can be toggled, resized and persisted; the layout degrades
  gracefully on small windows (panels collapse instead of squeezing the dsh
  page below its usable minimum).

### Git panel (guarded)

Stage, unstage and commit from the sidebar — or switch branches and discard
a file's unstaged changes. All of it runs through three hard guards enforced
in the only module that shells out to git:

1. the auto-update workspace is **read-only** (the updater would wipe local
   writes) — write actions are refused and the UI says so;
2. a live `.git/index.lock` is never fought over;
3. destructive actions (branch switch, discard) carry an explicit
   double-confirm, and the discard only ever touches tracked files with
   unstaged changes — staged content survives a stray click.

Hooks run normally and are never skipped.

### Command palette

`Ctrl+K` opens a fuzzy-matched palette over the app's own menu actions —
panel toggles, settings, diagnostics, backend restart, font scale steps.
The palette is built from the same action closures the menu uses, so it can
never offer an action the app cannot perform.

### Panels & views

- **Diagnostics window** (`Ctrl+Alt+D`) — self-check of every preload and
  view, log tails, and a redacted copy-to-clipboard report. It is the one
  window that must keep working when the others are broken, so its preload
  is the most sandboxed thing in the app.
- **Settings window** (`Ctrl+,`) — theme, panel font scale, panel visibility,
  external editor, update channel.
- **External editor integration** — presets (VS Code / Cursor / Notepad++ /
  custom template) for opening files and diffs; the shell never bundles an
  editor of its own.
- **Font scale** — four steps applied to every shell page via an injected
  CSS variable (never `setZoomFactor`, which would break the layout).

### Inherited from the launcher

- **System tray + menu**, **first-run wizard**, **plugin market installer**
  (auto-detects pnpm across npm global / standalone installer / corepack /
  Volta / nvm-windows / fnm / asdf / scoop / chocolatey / Homebrew / distro
  package managers), **portable-restart support**, **runtime themes**.

## Architecture

```
src/*.ts  ──(tsc)──▶  lib-new/*.js  ──(electron-builder)──▶  dist/*
```

| Area | Modules | Responsibility |
| --- | --- | --- |
| Bootstrap | `main.ts`, `launcher.ts`, `runtime-source.ts`, `env-detector.ts`, `workspace.ts`, `wizard.ts` | App lifecycle, spawning/resolving dsh, first-run |
| Windows & layout | `window-manager.ts`, `layout-geometry.ts`, `ui-scale.ts` | WebContentsView layout, geometry arithmetic (pure, unit-tested) |
| Panels | `ipc-registry.ts`, `panel-preload.ts`, `sidebar-preload.ts`, `logbar-preload.ts` | Every IPC channel in one registry; sandboxed page bridges |
| Git | `git-service.ts`, `fs-tree.ts`, `file-tree.ts`, `sidebar-service.ts` | The only module that shells out to git; all write guards live here |
| Agent feeds | `dsh-stream.ts`, `event-store.ts`, `stats-model.ts`, `approval-groups.ts` | SSE mux consumption, session projections, aggregated stats |
| Command palette | `command-model.ts`, `command-registry.ts`, `command-palette-window.ts` | Zero-dependency fuzzy matching, dispatch from menu closures |
| Logging & diagnostics | `logging.ts`, `redact.ts`, `health-monitor.ts`, `diagnostics*.ts` | Ring buffers, token redaction, health phases, self-check |
| Infrastructure | `preferences.ts`, `theme.ts`, `external-editor.ts`, `channels.ts`, `tray.ts`, `menu.ts`, `relaunch.ts` | Config, theming, editor integration, tray/menu |

Pure-logic modules (geometry, stats, models, guards) carry zero runtime
dependencies and are unit-tested in plain node — see `test/`.

## Testing

```bash
npm test            # tsc + 29 unit/contract/smoke suites
```

The suite includes contract tests that scan the preload/HTML/IPC sources for
bridge drift (a method used by a page but never exposed, or a channel never
registered), dependency rules for sandboxed preloads, and type-scale rules
that keep every shell page scalable. Mutation testing is used during
development to prove the tests catch real regressions.

## Requirements

- Node.js 18+ (or 20+ recommended)
- pnpm — any installation method works (see above); if none is found, the app
  falls back to a bundled pnpm.
- The `dsh` CLI is resolved/installed automatically by the launcher.

## Development

```bash
npm install          # or: pnpm install
npm run dev          # tsc + electron (dev mode, no packaging)
npm test             # full unit/contract/smoke suite
```

## Packaging

```bash
npm run pack         # Windows portable exe → dist/
npm run pack:mac     # macOS dmg
npm run pack:linux   # Linux AppImage (build inside Linux — see below)
```

The Windows build targets `portable` (single self-contained exe). The
`electron-builder.js` hook re-applies the app icon after packing because
`signAndEditExecutable` is disabled for locked-down environments.

Linux needs `dpkg`/`fakeroot`, so build the AppImage inside a Linux container
(`node:22-bookworm`): copy the source in (excluding `node_modules`), `npm
install`, `tsc`, then `electron-builder --linux`. The `afterPack` hook
renames the main ELF and wraps it with a `--no-sandbox` launcher script so
the AppImage also starts on distributions that disallow unprivileged
user namespaces (e.g. Ubuntu 24.04+).

## Usage

1. Double-click the packaged exe (or `npm run dev`).
2. Follow the first-run wizard to pick a workspace.
3. Open **Plugin Market → Install dshmarket** from the menu (or click retry
   when prompted).
4. Restart the app when asked — the restart action relaunches the original
   executable, so it works from the portable exe too.

Shortcuts worth knowing: `Ctrl+K` command palette, `Ctrl+,` settings,
`Ctrl+Alt+D` diagnostics, `Ctrl+Alt+F/B/S/L` sidebar/panel/status/log bar.

## License

[MIT](LICENSE)

This project is built on top of
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(MIT © 2026 DeepSeek). See `LICENSE` for the full text.

---

## 中文说明（简体中文）

> 适用于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（简称 `dsh`）的 Electron 桌面外壳。

DeepSeek Desktop Studio 把 `dsh` 命令行工作流封装成原生桌面应用，再围绕它加了一层真正的工作台：文件/git 侧栏、变更审查与健康监控面板、底部日志面板、命令面板、带护栏的 git 操作——全程无需打开终端。

它刻意**不做重量级 IDE**：所有附加物都是围绕 dsh 页面的壳；写代码这件事仍然发生在你自己的编辑器和 agent 里。

### 功能特性

#### 工作台布局

- **文件/git 侧栏**（左）—— 带变更徽标的目录树、一键 diff（轻量语法高亮）、dsh 会话目录一键切换工作区。**会话**页按项目分组列出 dsh 会话：点击定位到该会话目录，双击把日志面板收窄到该会话的 agent 活动（含子 agent）。
- **监控面板**（右）—— 变更审查（按工具审批、批量允许/拒绝）、后端健康读数、后端原始输出。
- **底部日志面板** —— shell、后端、agent 活动三源合一，按来源过滤，也可按会话过滤（由侧栏会话页双击设定），顶部拖拽调高。
- **状态栏** —— dsh 版本/端口/通道，加上实时聚合的 agent 统计（LLM 耗时、工具耗时、↑↓ token、子 agent 数），主 agent 与子 agent 一并覆盖。
- 每个面板都可显隐、拖拽、持久化；小窗口下优雅降级（面板塌缩，而不是把 dsh 页面挤到不可用）。

#### git 面板（带护栏）

在侧栏里暂存、取消暂存、提交，也能切分支、放弃单文件的未暂存改动。所有操作经过三道硬护栏，强制在唯一与 git 进程打交道的模块里执行：

1. 自动更新工作区**只读**（更新器会覆盖本地写入）——写操作被拒绝，UI 明示原因；
2. 存在 `.git/index.lock` 时绝不争抢；
3. 破坏性操作（切分支、放弃改动）带显式二次确认；放弃动作只碰「已跟踪且有未暂存改动」的文件——误点不会波及已暂存内容。

hooks 正常运行，绝不跳过。

#### 命令面板

`Ctrl+K` 打开模糊匹配的命令面板，覆盖应用自身的菜单动作——面板显隐、设置、诊断、重启后端、字号档位。命令列表由菜单同一批动作闭包构建，因此面板永远不可能给出应用做不到的动作。

#### 面板与视图

- **诊断自检窗口**（`Ctrl+Alt+D`）—— 各 preload 与视图自检、日志尾部、脱敏后一键复制报告。它是「其他东西都坏了时还能用的那个窗口」，因此它的 preload 是全应用沙箱最严格的地方。
- **设置窗口**（`Ctrl+,`）—— 主题、面板字号、面板显隐、外部编辑器、更新通道。
- **外部编辑器集成** —— 预设（VS Code / Cursor / Notepad++ / 自定义模板）用于打开文件与 diff；本程序不内置编辑器。
- **面板字号** —— 四个档位，通过注入 CSS 变量作用于每个 shell 页面（绝不用 `setZoomFactor`，那会破坏布局）。

#### 继承自启动器的能力

- **系统托盘 + 菜单**、**首次启动向导**、**插件市场安装器**（自动探测各种方式安装的 pnpm：npm 全局 / 官方独立安装器 / corepack / Volta / nvm-windows / fnm / asdf / scoop / chocolatey / Homebrew / 各发行版包管理器）、**便携版重启支持**、**运行时主题**。

### 架构

```
src/*.ts  ──(tsc)──▶  lib-new/*.js  ──(electron-builder)──▶  dist/*
```

| 领域 | 模块 | 职责 |
| --- | --- | --- |
| 启动 | `main.ts`、`launcher.ts`、`runtime-source.ts`、`env-detector.ts`、`workspace.ts`、`wizard.ts` | 应用生命周期、拉起/解析 dsh、首次启动 |
| 窗口与布局 | `window-manager.ts`、`layout-geometry.ts`、`ui-scale.ts` | WebContentsView 布局、几何运算（纯函数、单测覆盖） |
| 面板 | `ipc-registry.ts`、`panel-preload.ts`、`sidebar-preload.ts`、`logbar-preload.ts` | 全部 IPC 通道集中注册；沙箱化页面桥 |
| git | `git-service.ts`、`fs-tree.ts`、`file-tree.ts`、`sidebar-service.ts` | 唯一与 git 进程打交道的模块；全部写护栏在此 |
| agent 数据 | `dsh-stream.ts`、`event-store.ts`、`stats-model.ts`、`approval-groups.ts` | SSE mux 消费、会话投影、聚合统计 |
| 命令面板 | `command-model.ts`、`command-registry.ts`、`command-palette-window.ts` | 零依赖模糊匹配、从菜单闭包分发 |
| 日志与诊断 | `logging.ts`、`redact.ts`、`health-monitor.ts`、`diagnostics*.ts` | 环形缓冲、token 脱敏、健康相位、自检 |
| 基础设施 | `preferences.ts`、`theme.ts`、`external-editor.ts`、`channels.ts`、`tray.ts`、`menu.ts`、`relaunch.ts` | 配置、主题、编辑器集成、托盘/菜单 |

纯逻辑模块（几何、统计、模型、护栏）零运行时依赖，可在纯 node 下单测——见 `test/`。

### 测试

```bash
npm test            # tsc + 29 个单元/契约/冒烟套件
```

套件包含契约测试：扫描 preload/HTML/IPC 源码防止桥漂移（页面用了但 preload 没暴露的方法、注册了但没人发的通道）、沙箱 preload 的依赖规则、以及保证每个 shell 页面可缩放的字号 token 规则。开发过程中使用变异测试证明这些测试真能抓住回归。

### 环境要求

- Node.js 18+（推荐 20+）
- pnpm —— 上述任意安装方式均可；若都找不到，应用会回退到内置 pnpm。
- `dsh` CLI 由启动器自动解析/安装。

### 开发

```bash
npm install          # 或：pnpm install
npm run dev          # tsc + electron（开发模式，不打包）
npm test             # 完整单元/契约/冒烟套件
```

### 打包

```bash
npm run pack         # Windows 便携 exe → dist/
npm run pack:mac     # macOS dmg
npm run pack:linux   # Linux AppImage（需在 Linux 内构建，见下）
```

Windows 构建目标为 `portable`（单个自包含 exe）。由于受限环境下禁用了 `signAndEditExecutable`，`electron-builder.js` 钩子会在打包完成后重新应用应用图标。

Linux 需要 `dpkg`/`fakeroot`，请在 Linux 容器（`node:22-bookworm`）内构建：源码拷入（排除 `node_modules`）、`npm install`、`tsc`、`electron-builder --linux`。`afterPack` 钩子会把主程序 ELF 改名并换成带 `--no-sandbox` 的启动脚本，使 AppImage 在禁用非特权 user namespace 的发行版（如 Ubuntu 24.04+）上也能启动。

### 使用步骤

1. 双击打包好的 exe（或执行 `npm run dev`）。
2. 按首次启动向导选择一个工作区。
3. 在菜单中打开 **插件市场 → 安装 dshmarket**（或在弹窗出现时点击重试）。
4. 按提示重启应用——重启动作会重新启动原始可执行文件，因此便携版 exe 同样可用。

值得一记的快捷键：`Ctrl+K` 命令面板、`Ctrl+,` 设置、`Ctrl+Alt+D` 诊断、`Ctrl+Alt+F/B/S/L` 侧栏/监控/状态栏/日志面板。

### 许可证

[MIT](LICENSE)

本项目构建于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT © 2026 DeepSeek）之上。完整文本见 `LICENSE`。

## Changelog / 更新日志

### v0.2.0 — 2026-09-03（首次公开发布 / first public release）

**English**
- Added: three-column workbench — file/git sidebar, monitoring panel, bottom
  log bar (drag-to-resize), status bar with live aggregated agent stats
  covering main and subagents.
- Added: guarded git operations in the sidebar — stage/unstage/commit,
  branch switching and discard with double-confirm; the auto-update
  workspace stays read-only, index.lock is respected, hooks run normally.
- Added: `Ctrl+K` command palette, diagnostics self-check window
  (`Ctrl+Alt+D`), settings window (`Ctrl+,`), external editor integration,
  panel font scaling, workspace switcher (root name → dsh session dirs).
- Added: the monitoring panel's 概览 tab (context occupancy, token
  composition, run metrics) and three layout presets (专注 / 经典 / 极简).
- Added: the status bar's cost segment — cache hit rate plus an estimated
  cost, priced from a user-editable table at `~/.dsh/model-prices.json`
  (built-in DeepSeek pricing; unmatched presets are simply not priced).
- Added: the sidebar's Sessions tab — dsh sessions grouped by project,
  newest first, with their upstream titles; a click re-roots the file tree.
- Added: session-scoped log filter — double-click a session in the sidebar's
  Sessions tab and the bottom log bar follows that conversation (subagents
  included); the filter shows as a chip in the log bar and clears with one
  click. The log bar is revealed automatically if it was hidden.
- Fixed: the log bar's path menu called a toast helper that did not exist, so
  a failed "open in editor" looked exactly like a successful one.
- Fixed: clicking a session whose directory was already the sidebar's root
  did nothing at all, with no feedback.
- Internal: every IPC channel centralized in one registry; pure-logic
  modules kept dependency-free and unit-tested; contract tests guard the
  preload/page/channel wiring.

**中文**
- 新增：三栏工作台——文件/git 侧栏、监控面板、底部日志面板（可拖拽调高）、状态栏（实时聚合的 agent 统计，主/子 agent 一并覆盖）。
- 新增：侧栏带护栏的 git 操作——暂存/取消暂存/提交、切分支与放弃改动（二次确认）；自动更新工作区保持只读、尊重 index.lock、hooks 正常运行。
- 新增：`Ctrl+K` 命令面板、诊断自检窗口（`Ctrl+Alt+D`）、设置窗口（`Ctrl+,`）、外部编辑器集成、面板字号调节、工作区切换器（根目录名 → dsh 会话目录）。
- 新增：监控面板「概览」页（上下文占用、token 构成、运行指标）与三档布局预设（专注/经典/极简）。
- 新增：状态栏费用段——命中率 + 估算费用，价格来自 `~/.dsh/model-prices.json`（用户可编辑，内置 DeepSeek 官方价；未匹配的 preset 不计费）。
- 新增：侧栏「会话」页——按项目分组、最新在前、带上游标题；点击可把文件树定位到该会话目录。
- 新增：按会话过滤日志——在侧栏「会话」页双击会话，底部日志面板只跟随该会话（含子 agent）；过滤以 chip 形式显示在日志面板上，一键取消。日志面板原本隐藏时会自动显示。
- 修复：日志面板路径菜单调用了一个并不存在的提示函数，导致「用编辑器打开」失败时看起来和成功一样。
- 修复：点击目录已等于侧栏根目录的会话时毫无反应且无任何提示。
- 内部：全部 IPC 通道集中注册；纯逻辑模块保持零依赖并可单测；契约测试守护 preload/页面/通道接线。

### v0.1.0 — 2026-08-22

**English**
- Fixed: the first-run wizard window no longer stays open after clicking "Launch" — it now closes itself once the main window starts.
- Fixed: the second launch failed with `DSH_CLIENT_COMMIT_HASH must be a Git commit hash; got ""`. The wizard now injects the resolved HEAD commit hash into the build environment, so the first build succeeds and subsequent launches skip rebuilding (cached).

**中文**
- 修复：首次启动向导在点击「启动程序」后不再残留开启——主窗口启动后，向导窗口会自动关闭。
- 修复：第二次启动时报错 `DSH_CLIENT_COMMIT_HASH must be a Git commit hash; got ""`。现在向导会在构建环境中显式注入解析到的 HEAD 提交哈希，首次构建成功后，后续启动将跳过重建（已缓存）。
