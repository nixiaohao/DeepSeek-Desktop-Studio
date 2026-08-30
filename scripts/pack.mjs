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
import { existsSync, globSync, rmSync } from 'node:fs'
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

const distDir = join(shellRoot, 'dist')

// Drop stale artifacts first: a build that dies before producing output must
// never be mistaken for a success just because last run's .exe is still there.
// The intermediate NSIS archive matters most — electron-builder has to remove
// it before it can assemble the final executable, and a stale 100MB archive
// that cannot be deleted aborts the build (leaving a stub-sized .exe).
if (os === 'win32') {
  for (const pattern of ['*.exe', '*.7z']) {
    for (const stale of globSync(pattern, { cwd: distDir })) {
      try {
        rmSync(join(distDir, stale), { force: true })
        console.log(`[pack] removed stale artifact: ${stale}`)
      } catch {
        /* best-effort: a locked file simply stays and is reported below */
      }
    }
  }
}

console.log(`[pack] 平台: ${os} → electron-builder ${req.flag}`)
let builderError = null
try {
  execSync(`electron-builder ${req.flag}`, {
    cwd: shellRoot,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  })
} catch (e) {
  // electron-builder can exit non-zero AFTER the artifact is complete, for
  // example when a file guard blocks its final temporary-file cleanup. Judge
  // by the artifacts instead of the exit code.
  builderError = e
}

// On Windows, re-apply the icon to every produced .exe. electron-builder's
// own rcedit pass (afterAllArtifactBuild) is skipped whenever the build
// aborts during cleanup — precisely the case above.
let produced = []
if (os === 'win32') {
  const require = createRequire(import.meta.url)
  let rceditExe
  try {
    rceditExe = require.resolve('rcedit/bin/rcedit-x64.exe')
  } catch {
    // rcedit's package exports do not expose the binary; use the on-disk path.
    rceditExe = join(shellRoot, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')
  }
  produced = globSync('*.exe', { cwd: distDir })
  if (!existsSync(rceditExe)) {
    console.error('[pack] rcedit not found; skipping Windows icon fix')
  } else {
    for (const exe of produced) {
      const exePath = join(distDir, exe)
      try {
        execFileSync(rceditExe, [exePath, '--set-icon', join(shellRoot, 'assets', 'icon.ico')], { stdio: 'inherit' })
        console.log(`[pack] icon applied: ${exePath}`)
      } catch (e) {
        console.error(`[pack] failed to set icon on ${exePath}: ${e.message}`)
      }
    }
  }
}

if (builderError) {
  if (produced.length > 0) {
    console.error('[pack] electron-builder exited non-zero, but the artifact was produced.')
  } else {
    console.error('[pack] electron-builder failed and produced no artifact.')
    process.exit(1)
  }
}
