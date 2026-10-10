// `repoagents status`: what each harness loads in this repository and from where — the repository, the user's home,
// a machine-local entry, another vendor's config — as one MCP matrix and one skills matrix.
import { Effect } from 'effect'
import { liveReports } from './inventory/live.ts'
import { leftovers, resolve, warnings, withLive } from './inventory/merge.ts'
import { HARNESS_NAMES, type HarnessName, type Item, type Kind } from './inventory/model.ts'
import { declared, homes } from './inventory/probes.ts'

export const inventory = (root: string, options: { readonly live: boolean }) =>
  Effect.gen(function* () {
    const h = yield* homes
    const d = yield* declared(root, h)
    const resolved = resolve(d.entries, d.claudeAllow)
    const items = options.live ? withLive(resolved, (yield* liveReports(root, h.home)).reports) : resolved
    return { items, warnings: warnings(items), claudeAllowlist: d.claudeAllow !== undefined }
  })

const SHORT: Record<HarnessName, string> = {
  'Claude Code': 'Claude',
  Codex: 'Codex',
  Grok: 'Grok',
  'Cursor agent': 'Cursor',
}

/** Nothing applies: say why (the first entry is the one that would have won). */
const inactiveCell = (mine: readonly Item[]): string => {
  if (mine.some((i) => i.state === 'blocked')) return 'blocked'
  return mine[0]?.state === 'disabled' ? 'off' : '·'
}

const cell = (items: readonly Item[], harness: HarnessName, name: string): string => {
  const mine = items.filter((i) => i.harness === harness && i.name === name).toSorted((a, b) => a.rank - b.rank)
  if (mine.length === 0) return '·'
  const active = mine.filter((i) => i.state === 'active')
  if (active.length === 0) return inactiveCell(mine)
  const label = [...new Set(active.map((i) => i.source))].join('+')
  const repoLost = mine.some((i) => i.source === 'repo') && active.every((i) => i.source !== 'repo')
  return repoLost ? `${label}!` : label
}

const table = (rows: ReadonlyArray<readonly string[]>): string[] => {
  const widths = (rows[0] ?? []).map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)))
  return rows.map((r) =>
    r
      .map((v, c) => v.padEnd(widths[c] ?? 0))
      .join('  ')
      .trimEnd(),
  )
}

const names = (items: readonly Item[], kind: Kind): string[] => {
  const ofKind = items.filter((i) => i.kind === kind)
  const repo = new Set(ofKind.filter((i) => i.source === 'repo').map((i) => i.name))
  const all = [...new Set(ofKind.map((i) => i.name))]
  return [...all.filter((n) => repo.has(n)).toSorted(), ...all.filter((n) => !repo.has(n)).toSorted()]
}

const matrix = (items: readonly Item[], kind: Kind, title: string): string[] => {
  const rows = names(items, kind).map((n) => [n, ...HARNESS_NAMES.map((h) => cell(items, h, n))])
  if (rows.length === 0) return [`${title}: none`]
  if (kind !== 'skill') return table([[title, ...HARNESS_NAMES.map((h) => SHORT[h])], ...rows])
  // Skills every harness takes from the repository collapse into one line.
  const plain = rows.filter((r) => r.slice(1).every((c) => c === 'repo'))
  const bundled = rows.filter((r) => r.slice(1).every((c) => c === 'bundled' || c === '·'))
  const rest = rows.filter((r) => !plain.includes(r) && !bundled.includes(r))
  return [
    ...(plain.length > 0 ? [`${title}: ${plain.length} from the repository in every harness`] : []),
    ...(bundled.length > 0 ? [`${title}: ${bundled.length} bundled with a harness`] : []),
    ...(rest.length > 0
      ? table([[plain.length > 0 ? 'other skills' : title, ...HARNESS_NAMES.map((h) => SHORT[h])], ...rest])
      : []),
  ]
}

export const renderStatus = (result: { items: readonly Item[]; claudeAllowlist: boolean }): string[] => {
  const active = result.items.filter((i) => i.kind === 'plugin' && i.state === 'active')
  const plugins = active.filter((p) => p.source !== 'bundled')
  const bundled = active.length - plugins.length
  const machine = leftovers(result.items, new Set())
  const live = result.items.filter((i) => i.live !== undefined && i.kind === 'mcp')
  return [
    ...matrix(result.items, 'mcp', 'MCP'),
    '',
    ...matrix(result.items, 'skill', 'skills'),
    '',
    `plugins: ${[...plugins.map((p) => `${p.name} (${SHORT[p.harness]}, ${p.source})`), ...(bundled > 0 ? [`${bundled} bundled`] : [])].join(', ') || 'none'}`,
    `Claude allowedMcpServers: ${result.claudeAllowlist ? 'on' : 'off (user and local servers load too)'}`,
    '',
    'repo = this repository · user = home directory · local = ~/.claude.json entry for this path · compat = another',
    "vendor's config the harness imports · bundled = ships with the harness · ! = repository entry overridden",
    ...(machine.length > 0
      ? [
          '',
          'machine-level:',
          ...machine.map((m) => `  ${m.kind} ${m.name}  ${m.path}  (${m.harnesses.map((h) => SHORT[h]).join(', ')})`),
        ]
      : []),
    ...(live.length > 0
      ? [
          '',
          'reported by the harness (--live):',
          ...live.map((i) => `  ${SHORT[i.harness]} ${i.kind} ${i.name}: ${i.live ?? ''}`),
        ]
      : []),
  ]
}
