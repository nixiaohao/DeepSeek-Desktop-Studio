# DeepSeek Desktop Studio

> Electron desktop shell for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

DeepSeek Desktop Studio wraps the `dsh` command-line workflow in a native
desktop app: system tray integration, a first-run wizard, plugin market
installation, and workspace management — without touching a terminal.

## Features

- **System tray + menu** — launch, restart and quit the app from the tray; a
  full app menu with plugin management entries.
- **First-run wizard** — configure the workspace directory and app preferences
  on first launch.
- **Plugin market installer** — install the `dshmarket` plugin with one click.
  The installer auto-detects the system `pnpm` across common installation
  methods:
  - npm global install (`npm i -g pnpm`)
  - [official standalone installer](https://pnpm.io/installation) (`PNPM_HOME`)
  - corepack shim
  - Volta / nvm-windows / fnm / asdf
  - scoop / chocolatey
  - macOS Homebrew, Linux package managers
- **Portable-restart support** — the "restart app" action works correctly when
  the app is packaged as a portable `exe` (electron-builder `portable`
  target), by relaunching the original executable instead of the temp-dir
  copy.
- **Themes** — runtime theme switching via `themes/`.

## Architecture

```
src/*.ts  ──(tsc)──▶  lib-new/*.js  ──(electron-builder)──▶  dist/*.exe
```

| Module | Responsibility |
| --- | --- |
| `main.ts` | Electron main process bootstrap, lifecycle, dialogs |
| `launcher.ts` | Spawns the `dsh` harness CLI with the resolved runtime |
| `runtime-source.ts` | Locates/installs `dsh`, resolves pnpm (system first, bundled fallback) |
| `env-detector.ts` | Cross-platform detection of node / pnpm / git |
| `workspace.ts` | Workspace management (profiles) |
| `wizard.ts` | First-run setup wizard window |
| `preferences.ts` / `theme.ts` | Preferences & theming |
| `tray.ts` / `menu.ts` | System tray & application menu |
| `relaunch.ts` | Portable-aware app relaunch |
| `preload.ts` | Renderer bridge (contextBridge) |
| `logging.ts` / `env-check.ts` | Diagnostics |

## Requirements

- Node.js 18+ (or 20+ recommended)
- pnpm — any installation method works (see above); if none is found, the app
  falls back to a bundled pnpm.
- The `dsh` CLI is resolved/installed automatically by the launcher.

## Development

```bash
npm install          # or: pnpm install
npm run dev          # tsc + electron (dev mode, no packaging)
```

## Packaging

```bash
npm run pack         # Windows portable exe → dist/
npm run pack:mac     # macOS dmg
npm run pack:linux   # Linux AppImage
```

The Windows build targets `portable` (single self-contained exe). The
`electron-builder.js` hook re-applies the app icon after packing because
`signAndEditExecutable` is disabled for locked-down environments.

## Usage

1. Double-click the packaged exe (or `npm run dev`).
2. Follow the first-run wizard to pick a workspace.
3. Open **Plugin Market → Install dshmarket** from the menu (or click retry
   when prompted).
4. Restart the app when asked — the restart action relaunches the original
   executable, so it works from the portable exe too.

## License

[MIT](LICENSE)

This project is built on top of
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(MIT © 2026 DeepSeek). See `LICENSE` for the full text.

---

## 中文说明（简体中文）

> 适用于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（简称 `dsh`）的 Electron 桌面外壳。

DeepSeek Desktop Studio 把 `dsh` 命令行工作流封装成一个原生桌面应用：系统托盘集成、首次启动向导、插件市场安装、工作区管理——全程无需打开终端。

### 功能特性

- **系统托盘 + 菜单** —— 通过托盘即可启动、重启、退出应用；应用菜单内置插件管理入口。
- **首次启动向导** —— 首次打开时配置工作区目录与应用偏好。
- **插件市场安装器** —— 一键安装 `dshmarket` 插件。安装器会自动探测系统中以各种方式安装的 `pnpm`：
  - npm 全局安装（`npm i -g pnpm`）
  - [官方独立安装器](https://pnpm.io/installation)（`PNPM_HOME`）
  - corepack 垫片
  - Volta / nvm-windows / fnm / asdf
  - scoop / chocolatey
  - macOS Homebrew、Linux 各发行版包管理器
- **便携版重启支持** —— 当应用被打包成便携 `exe`（electron-builder 的 `portable` 目标）时，"重启应用"动作依然正确：它会重新启动原始可执行文件，而非临时目录里的副本。
- **主题切换** —— 通过 `themes/` 目录在运行时切换主题。

### 架构

```
src/*.ts  ──(tsc)──▶  lib-new/*.js  ──(electron-builder)──▶  dist/*.exe
```

| 模块 | 职责 |
| --- | --- |
| `main.ts` | Electron 主进程启动、生命周期管理、各类对话框 |
| `launcher.ts` | 用解析出的运行时拉起 `dsh` harness CLI |
| `runtime-source.ts` | 定位/安装 `dsh`，解析 pnpm（优先系统，其次内置兜底） |
| `env-detector.ts` | 跨平台探测 node / pnpm / git |
| `workspace.ts` | 工作区管理（配置文件/Profile） |
| `wizard.ts` | 首次启动设置向导窗口 |
| `preferences.ts` / `theme.ts` | 偏好设置与主题 |
| `tray.ts` / `menu.ts` | 系统托盘与应用菜单 |
| `relaunch.ts` | 感知便携版的应用重启 |
| `preload.ts` | 渲染进程桥接（contextBridge） |
| `logging.ts` / `env-check.ts` | 诊断与自检 |

### 环境要求

- Node.js 18+（推荐 20+）
- pnpm —— 上述任意安装方式均可；若都找不到，应用会回退到内置 pnpm。
- `dsh` CLI 由启动器自动解析/安装。

### 开发

```bash
npm install          # 或：pnpm install
npm run dev          # tsc + electron（开发模式，不打包）
```

### 打包

```bash
npm run pack         # Windows 便携 exe → dist/
npm run pack:mac     # macOS dmg
npm run pack:linux   # Linux AppImage
```

Windows 构建目标为 `portable`（单个自包含 exe）。由于受限环境下禁用了 `signAndEditExecutable`，`electron-builder.js` 钩子会在打包完成后重新应用应用图标。

### 使用步骤

1. 双击打包好的 exe（或执行 `npm run dev`）。
2. 按首次启动向导选择一个工作区。
3. 在菜单中打开 **插件市场 → 安装 dshmarket**（或在弹窗出现时点击重试）。
4. 按提示重启应用——重启动作会重新启动原始可执行文件，因此便携版 exe 同样可用。

### 许可证

[MIT](LICENSE)

本项目构建于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT © 2026 DeepSeek）之上。完整文本见 `LICENSE`。
