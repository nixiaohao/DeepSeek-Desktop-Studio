/**
 * channels.ts — Upstream release-channel selection.
 *
 * `deepseek-harness` publishes several prerelease channels at once, and they
 * are NOT interchangeable. Upstream's own release docs define the ordering
 * (same version line):
 *
 *     alpha  <  canary  <  rc  <  stable
 *
 * with every prerelease below the corresponding stable release. Crucially the
 * ordering only holds *within* one version: `0.1.2-alpha.2` is a *higher*
 * version than `0.1.1-rc.2`, yet it is the far less stable artifact — it is
 * simply newer work in progress on the next line.
 *
 * Following `master` HEAD therefore feeds users whatever channel happened to
 * be tagged last. As of 2026-08 the plugin ecosystem (dshmarket, …) declares
 * peer ranges like `^0.1.0-rc.7 || ^0.1.1-rc.2`, i.e. it supports the `next`
 * (rc) line only. An alpha build can drop an export those plugins import —
 * the workspace build still exits 0, and the app dies later at plugin load
 * with a cryptic "does not provide an export named 'X'".
 *
 * So the shell pins to a channel and resolves the highest version *published
 * in that channel*, rather than tracking a branch tip.
 *
 * Pure logic: no Electron, no fs, no git. Unit-testable in isolation.
 */

/** The channels upstream publishes, from most to least stable. */
export type ChannelId = 'stable' | 'next' | 'canary' | 'alpha'

export interface ChannelDef {
  id: ChannelId
  /** Menu label. */
  label: string
  /** One-line description shown in the menu / confirmation dialog. */
  summary: string
  /**
   * True for channels that may break third-party plugins.
   * Risky channels get a confirmation dialog, a persistent startup notice and
   * an automatic downgrade when they fail to build.
   */
  risky: boolean
}

/** Ordered most-stable-first; the menu is rendered in this order. */
export const CHANNELS: readonly ChannelDef[] = [
  {
    id: 'stable',
    label: 'stable（稳定版）',
    summary: '正式发布版本。上游目前尚未发布稳定版，会自动回退到 next。',
    risky: false,
  },
  {
    id: 'next',
    label: 'next（推荐）',
    summary: 'rc 预发布通道，插件生态普遍支持，默认选项。',
    risky: false,
  },
  {
    id: 'canary',
    label: 'canary（尝鲜）',
    summary: '比 rc 更新的开发版本，可能有破坏性变更。',
    risky: true,
  },
  {
    id: 'alpha',
    label: 'alpha（尝鲜）',
    summary: '最新开发版本，可能删除插件依赖的接口，存在启动失败风险。',
    risky: true,
  },
]

export const DEFAULT_CHANNEL: ChannelId = 'next'

/** Environment variable that overrides the persisted channel. */
export const CHANNEL_ENV_VAR = 'DSH_CHANNEL'

const CHANNEL_IDS: readonly ChannelId[] = CHANNELS.map((c) => c.id)

export function isChannelId(value: unknown): value is ChannelId {
  return typeof value === 'string' && (CHANNEL_IDS as readonly string[]).includes(value)
}

/** Coerce an arbitrary stored value to a valid channel, falling back to default. */
export function normalizeChannel(value: unknown): ChannelId {
  if (!isChannelId(value)) return DEFAULT_CHANNEL
  return value
}

export function channelDef(id: ChannelId): ChannelDef {
  return CHANNELS.find((c) => c.id === id) ?? CHANNELS[1]
}

/**
 * Ways to get back to the recommended channel, rendered as user-facing text.
 *
 * Written to disk alongside the preferences file precisely because the app
 * may not start: a warning that only exists inside a working UI is worthless
 * to someone staring at a launch failure. Every route here works with the
 * application closed.
 */
export function recoveryGuide(id: ChannelId, paths: { prefsFile: string; logDir: string }): string {
  const def = channelDef(id)
  return `# DeepSeek Studio — 更新通道与恢复指引

本文件由 DeepSeek Studio 自动生成，可安全删除，下次切换通道时会重新生成。

当前更新通道：**${def.label}**

## 一、这个通道可能带来什么问题

上游 deepseek-harness 的尝鲜通道是开发中的版本，同一个版本周期内可能：

- 删除或重命名第三方插件依赖的接口
  （已发生过：0.1.2-alpha.2 移除了 settingsNamespace 与 installSettingsSection，
  导致 dshmarket、dsh-config-manager 等插件在加载阶段直接失败）
- 引入插件生态尚未适配的破坏性变更
  （多数插件的 peerDependencies 只声明支持 rc 通道，不覆盖 alpha）
- 构建脚本仍然返回成功，但启动阶段加载插件时崩溃

典型症状：启动时报 "does not provide an export named 'xxx'"，
或每次启动都重复一次失败的构建。

## 二、自动保护（通常无需你做任何事）

本程序在检测到尝鲜通道的版本无法构建、或构建产物缺少插件所需导出时，
会自动切回 next（rc）通道并重新构建。你一般只需多等一次构建即可。

## 三、手动切回 next 通道（三种方式，任选其一）

### 方式 1：改配置文件 —— 应用打不开时最可靠

编辑文件：
    ${paths.prefsFile}

把 "channel" 的值改成 "next"：
    "channel": "next"

保存后重新启动 DeepSeek Studio。

### 方式 2：环境变量 —— 优先级最高，会覆盖配置文件

在启动应用前设置（设置后需从同一个终端窗口启动）：

    Windows (CMD)         setx DSH_CHANNEL next
    Windows (PowerShell)  $env:DSH_CHANNEL="next"
    macOS / Linux         export DSH_CHANNEL=next

该环境变量存在期间，配置文件里的 channel 不生效。
想恢复由配置文件控制时，删除这个环境变量即可。

### 方式 3：应用内菜单 —— 应用能正常启动时

    菜单 → 更新 → 更新通道 → 选择「next（推荐）」

选择后重启应用生效。

## 四、排查用日志

    ${paths.logDir}

遇到无法自行解决的问题时，附上 launcher.log / wizard.log 反馈会更快定位。
`
}

/**
 * Channels to try when the selected one has no published version.
 *
 * Deliberately hand-written rather than derived from ordering: `next` must
 * NOT fall back to `stable`. When no rc tag exists at all there is nothing
 * safe to pin to, and the caller keeps its previous behaviour instead of
 * silently jumping to an older (or unrecognised) tag.
 */
const FALLBACKS: Record<ChannelId, readonly ChannelId[]> = {
  stable: ['next'],
  next: [],
  canary: ['next'],
  alpha: ['canary', 'next'],
}

export function channelFallbacks(id: ChannelId): readonly ChannelId[] {
  return FALLBACKS[id]
}

// ── Minimal semver (prerelease aware) ──

/**
 * `v0.1.1-rc.2` → prerelease segments are kept verbatim; numeric segments are
 * numbers so `rc.10` sorts after `rc.2`.
 */
export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  pre: ReadonlyArray<string | number>
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(input: string): ParsedVersion | null {
  const m = VERSION_RE.exec(input.trim())
  if (!m) return null
  const raw = m[4]
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: raw
      ? raw.split('.').map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg))
      : [],
  }
}

function comparePre(a: ReadonlyArray<string | number>, b: ReadonlyArray<string | number>): number {
  // A version without prerelease segments is newer than one with them.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1 // shorter set of identifiers is older
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1
      continue
    }
    // Numeric identifiers always compare lower than alphanumeric ones.
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Standard semver comparison (prereleases included). */
export function compareVersion(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1
  return comparePre(pa.pre, pb.pre)
}

/** `refs/tags/dsh-v0.1.1-rc.2^{}` → `dsh-v0.1.1-rc.2` */
function stripTagRef(ref: string): string {
  return ref
    .trim()
    .replace(/^refs\/tags\//, '')
    .replace(/\^\{\}$/, '')
}

/**
 * Extract a bare version from a git tag.
 * `refs/tags/dsh-v0.1.1-rc.2^{}` → `0.1.1-rc.2`; returns null for non-version tags.
 */
export function tagToVersion(tag: string): string | null {
  const name = stripTagRef(tag)
  const m = /^(?:dsh-)?v?(\d+\.\d+\.\d+.*)$/.exec(name)
  if (!m) return null
  const v = m[1]
  return parseVersion(v) ? v : null
}

type PrereleaseKind = 'stable' | 'rc' | 'canary' | 'alpha' | 'other'

/**
 * Classify a version by how close it is to a release.
 * `beta` is treated as an rc-grade prerelease; anything unrecognised is
 * `other` and only the alpha channel picks it up — a stray tag shape must
 * never silently become the recommended channel.
 */
function prereleaseKind(version: string): PrereleaseKind {
  const p = parseVersion(version)
  if (!p) return 'other'
  if (p.pre.length === 0) return 'stable'
  const first = p.pre[0]
  if (typeof first !== 'string') return 'other'
  switch (first.toLowerCase()) {
    case 'alpha':
      return 'alpha'
    case 'canary':
      return 'canary'
    case 'rc':
    case 'beta':
      return 'rc'
    default:
      return 'other'
  }
}

const ACCEPT: Record<ChannelId, (version: string) => boolean> = {
  stable: (v) => prereleaseKind(v) === 'stable',
  next: (v) => {
    const k = prereleaseKind(v)
    return k === 'stable' || k === 'rc'
  },
  canary: (v) => {
    const k = prereleaseKind(v)
    return k === 'stable' || k === 'rc' || k === 'canary'
  },
  // The wild-west channel: every published tag qualifies.
  alpha: () => true,
}

/**
 * Pick the newest version published in a channel.
 *
 * `stable` degrades to `next` when upstream has shipped no final release yet
 * (which is the case today) — otherwise the channel would resolve to nothing
 * and the app would silently stop updating.
 *
 * Returns null when the channel has no published version at all; the caller
 * then falls back to its previous behaviour rather than failing startup.
 */
export function selectChannelVersion(
  channel: ChannelId,
  versions: readonly string[]
): string | null {
  const usable = versions.filter((v) => parseVersion(v) !== null)
  if (usable.length === 0) return null

  const accept = ACCEPT[channel]
  let pool = usable.filter(accept)
  if (pool.length === 0 && channel === 'stable') pool = usable.filter(ACCEPT.next)
  if (pool.length === 0) return null

  return pool.slice().sort(compareVersion).pop() ?? null
}

export interface ChannelSelection {
  /** Channel the version was resolved from (may be a fallback of `requested`). */
  channel: ChannelId
  /** Channel the caller asked for. */
  requested: ChannelId
  version: string
  /** The exact remote tag to fetch — never reconstructed from a naming guess. */
  tag: string
  /**
   * True when the version is older-tier than the channel asks for — e.g. a
   * `stable` request resolving to an rc because upstream has shipped no final
   * release yet. Callers must surface this: silently handing a user a
   * prerelease labelled "stable" is exactly the kind of surprise this module
   * exists to prevent.
   */
  degraded: boolean
}

/**
 * Resolve a channel to the concrete tag to check out.
 *
 * Works on the real tag list instead of rebuilding a tag name from the
 * version, so a change in upstream tag naming cannot produce a ref that does
 * not exist. `^{}` dereference lines from `git ls-remote --tags` are ignored;
 * when several tags carry the same version the first one wins.
 *
 * Returns null when nothing in the channel (or its fallbacks) is published.
 */
export function selectChannelTag(
  requested: ChannelId,
  tags: readonly string[]
): ChannelSelection | null {
  const candidates: Array<{ version: string; tag: string }> = []
  const seen = new Set<string>()
  for (const tag of tags) {
    const version = tagToVersion(tag)
    if (!version || seen.has(version)) continue
    seen.add(version)
    // Short name, so callers can build refspecs (`refs/tags/<name>:refs/tags/<name>`)
    // instead of guessing at a naming convention.
    candidates.push({ version, tag: stripTagRef(tag) })
  }
  if (candidates.length === 0) return null

  const versions = candidates.map((c) => c.version)
  for (const channel of [requested, ...FALLBACKS[requested]]) {
    const version = selectChannelVersion(channel, versions)
    if (!version) continue
    const hit = candidates.find((c) => c.version === version)
    if (!hit) continue
    // A channel whose accept-list simply has no member published falls through
    // to a fallback channel; a channel that matched something of a lower tier
    // (stable → rc) reports `degraded` instead of pretending it is satisfied.
    const degraded = !ACCEPT[requested](version)
    return { channel, requested, version, tag: hit.tag, degraded }
  }
  return null
}
