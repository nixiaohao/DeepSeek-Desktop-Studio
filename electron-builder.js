const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const { chmodSync, existsSync, renameSync, writeFileSync } = require('node:fs')

/**
 * @pnpm/exe pulls a standalone SEA binary for every platform through
 * optionalDependencies. Only the host platform's package is needed at
 * runtime (dist/pnpm.mjs resolves it by process.platform+arch); exclude the
 * others so we don't ship ~600MB of dead weight for every platform.
 *
 * The exclude globs below list ALL platform packages and then drop the ones
 * that match the current build host, so cross-platform builds (e.g. an
 * AppImage built inside a Linux container on Windows) include the Linux SEA
 * binary instead of the Windows one. These patterns MUST stay exact (no bare
 * linux / macos / win- wildcards) so they never accidentally re-include a
 * package excluded here.
 */
const isWin = process.platform === 'win32'
const isLinux = process.platform === 'linux'
const isMac = process.platform === 'darwin'

const pnpmPlatformExcludes = [
  '!node_modules/@pnpm/win-arm64/**/*',
  '!node_modules/@pnpm/win-x64/**/*',
  '!node_modules/@pnpm/linux-arm64/**/*',
  '!node_modules/@pnpm/linux-x64/**/*',
  '!node_modules/@pnpm/linuxstatic-arm64/**/*',
  '!node_modules/@pnpm/linuxstatic-x64/**/*',
  '!node_modules/@pnpm/macos-arm64/**/*',
  '!node_modules/@pnpm/macos-x64/**/*',
].filter((pattern) => {
  // Keep excludes only for platforms OTHER than the build host.
  if (isWin && pattern.includes('/win-')) return false
  if (isLinux && (pattern.includes('/linux') || pattern.includes('/linuxstatic'))) return false
  if (isMac && pattern.includes('/macos')) return false
  return true
})

// Native SEA binaries must live OUTSIDE the asar (asar files cannot be
// spawned as executables). Keep the host platform's package next to
// @pnpm/exe so dist/pnpm.mjs can resolve it at runtime.
const pnpmUnpack = ['node_modules/@pnpm/exe/**/*']
if (isWin) pnpmUnpack.push('node_modules/@pnpm/win-x64/**/*')
if (isLinux) pnpmUnpack.push('node_modules/@pnpm/linux-x64/**/*', 'node_modules/@pnpm/linuxstatic-x64/**/*')
if (isMac) pnpmUnpack.push('node_modules/@pnpm/macos-x64/**/*', 'node_modules/@pnpm/macos-arm64/**/*')

function resolveRcedit(projectDir) {
  // rcedit ships as an electron-builder dependency; resolve it robustly.
  try {
    return require.resolve('rcedit/bin/rcedit-x64.exe')
  } catch {
    return join(projectDir, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')
  }
}

/**
 * Win32 icon injection — TWO passes are required, they patch different files.
 *
 * `portable` is a self-extracting (NSIS) launcher: running the outer .exe
 * unpacks `win-unpacked/` into a temp directory and then executes the INNER
 * `DeepSeek Studio.exe` from there. Consequences:
 *
 *  1. The TASKBAR icon belongs to the running process, i.e. the INNER exe.
 *     Patching only the outer launcher leaves the taskbar on Electron's
 *     default icon even though Explorer shows the right one — exactly the bug
 *     this fixes. See afterPack().
 *  2. The outer .exe still needs the icon for Explorer / file properties /
 *     the "open with" list. See afterAllArtifactBuild() below.
 *
 * Both are needed because `signAndEditExecutable: false` (required on
 * locked-down Windows that cannot extract winCodeSign's dylib symlinks)
 * disables electron-builder's own rcedit pass entirely.
 */
async function afterAllArtifactBuild(context) {
  if (context.electronPlatformName !== 'win32') return context.artifactPaths
  const projectDir = context.packager.projectDir
  const iconPath = join(projectDir, 'assets', 'icon.ico')
  const rceditExe = resolveRcedit(projectDir)
  for (const artifact of context.artifactPaths) {
    if (!artifact.toLowerCase().endsWith('.exe')) continue
    try {
      execFileSync(rceditExe, [artifact, '--set-icon', iconPath], { stdio: 'ignore' })
      console.log(`[icon] set windows icon on ${artifact}`)
    } catch (e) {
      console.error(`[icon] FAILED to set windows icon on ${artifact}: ${e.message}`)
    }
  }
  return context.artifactPaths
}

async function afterPack(context) {
  const { electronPlatformName, appOutDir } = context

  if (electronPlatformName === 'win32') {
    // Patch the exe that actually RUNS (see the comment above
    // afterAllArtifactBuild). Without this the taskbar keeps Electron's
    // default icon, because `portable` executes this file out of a temp dir.
    const iconPath = join(context.packager.projectDir, 'assets', 'icon.ico')
    const rceditExe = resolveRcedit(context.packager.projectDir)
    const exePath = join(appOutDir, `${context.packager.executableName}.exe`)
    if (existsSync(exePath)) {
      try {
        execFileSync(rceditExe, [exePath, '--set-icon', iconPath], { stdio: 'ignore' })
        console.log(`[icon] set app icon on ${exePath}`)
      } catch (e) {
        console.error(`[icon] FAILED to set app icon on ${exePath}: ${e.message}`)
      }
    } else {
      console.error(`[icon] app exe not found at ${exePath}`)
    }
    return
  }

  if (electronPlatformName === 'linux') {
    // Force --no-sandbox onto the REAL process argv by wrapping the Electron
    // ELF launcher with a shell script. Why this is necessary and reliable:
    //
    //  * The SUID sandbox cannot run on distros that disable unprivileged user
    //    namespaces (Ubuntu 24.04+/Resolute) or inside VM/container sandboxes:
    //    even though electron-builder ships chrome-sandbox as setuid (04755),
    //    the AppImage FUSE mount strips the setuid bit at runtime, so Chromium
    //    aborts with "SUID sandbox helper ... not configured correctly" (or,
    //    when the bit survives, "setuid sandbox is not running as root" +
    //    namespace failures).
    //  * app.commandLine.appendSwitch('no-sandbox') in main.ts is NOT honored
    //    for the early SUID/zygote path (Electron's C++ bootstrap reads argv
    //    before the JS switch is applied). A user who runs the AppImage with a
    //    manual `--no-sandbox` works fine — because the flag is then truly on
    //    the process command line.
    //
    // The wrapper reproduces exactly that manual flag, so it is guaranteed to
    // take effect and the AppImage launches with a double-click / plain
    // `./AppImage` on every distro, with no manual flags and no system deps
    // beyond the usual Electron shared libraries.
    const exe = context.packager.executableName
    const exePath = join(appOutDir, exe)
    const realPath = join(appOutDir, `${exe}.bin`)
    if (existsSync(exePath)) {
      renameSync(exePath, realPath)
      const wrapper =
        '#!/bin/sh\n' +
        'HERE="$(dirname "$(readlink -f "${0}")")"\n' +
        'exec "${HERE}/' + exe + '.bin" --no-sandbox --disable-setuid-sandbox "$@"\n'
      writeFileSync(exePath, wrapper)
      chmodSync(exePath, 0o755)
    }
  }
}

module.exports = {
  appId: 'com.dsh.studio',
  productName: 'DeepSeek Studio',
  directories: { output: 'dist' },
  files: [
    'lib-new/**/*',
    'assets/**/*',
    'themes/**/*',
    'build/icons/**/*',
    // @pnpm/exe pulls SEA binaries for every platform; keep only the build
    // host's package (see pnpmPlatformExcludes above) to avoid shipping
    // ~600MB of dead weight for every platform.
    ...pnpmPlatformExcludes,
  ],
  // @pnpm/exe bundles a native SEA binary that must live OUTSIDE the asar
  // (asar files cannot be spawned as executables). electron-builder copies
  // matched paths to app.asar.unpacked/ keeping the same relative tree.
  // NOTE: keep these patterns EXACT (no linux*/macos*/win-* wildcards) so they
  // don't re-include platform packages excluded by `files` above.
  asarUnpack: pnpmUnpack,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  afterPack,
  afterAllArtifactBuild,
  win: {
    target: 'portable',
    icon: 'assets/icon.ico',
    // Locked-down Windows can't extract winCodeSign's macOS dylib symlinks
    // (no symlink privilege) and has no code-signing certificate anyway.
    // Skip the sign+rcedit step entirely so packaging succeeds.
    signAndEditExecutable: false,
  },
  mac: {
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
    icon: 'assets/icon.icns',
    // No Apple developer certificate — skip signing (users must right-click → open).
    identity: null,
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    // Multi-size icons for .desktop, taskbar and AppImage itself.
    // The build/icons/ directory is scanned by electron-builder; naming a
    // single PNG here produced a generic gear icon in the file manager.
    icon: 'build/icons/',
    category: 'Development',
  },
  // No native modules to rebuild; speeds up packaging and avoids
  // cross-compile issues on locked-down machines.
  npmRebuild: false,
}
