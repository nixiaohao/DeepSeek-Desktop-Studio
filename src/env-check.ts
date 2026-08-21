/**
 * env-check.ts — Environment check shown in the wizard and used by the
 * launcher before update/ready steps.
 *
 * Every check returns a flat entry the UI can render as a pass/fail list.
 * pnpm is special: even when no system pnpm exists, the shell bundles
 * @pnpm/exe, so pnpm is always usable.
 */
import {
  detectNode,
  detectGit,
  detectPnpm,
  MIN_NODE,
  gte,
} from './env-detector.js'

export interface EnvEntry {
  id: 'node' | 'git' | 'pnpm'
  label: string
  found: boolean
  version: string
  ok: boolean
  detail: string
}

export type EnvReport = EnvEntry[]

/** Full environment check (node / git / pnpm). */
export function checkEnvironment(): EnvReport {
  const node = detectNode()
  const git = detectGit()
  const pnpm = detectPnpm()

  const nodeOk = node.found && !!node.semver && gte(node.semver, MIN_NODE)

  return [
    {
      id: 'node',
      label: 'Node.js',
      found: node.found,
      version: node.version || '未检测到',
      ok: nodeOk,
      detail: node.found
        ? nodeOk
          ? `满足要求（需要 ≥${MIN_NODE.join('.')}）`
          : `版本过低，需要 ≥${MIN_NODE.join('.')}（当前 ${node.version}）`
        : `未检测到，请安装 Node.js ≥${MIN_NODE.join('.')}`,
    },
    {
      id: 'git',
      label: 'Git',
      found: git.found,
      version: git.version || '未检测到',
      ok: git.found,
      detail: git.found
        ? '可用（GitHub 拉取与自动更新依赖它）'
        : '未检测到：GitHub 拉取与自动更新不可用（可用 ZIP 方式，或安装 Git for Windows）',
    },
    {
      id: 'pnpm',
      label: 'pnpm',
      found: pnpm.found,
      version: pnpm.version || '未检测到（将使用内置 pnpm）',
      ok: true,
      detail: pnpm.found
        ? `系统 pnpm 可用（${pnpm.version}）`
        : '未检测到系统 pnpm，将使用应用内置的 pnpm（不影响使用）',
    },
  ]
}

/** Quick check: is git usable right now? (update path prerequisite) */
export function gitAvailable(): boolean {
  return detectGit().found
}

/** Quick check: is a usable node present? */
export function nodeAvailable(): boolean {
  const n = detectNode()
  return n.found && !!n.semver && gte(n.semver, MIN_NODE)
}
