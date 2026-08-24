const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const { chmodSync, existsSync } = require('node:fs')

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

/**
 * electron-builder skips rcedit when `signAndEditExecutable: false`, so the
 * exe ends up with the default Electron icon. This hook re-applies the app
 * icon after the unpacked exe is produced (before portable packaging).
 */
async function afterPack(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName === 'win32') {
    const rceditExe = join(context.packager.projectDir, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')
    const exePath = join(appOutDir, `${context.packager.appInfo.productName}.exe`)
    const iconPath = join(context.packager.projectDir, 'assets', 'icon.ico')
    execFileSync(rceditExe, [exePath, '--set-icon', iconPath])
    return
  }
  if (electronPlatformName === 'linux') {
    // Make chrome-sandbox setuid-root so the SUID sandbox path is correctly
    // configured on distros that disable unprivileged user namespaces
    // (Ubuntu 24.04+/Resolute). Combined with the --no-sandbox /
    // --disable-setuid-sandbox switches added in main.ts, the AppImage then
    // launches directly without manual flags. Built as root in the container
    // so the bit survives into the squashfs and stays root:root on the host.
    const sandbox = join(appOutDir, 'chrome-sandbox')
    if (existsSync(sandbox)) chmodSync(sandbox, 0o4755)
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
    icon: 'assets/icon.png',
    category: 'Development',
  },
  // No native modules to rebuild; speeds up packaging and avoids
  // cross-compile issues on locked-down machines.
  npmRebuild: false,
}
