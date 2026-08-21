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
