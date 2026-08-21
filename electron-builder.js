const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

/**
 * electron-builder skips rcedit when `signAndEditExecutable: false`, so the
 * exe ends up with the default Electron icon. This hook re-applies the app
 * icon after the unpacked exe is produced (before portable packaging).
 */
async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const rceditExe = join(context.packager.projectDir, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')
  const exePath = join(context.appOutDir, `${context.packager.appInfo.productName}.exe`)
  const iconPath = join(context.packager.projectDir, 'assets', 'icon.ico')
  execFileSync(rceditExe, [exePath, '--set-icon', iconPath])
}

module.exports = {
  appId: 'com.dsh.studio',
  productName: 'DeepSeek Studio',
  directories: { output: 'dist' },
  files: [
    'lib-new/**/*',
    'assets/**/*',
    'themes/**/*',
    // @pnpm/exe pulls SEA binaries for every platform via optionalDependencies.
    // Only the host platform's package is needed at runtime (dist/pnpm.mjs
    // resolves it by process.platform+arch); exclude the rest to avoid
    // shipping ~600MB of dead weight in the installer.
    '!node_modules/@pnpm/win-arm64/**/*',
    '!node_modules/@pnpm/linux*/**/*',
    '!node_modules/@pnpm/linuxstatic*/**/*',
    '!node_modules/@pnpm/macos*/**/*',
  ],
  // @pnpm/exe bundles a native SEA binary that must live OUTSIDE the asar
  // (asar files cannot be spawned as executables). electron-builder copies
  // matched paths to app.asar.unpacked/ keeping the same relative tree.
  // NOTE: keep these patterns EXACT (no linux*/macos*/win-* wildcards) so they
  // don't re-include platform packages excluded by `files` above.
  asarUnpack: [
    'node_modules/@pnpm/exe/**/*',
    'node_modules/@pnpm/win-x64/**/*',
  ],
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
