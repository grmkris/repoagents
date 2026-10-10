// `repoagents doctor`: where each harness gets its instructions, skills and MCP servers in this repository, skills a
// harness may load twice, MCP env vars that are not set (names only), and machine-level config that should live in
// a repository instead (see `repoagents status` for the full picture).
import { Config, Effect, Option, Path, Schema } from 'effect'
import { HARNESSES, type Harness } from './harnesses.ts'
import { exists, linkTarget, listDir, readTextOption } from './fsx.ts'
import { CLAUDE_SKILLS_DIR, SKILLS_DIR, skillNames } from './repo.ts'
import { leftovers } from './inventory/merge.ts'
import { McpFile } from './schema.ts'
import { inventory } from './status.ts'

interface Finding {
  readonly level: 'ok' | 'info' | 'warn'
  readonly topic: string
  readonly message: string
}

const instructionsFor = (
  h: Harness,
  claude: Option.Option<string>,
  hasClaude: boolean,
  hasAgents: boolean,
): Finding => {
  const linked = Option.contains(claude, 'AGENTS.md')
  if (h.agentsMd === 'direct')
    return { level: hasAgents ? 'ok' : 'warn', topic: h.name, message: hasAgents ? 'reads AGENTS.md' : 'no AGENTS.md' }
  if (linked) return { level: 'ok', topic: h.name, message: 'reads AGENTS.md through the CLAUDE.md symlink' }
  if (hasClaude)
    return {
      level: 'warn',
      topic: h.name,
      message: 'reads a CLAUDE.md that is not the AGENTS.md symlink; AGENTS.md is shadowed',
    }
  return h.agentsMd === 'fallback' && hasAgents
    ? {
        level: 'info',
        topic: h.name,
        message: 'reads AGENTS.md only as a fallback (any CLAUDE.md up the tree hides it); add the symlink',
      }
    : { level: 'warn', topic: h.name, message: 'sees no instructions; run repoagents to add the CLAUDE.md symlink' }
}

const instructionFindings = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const claude = yield* linkTarget(path.join(root, 'CLAUDE.md'))
    const hasClaude = yield* exists(path.join(root, 'CLAUDE.md'))
    const hasAgents = yield* exists(path.join(root, 'AGENTS.md'))
    return HARNESSES.map((h) => instructionsFor(h, claude, hasClaude, hasAgents))
  })

const skillFindings = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const skills = yield* skillNames(root)
    const links = yield* listDir(path.join(root, CLAUDE_SKILLS_DIR))
    return HARNESSES.map((h): Finding => {
      const seen = h.skillDirs.flatMap((d) => (d === SKILLS_DIR ? skills : d === CLAUDE_SKILLS_DIR ? links : []))
      const twice = seen.length - new Set(seen).size
      return twice > 0 && !h.dedupesSkills
        ? {
            level: 'info',
            topic: h.name,
            message: `${new Set(seen).size} skills; may list ${twice} twice (reads ${h.skillDirs.join(' + ')}; unverified)`,
          }
        : { level: 'ok', topic: h.name, message: `${new Set(seen).size} skills from ${h.skillDirs.join(' + ')}` }
    })
  })

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu
const decodeMcp = Schema.decodeUnknownEffect(Schema.fromJsonString(McpFile))

const mcpFindings = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const raw = yield* readTextOption(path.join(root, '.mcp.json'))
    if (Option.isNone(raw)) return [{ level: 'info', topic: 'MCP', message: 'no .mcp.json' } satisfies Finding]
    const file = yield* decodeMcp(raw.value).pipe(Effect.option)
    const servers = Option.isSome(file) ? (file.value.mcpServers ?? {}) : {}
    const names = [
      ...new Set(
        Object.values(servers)
          .flatMap((s) => [...Object.values(s.headers ?? {}), ...Object.values(s.env ?? {})])
          .flatMap((v) => [...v.matchAll(VAR)].map((m) => m[1] ?? '')),
      ),
    ]
    const out: Finding[] = [
      { level: 'ok', topic: 'MCP', message: `servers: ${Object.keys(servers).join(', ') || 'none'}` },
    ]
    for (const name of names) {
      const value = yield* Config.option(Config.String(name)).pipe(Effect.orElseSucceed(() => Option.none<string>()))
      const set = Option.isSome(value)
      out.push({ level: set ? 'ok' : 'warn', topic: 'MCP', message: `env ${name}: ${set ? 'set' : 'MISSING'}` })
    }
    return out
  })

const machineFindings = (root: string) =>
  Effect.gen(function* () {
    const inv = yield* inventory(root, { live: false })
    const rows = leftovers(inv.items, new Set())
    return [
      ...inv.warnings.map((w): Finding => ({ level: w.level, topic: 'machine', message: w.message })),
      ...(rows.length === 0
        ? [
            {
              level: 'ok',
              topic: 'machine',
              message: 'no machine-level MCP servers, skills or plugins load here',
            } satisfies Finding,
          ]
        : rows.map((r): Finding => ({
            level: 'info',
            topic: 'machine',
            message: `machine-level ${r.kind} ${r.name}: ${r.path} (${r.harnesses.join(', ')})`,
          }))),
    ]
  })

export const doctor = (root: string) =>
  Effect.gen(function* () {
    return [
      ...(yield* instructionFindings(root)),
      ...(yield* skillFindings(root)),
      ...(yield* mcpFindings(root)),
      ...(yield* machineFindings(root)),
    ]
  })
