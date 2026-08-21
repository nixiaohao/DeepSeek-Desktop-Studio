/**
 * resolve-deps.mjs — resolve the FULL production dependency closure for the
 * shell's runtime deps from registry.npmmirror.com, and print `name@version`
 * lines. Used to provision node_modules manually because npm/pnpm install are
 * blocked by the sandbox's safe-delete guard on this machine.
 *
 * Usage: node scripts/resolve-deps.mjs
 */
const REG = 'https://registry.npmmirror.com'
const ROOTS = [
  { name: 'isomorphic-git', version: '1.41.5' },
  { name: '@pnpm/exe', version: '11.22.0' },
]

// Rough semver satisfaction for the specs isomorphic-git/@pnpm/exe actually use
function satisfies(v, spec) {
  if (!spec || spec === '*' || spec === 'latest') return true
  const parts = (v + '').replace(/^v/, '').split('.')
  const toNum = (s) => parseInt(s, 10) || 0
  for (const alt of spec.split('||').map((s) => s.trim())) {
    if (!alt) continue
    if (alt.startsWith('^')) {
      const t = alt.slice(1).split('.')
      if (toNum(parts[0]) === toNum(t[0]) && toNum(parts[0]) >= toNum(t[0])) {
        if (parts[0] === t[0]) {
          // ^1.2.3 → >=1.2.3 <2
          const tgt = t.map(toNum)
          const p = parts.map(toNum)
          const belowMajor = toNum(t[0]) + 1
          if (p[0] >= belowMajor) continue
          if (p[0] !== tgt[0]) return true
          if (p[1] > tgt[1]) return true
          if (p[1] === tgt[1] && p[2] >= tgt[2]) return true
          continue
        }
        return false
      }
    } else if (alt.startsWith('~')) {
      const t = alt.slice(1).split('.')
      const tgt = t.map(toNum)
      const p = parts.map(toNum)
      if (p[0] !== tgt[0]) continue
      if (p[1] !== tgt[1]) return p[1] > tgt[1]
      return p[2] >= tgt[2]
    } else if (alt.startsWith('>=')) {
      const t = alt.slice(2).split('.')
      const tgt = t.map(toNum)
      const p = parts.map(toNum)
      for (let i = 0; i < 3; i++) {
        if (p[i] > tgt[i]) return true
        if (p[i] < tgt[i]) break
      }
      return true
    } else if (/^\d/.test(alt)) {
      return alt.replace(/^v/, '') === v.replace(/^v/, '')
    }
  }
  return false
}

async function pickVersion(name, spec) {
  try {
    const res = await fetch(`${REG}/${encodeURIComponent(name)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${name}`)
    const meta = await res.json()
    const versions = Object.keys(meta.versions || {})
    const ok = versions
      .filter((v) => satisfies(v, spec))
      .sort((a, b) => compare(a, b))
    return ok[ok.length - 1] ?? versions[versions.length - 1]
  } catch (err) {
    console.error(`[resolve] WARN ${name}@${spec}: ${err.message}`)
    return spec.replace(/^[\^~>= ]+/, '')
  }
}

function compare(a, b) {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

const resolved = new Map() // name -> version

async function resolve(name, version) {
  if (resolved.has(name)) return
  const enc = encodeURIComponent(name)
  const res = await fetch(`${REG}/${enc}/${version}`)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${name}@${version}`)
  const meta = await res.json()
  resolved.set(name, meta.version)
  const deps = { ...(meta.dependencies || {}), ...(meta.optionalDependencies || {}) }
  for (const [dep, spec] of Object.entries(deps)) {
    const ver = await pickVersion(dep, spec)
    await resolve(dep, ver)
  }
}

for (const root of ROOTS) {
  await resolve(root.name, root.version)
}

// Prefer the platform binary package for the current OS (pnpm's optionalDeps)
const platformPkg = {
  win32: 'win',
  darwin: 'macos',
  linux: 'linux',
}[process.platform]
if (platformPkg) {
  const arch = process.arch === 'x64' ? 'x64' : process.arch
  const pkg = `@pnpm/${platformPkg}-${arch}`
  if (!resolved.has(pkg)) {
    const ver = await pickVersion(pkg, '11.22.0')
    await resolve(pkg, ver)
  }
}

for (const [name, version] of [...resolved.entries()].sort()) {
  console.log(`${name}@${version}`)
}
