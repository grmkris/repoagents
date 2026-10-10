// Every place a harness takes MCP servers, skills and plugins from, read from files: the repository and the user's
// home. Only names, URLs and commands are kept, never header or env values. Precedence (rank) per harness was
// verified 2026-10-10 with temp HOMEs (see harnesses.ts); lower rank wins.
import { Config, Effect, Option, Path, Schema } from 'effect'
import { listDir, readTextOption } from '../fsx.ts'
import { CLAUDE_SKILLS_DIR, SKILLS_DIR, skillNames } from '../repo.ts'
import { McpFile } from '../schema.ts'
import { childTables, parseToml, table, type TomlTables } from '../toml.ts'
import type { Entry, HarnessName, Kind, Source } from './model.ts'

export const AllowEntry = Schema.Struct({
  serverName: Schema.optional(Schema.String),
  serverUrl: Schema.optional(Schema.String),
  serverCommand: Schema.optional(Schema.Array(Schema.String)),
})
export type AllowEntry = typeof AllowEntry.Type

const LooseServer = Schema.Struct({
  url: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
})
const Servers = Schema.Record(Schema.String, LooseServer)

const ClaudeJson = Schema.Struct({
  mcpServers: Schema.optional(Servers),
  projects: Schema.optional(Schema.Record(Schema.String, Schema.Struct({ mcpServers: Schema.optional(Servers) }))),
})

const ClaudeSettings = Schema.Struct({
  enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  allowedMcpServers: Schema.optional(Schema.Array(AllowEntry)),
})

/** Codex app servers and plugin marketplaces that ship with the harness. */
const CODEX_BUNDLED_MCP: ReadonlySet<string> = new Set(['node_repl', 'computer-use', 'cua_repl'])
const CODEX_BUNDLED_MARKETS = /@openai-/u
/** Skill folders the harnesses manage themselves (claude.ai sync, Codex system skills). */
const BUNDLED_SKILLS: ReadonlySet<string> = new Set(['synced', '.system'])

export interface Homes {
  readonly home: string
  readonly codexHome: string
}

export const homes = Effect.gen(function* () {
  const path = yield* Path.Path
  const home = yield* Config.String('HOME').pipe(Config.withDefault(''))
  const codexHome = yield* Config.String('CODEX_HOME').pipe(Config.withDefault(path.join(home, '.codex')))
  return { home, codexHome } satisfies Homes
}).pipe(Effect.orElseSucceed((): Homes => ({ home: '', codexHome: '' })))

const decodeJson = <S extends Schema.Top>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema))
  return (raw: Option.Option<string>) =>
    Option.isNone(raw) ? Effect.succeed(Option.none<S['Type']>()) : decode(raw.value).pipe(Effect.option)
}
const readClaudeJson = decodeJson(ClaudeJson)
const readSettings = decodeJson(ClaudeSettings)
const readMcp = decodeJson(McpFile)

interface Server {
  readonly url?: string | undefined
  readonly command?: string | undefined
  readonly args?: readonly string[] | undefined
  readonly enabled?: unknown
}

const commandOf = (s: Server): readonly string[] | undefined =>
  s.command === undefined ? undefined : [s.command, ...(s.args ?? [])]

/** Builds entries for one file; `at` is the harness/rank/source triples that read it. */
const serverEntries = (
  servers: Readonly<Record<string, Server>>,
  path: string,
  at: ReadonlyArray<readonly [HarnessName, number, Source]>,
): Entry[] =>
  at.flatMap(([harness, rank, source]) =>
    Object.entries(servers).map(([name, s]): Entry => {
      const disabled = s.enabled === false
      return {
        harness,
        kind: 'mcp',
        name,
        source: source === 'user' && harness === 'Codex' && CODEX_BUNDLED_MCP.has(name) ? 'bundled' : source,
        path,
        rank,
        url: s.url,
        command: commandOf(s),
        disabled,
        disablesOnly: disabled && s.url === undefined && s.command === undefined,
      }
    }),
  )

const tomlServers = (tables: TomlTables): Record<string, Server> =>
  Object.fromEntries(
    [...childTables(tables, 'mcp_servers')].map(([name, t]) => [
      name,
      {
        url: typeof t['url'] === 'string' ? t['url'] : undefined,
        command: typeof t['command'] === 'string' ? t['command'] : undefined,
        args: Array.isArray(t['args']) ? t['args'].map(String) : undefined,
        enabled: t['enabled'],
      },
    ]),
  )

const skillEntries = (
  names: readonly string[],
  path: string,
  at: ReadonlyArray<readonly [HarnessName, number, Source]>,
): Entry[] =>
  at.flatMap(([harness, rank, source]) =>
    names
      .filter((n) => !n.startsWith('.') || BUNDLED_SKILLS.has(n))
      .map((name): Entry => ({
        harness,
        kind: 'skill' satisfies Kind,
        name,
        source: BUNDLED_SKILLS.has(name) ? 'bundled' : source,
        path: `${path}/${name}`,
        rank,
      })),
  )

interface Declared {
  readonly entries: Entry[]
  /** Claude `allowedMcpServers` from the repository and the user's settings (they merge); none when neither has it. */
  readonly claudeAllow: readonly AllowEntry[] | undefined
}

type At = ReadonlyArray<readonly [HarnessName, number, Source]>
const when = (on: boolean, at: At): At => (on ? at : [])

const read = (abs: string) => readTextOption(abs).pipe(Effect.orElseSucceed(() => Option.none<string>()))
const readToml = (abs: string) => read(abs).pipe(Effect.map((t) => parseToml(Option.getOrElse(t, () => ''))))
/** Servers of an MCP JSON file; none when it is missing or does not parse. */
const jsonServers = (abs: string) =>
  read(abs).pipe(
    Effect.flatMap(readMcp),
    Effect.map((o) => (Option.isSome(o) ? (o.value.mcpServers ?? {}) : {})),
  )

const repoMcp = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return [
      ...serverEntries(yield* jsonServers(path.join(root, '.mcp.json')), '.mcp.json', [
        ['Claude Code', 1, 'repo'],
        ['Grok', 4, 'repo'],
      ]),
      // Grok imports the project .cursor/mcp.json too, above .mcp.json (and reports it as ~/.cursor/mcp.json).
      ...serverEntries(yield* jsonServers(path.join(root, '.cursor/mcp.json')), '.cursor/mcp.json', [
        ['Cursor agent', 0, 'repo'],
        ['Grok', 3, 'repo'],
      ]),
      ...serverEntries(tomlServers(yield* readToml(path.join(root, '.codex/config.toml'))), '.codex/config.toml', [
        ['Codex', 0, 'repo'],
      ]),
      ...serverEntries(tomlServers(yield* readToml(path.join(root, '.grok/config.toml'))), '.grok/config.toml', [
        ['Grok', 0, 'repo'],
      ]),
    ]
  })

const userMcp = (root: string, h: Homes, display: (abs: string) => string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const grokFile = path.join(h.home, '.grok/config.toml')
    const grokUser = yield* readToml(grokFile)
    const compat = (vendor: string) => table(grokUser, 'compat', vendor)['mcps'] !== false
    const claudeFile = path.join(h.home, '.claude.json')
    const claude = Option.getOrElse(yield* readClaudeJson(yield* read(claudeFile)), () => ({
      mcpServers: undefined,
      projects: undefined,
    }))
    const codexFile = path.join(h.codexHome, 'config.toml')
    const cursorFile = path.join(h.home, '.cursor/mcp.json')
    const entries = [
      ...serverEntries(claude.mcpServers ?? {}, display(claudeFile), [
        ['Claude Code', 2, 'user'],
        ...when(compat('claude'), [['Grok', 2, 'compat']]),
      ]),
      ...serverEntries(claude.projects?.[root]?.mcpServers ?? {}, `${display(claudeFile)} (this project)`, [
        ['Claude Code', 0, 'local'],
        ...when(compat('claude'), [['Grok', 2, 'compat']]),
      ]),
      ...serverEntries(tomlServers(yield* readToml(codexFile)), display(codexFile), [['Codex', 1, 'user']]),
      ...serverEntries(tomlServers(grokUser), display(grokFile), [['Grok', 1, 'user']]),
      ...serverEntries(yield* jsonServers(cursorFile), display(cursorFile), [
        ['Cursor agent', 1, 'user'],
        ...when(compat('cursor'), [['Grok', 3, 'compat']]),
      ]),
    ]
    const grokOff = table(grokUser)['disabled_mcp_servers']
    const off = new Set(Array.isArray(grokOff) ? grokOff.map(String) : [])
    return entries.map((e) => (e.harness === 'Grok' && off.has(e.name) ? { ...e, disabled: true } : e))
  })

const mcpDeclared = (root: string, h: Homes, display: (abs: string) => string) =>
  Effect.gen(function* () {
    const repo = yield* repoMcp(root)
    if (h.home === '') return repo
    const user = yield* userMcp(root, h, display)
    // Grok's disabled list applies to every source, the repository's included.
    const grokOff = new Set(user.filter((e) => e.harness === 'Grok' && e.disabled === true).map((e) => e.name))
    return [...repo.map((e) => (e.harness === 'Grok' && grokOff.has(e.name) ? { ...e, disabled: true } : e)), ...user]
  })

const skillsDeclared = (root: string, h: Homes, display: (abs: string) => string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const agents = yield* skillNames(root)
    const links = yield* listDir(path.join(root, CLAUDE_SKILLS_DIR))
    const entries: Entry[] = [
      ...skillEntries(links, CLAUDE_SKILLS_DIR, [['Claude Code', 0, 'repo']]),
      ...skillEntries(agents, SKILLS_DIR, [
        ['Codex', 0, 'repo'],
        ['Grok', 0, 'repo'],
        ['Cursor agent', 0, 'repo'],
      ]),
      // Grok and Cursor also read .claude/skills; the links point at the same .agents/skills directories.
      ...skillEntries(
        links.filter((l) => !agents.includes(l)),
        CLAUDE_SKILLS_DIR,
        [
          ['Grok', 0, 'repo'],
          ['Cursor agent', 0, 'repo'],
        ],
      ),
    ]
    if (h.home === '') return entries
    const grokUser = yield* readToml(path.join(h.home, '.grok/config.toml'))
    const compat = (vendor: string) => table(grokUser, 'compat', vendor)['skills'] !== false
    const dirs: ReadonlyArray<readonly [string, ReadonlyArray<readonly [HarnessName, number, Source]>]> = [
      [
        path.join(h.home, '.claude/skills'),
        [['Claude Code', 1, 'user'], ...(compat('claude') ? ([['Grok', 2, 'compat']] as const) : [])],
      ],
      [path.join(h.codexHome, 'skills'), [['Codex', 1, 'user']]],
      [
        path.join(h.home, '.agents/skills'),
        [
          ['Codex', 1, 'user'],
          ['Grok', 1, 'user'],
        ],
      ],
      [path.join(h.home, '.grok/skills'), [['Grok', 1, 'user']]],
      [path.join(h.home, '.grok/bundled/skills'), [['Grok', 1, 'bundled']]],
      [
        path.join(h.home, '.cursor/skills'),
        [['Cursor agent', 1, 'user'], ...(compat('cursor') ? ([['Grok', 2, 'compat']] as const) : [])],
      ],
    ]
    for (const [dir, at] of dirs) entries.push(...skillEntries(yield* listDir(dir), display(dir), at))
    return entries
  })

const pluginEntries = (
  names: readonly string[],
  path: string,
  harness: HarnessName,
  source: Source,
  bundled: (n: string) => boolean = () => false,
): Entry[] =>
  names.map((name) => ({ harness, kind: 'plugin', name, source: bundled(name) ? 'bundled' : source, path, rank: 0 }))

const enabled = (plugins: Readonly<Record<string, unknown>> | undefined): string[] =>
  Object.entries(plugins ?? {})
    .filter(([, on]) => on === true)
    .map(([name]) => name)

export const declared = (root: string, h: Homes) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const display = (abs: string): string =>
      h.home !== '' && abs.startsWith(`${h.home}/`) ? `~${abs.slice(h.home.length)}` : abs
    const repoSettings = yield* readSettings(yield* read(path.join(root, '.claude/settings.json')))
    const userSettingsFile = path.join(h.home, '.claude/settings.json')
    const userSettings = h.home === '' ? Option.none() : yield* readSettings(yield* read(userSettingsFile))
    const codexFile = path.join(h.codexHome, 'config.toml')
    const codex = h.home === '' ? parseToml('') : parseToml(Option.getOrElse(yield* read(codexFile), () => ''))
    const codexPlugins = [...childTables(codex, 'plugins')].filter(([, t]) => t['enabled'] !== false).map(([n]) => n)

    const allow = [repoSettings, userSettings].flatMap((s) =>
      Option.isSome(s) && s.value.allowedMcpServers ? [s.value.allowedMcpServers] : [],
    )
    return {
      entries: [
        ...(yield* mcpDeclared(root, h, display)),
        ...(yield* skillsDeclared(root, h, display)),
        ...pluginEntries(
          Option.isSome(repoSettings) ? enabled(repoSettings.value.enabledPlugins) : [],
          '.claude/settings.json',
          'Claude Code',
          'repo',
        ),
        ...pluginEntries(
          Option.isSome(userSettings) ? enabled(userSettings.value.enabledPlugins) : [],
          display(userSettingsFile),
          'Claude Code',
          'user',
        ),
        ...pluginEntries(codexPlugins, display(codexFile), 'Codex', 'user', (n) => CODEX_BUNDLED_MARKETS.test(n)),
      ],
      claudeAllow: allow.length === 0 ? undefined : allow.flat(),
    } satisfies Declared
  })
