// What a harness may load in a repository, from any scope. Probes produce raw entries; merge.ts decides which one
// wins per harness and name, and why the others do not apply.

export type HarnessName = 'Claude Code' | 'Codex' | 'Grok' | 'Cursor agent'
export const HARNESS_NAMES: readonly HarnessName[] = ['Claude Code', 'Codex', 'Grok', 'Cursor agent']

export type Kind = 'mcp' | 'skill' | 'plugin'

/**
 * Where an entry comes from: the repository, the user's home (`user`), a machine-local entry for this project
 * (`local`, Claude's `~/.claude.json` projects map), another vendor's user config a harness imports (`compat`),
 * something the harness ships itself (`bundled`), or only seen by asking the harness (`live`).
 */
export type Source = 'repo' | 'user' | 'local' | 'compat' | 'bundled' | 'live'

/**
 * - active: the harness uses it
 * - shadowed: another entry with the same name wins
 * - blocked: the repository's Claude `allowedMcpServers` does not allow it
 * - disabled: switched off in config
 */
type State = 'active' | 'shadowed' | 'blocked' | 'disabled'

export interface Entry {
  readonly harness: HarnessName
  readonly kind: Kind
  readonly name: string
  readonly source: Source
  /** File or directory it was read from (`~/…` for the home directory). */
  readonly path: string
  /** Lower wins when two entries of one harness share a name (the harness's own precedence). */
  readonly rank: number
  readonly url?: string | undefined
  readonly command?: readonly string[] | undefined
  /** Declared `enabled = false` (or on a disabled list). */
  readonly disabled?: boolean | undefined
  /** A project entry that only switches a same-named server off (Codex `[mcp_servers.x] enabled = false`). */
  readonly disablesOnly?: boolean | undefined
}

export interface Item extends Entry {
  readonly state: State
  /** Path of the entry that wins, when shadowed. */
  readonly shadowedBy?: string | undefined
  /** What the harness itself reported (--live). */
  readonly live?: string | undefined
  /** The file the harness said it loaded this from (--live), when it reports one. */
  readonly liveFrom?: string | undefined
}

/** Repository-level entries and harness-bundled ones are expected; everything else is machine-level. */
export const isMachineLevel = (i: Item): boolean => i.source !== 'repo' && i.source !== 'bundled'
