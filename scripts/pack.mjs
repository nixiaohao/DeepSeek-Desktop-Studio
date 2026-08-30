#!/usr/bin/env node
/**
 * pack.mjs — cross-platform packaging entry.
 *
 * Auto-detects the current OS and runs electron-builder with the right
 * target, after verifying the required icon file exists.
 *
 * Usage:  pnpm pack:auto   (or: node scripts/pack.mjs)
 */
import { execSync, execFileSync } from 'node:child_process'
import { existsSync, globSync } from 'node:fs'
import { platform } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const shellRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const REQUIREMENTS = {
  win32: { flag: '--win', icons: ['icon.ico'] },
  darwin: { flag: '--mac', icons: ['icon.icns'] },
  linux: { flag: '--linux', icons: ['icon.png'] },
}

const os = platform()
const req = REQUIREMENTS[os]
if (!req) {
  console.error(`[pack] 不支持的平台: ${os}`)
  process.exit(1)
}

// 1. Icon check
const missing = req.icons.filter((f) => !existsSync(join(shellRoot, 'assets', f)))
if (missing.length) {
  console.error(`[pack] 缺少打包图标: assets/${missing.join(', ')}`)
  if (os === 'darwin') {
    console.error('[pack] 提示: Mac 需要 icon.icns。可在 Mac 上用 iconutil 生成，或先用临时图标占位。')
  } else if (os === 'linux') {
    console.error('[pack] 提示: Linux 需要 ≥256x256 的 icon.png。')
  }
  process.exit(1)
}

// 2. Target hints
if (os === 'darwin') {
  console.log('[pack] 提示: dmg 目标必须在 macOS 上构建（本机 Windows 无法交叉打包 mac）。')
  console.log('[pack] 未签名应用首次打开需右键 → 打开。')
} else if (os === 'linux') {
  console.log('[pack] 提示: AppImage 需 chmod +x 后运行。')
}

console.log(`[pack] 平台: ${os} → electron-builder ${req.flag}`)
execSync(`electron-builder ${req.flag}`, {
  cwd: shellRoot,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
})

// On Windows, electron-builder's afterAllArtifactBuild hook can be blocked
// by external file-system guards that intercept temporary-file cleanup.
// Re-apply the icon to every .exe in dist/ so the final artifact always
// carries the right icon even when that hook is skipped.
if (os === 'win32') {
  const require = createRequire(import.meta.url)
  let rceditExe
  try {
    rceditExe = require.resolve('rcedit/bin/rcedit-x64.exe')
  } catch {
    rceditExe = join(shellRoot, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')
  }
  if (existsSync(rceditExe)) {
    const exes = globSync('*.exe', { cwd: join(shellRoot, 'dist') })
    for (const exe of exes) {
      const exePath = join(shellRoot, 'dist', exe)
      try {
        execFileSync(rceditExe, [exePath, '--set-icon', join(shellRoot, 'assets', 'icon.ico')], { stdio: 'inherit' })
        console.log(`[pack] icon applied: ${exePath}`)
      } catch (e) {
        console.error(`[pack] failed to set icon on ${exePath}: ${e.message}`)
      }
    }
  } else {
    console.error('[pack] rcedit not found; skipping Windows icon fix')
  }
}
