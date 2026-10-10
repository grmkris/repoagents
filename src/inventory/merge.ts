// Pure: decide per harness and name which entry applies (rank, disables, Claude's allowlist), fold in what the
// harnesses reported (--live), and explain what does not look right.
import type { Entry, HarnessName, Item } from './model.ts'
import { isMachineLevel } from './model.ts'
import type { AllowEntry } from './probes.ts'

const glob = (pattern: string, value: string): boolean =>
  new RegExp(`^${pattern.replaceAll(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*')}$`, 'u').test(value)

/** Claude's rule: a remote server must match a serverUrl entry when any exist (a stdio one a serverCommand entry),
 *  otherwise a serverName entry. */
const allowed = (e: Entry, allow: readonly AllowEntry[]): boolean => {
  const byName = allow.some((a) => a.serverName === e.name)
  if (e.url !== undefined) {
    const urls = allow.flatMap((a) => (a.serverUrl === undefined ? [] : [a.serverUrl]))
    return urls.length > 0 ? urls.some((u) => glob(u, e.url ?? '')) : byName
  }
  const commands = allow.flatMap((a) => (a.serverCommand === undefined ? [] : [a.serverCommand]))
  return commands.length > 0
    ? commands.some((c) => c.length === e.command?.length && c.every((part, i) => part === e.command?.[i]))
    : byName
}

const resolveGroup = (group: readonly Entry[], allow: readonly AllowEntry[] | undefined): Item[] => {
  const switchedOff = group.some((e) => e.disablesOnly === true)
  const entries = group.filter((e) => e.disablesOnly !== true).toSorted((a, b) => a.rank - b.rank)
  const blocked = (e: Entry) =>
    e.kind === 'mcp' && e.harness === 'Claude Code' && allow !== undefined && !allowed(e, allow)
  const disabled = (e: Entry) => e.disabled === true || (switchedOff && e.source !== 'repo')
  // Skills of the same name are all listed (precedence between skill dirs is not verified); MCP servers and plugins
  // resolve to one winner.
  const winner = entries.find((e) => !blocked(e) && !disabled(e))
  return entries.map((e): Item => {
    if (blocked(e)) return { ...e, state: 'blocked' }
    if (disabled(e)) return { ...e, state: 'disabled' }
    if (e.kind === 'skill' || e === winner) return { ...e, state: 'active' }
    return { ...e, state: 'shadowed', shadowedBy: winner?.path }
  })
}

export const resolve = (entries: readonly Entry[], allow: readonly AllowEntry[] | undefined): Item[] => {
  const groups = new Map<string, Entry[]>()
  for (const e of entries) {
    const key = `${e.harness}\0${e.kind}\0${e.name}`
    groups.set(key, [...(groups.get(key) ?? []), e])
  }
  return [...groups.values()].flatMap((g) => resolveGroup(g, allow))
}

/** What a harness reported about itself: one MCP server or skill, and the file it says it came from. */
export interface LiveReport {
  readonly harness: Item['harness']
  readonly kind: Item['kind']
  readonly name: string
  readonly path?: string | undefined
  readonly note: string
}

export const withLive = (items: readonly Item[], reports: readonly LiveReport[]): Item[] => {
  const out = items.map((i) => ({ ...i }))
  for (const r of reports) {
    const same = out.filter((i) => i.harness === r.harness && i.kind === r.kind && i.name === r.name)
    const match = same.find((i) => i.state === 'active') ?? same[0]
    if (match) Object.assign(match, { live: r.note, liveFrom: r.path })
    else
      out.push({
        harness: r.harness,
        kind: r.kind,
        name: r.name,
        source: 'live',
        path: r.path ?? '?',
        rank: 99,
        state: 'active',
        live: r.note,
      })
  }
  return out
}

/** Grok 1.0.46 reports servers from the project .cursor/mcp.json as coming from ~/.cursor/mcp.json. */
const ALIASES: Readonly<Record<string, string>> = { '.cursor/mcp.json': '~/.cursor/mcp.json' }
const samePlace = (declared: string, reported: string): boolean =>
  declared.startsWith(reported) || ALIASES[declared] === reported

export interface Warning {
  readonly level: 'warn' | 'info'
  readonly message: string
}

export const warnings = (items: readonly Item[]): Warning[] => {
  const out: Warning[] = []
  for (const i of items) {
    if (i.source === 'repo' && i.state === 'shadowed' && !isRepoPath(i.shadowedBy))
      out.push({
        level: 'warn',
        message: `${i.harness}: repo ${i.kind} ${i.name} is shadowed by ${i.shadowedBy ?? '?'}`,
      })
    if (i.source === 'repo' && i.state === 'blocked')
      out.push({ level: 'warn', message: `${i.harness}: repo ${i.kind} ${i.name} is not in allowedMcpServers` })
    if (i.liveFrom !== undefined && i.source !== 'live' && i.kind === 'mcp' && !samePlace(i.path, i.liveFrom))
      out.push({ level: 'warn', message: `${i.harness} loads ${i.kind} ${i.name} from ${i.liveFrom}, not ${i.path}` })
    if (i.source === 'live')
      out.push({ level: 'info', message: `${i.harness} loads ${i.kind} ${i.name} from ${i.path} (not predicted)` })
  }
  return out
}

const isRepoPath = (p: string | undefined): boolean => p !== undefined && !p.startsWith('~') && !p.startsWith('/')

interface Leftover {
  readonly kind: Item['kind']
  readonly name: string
  readonly path: string
  readonly harnesses: HarnessName[]
}

/** Machine-level entries a harness actually loads, one per file and name (Grok re-reads Claude's files). */
export const leftovers = (items: readonly Item[], allow: ReadonlySet<string>): Leftover[] => {
  const byKey = new Map<string, Leftover>()
  for (const i of items) {
    if (!isMachineLevel(i) || i.state !== 'active' || allow.has(i.name)) continue
    const key = `${i.kind}\0${i.name}\0${i.path}`
    const row = byKey.get(key) ?? { kind: i.kind, name: i.name, path: i.path, harnesses: [] }
    row.harnesses.push(i.harness)
    byKey.set(key, row)
  }
  return [...byKey.values()]
}
