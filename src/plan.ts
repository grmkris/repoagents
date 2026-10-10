// `repoagents` / `repoagents check`: compare the repository with the layout and list what to write (actions) and
// what needs a person (issues). apply() carries out the actions; check reports them as drift.
import { Effect, FileSystem, Option, Path, Schema } from 'effect'
import { UnsafeWrite } from './errors.ts'
import { exists, linkTarget, listDir, readTextOption } from './fsx.ts'
import {
  claudeAllowlist,
  isGenerated,
  sameGenerated,
  renderCodex,
  renderCursor,
  renderGrok,
  validateServers,
} from './render.ts'
import { CLAUDE_SKILLS_DIR, listAgentsFiles, SKILLS_DIR, skillNames } from './repo.ts'
import { McpFile, type McpServer } from './schema.ts'

export type Action =
  | { readonly kind: 'write'; readonly file: string; readonly content: string }
  | { readonly kind: 'link'; readonly file: string; readonly target: string; readonly replace: boolean }
  | { readonly kind: 'unlink'; readonly file: string }

export interface Issue {
  readonly file: string
  readonly problem: string
}

export interface Plan {
  readonly actions: Action[]
  readonly issues: Issue[]
}

const isStub = (text: string): boolean => text.trim() === '@AGENTS.md' || text.trim() === ''

/** CLAUDE.md → AGENTS.md symlink beside every AGENTS.md. */
const planInstructions = (root: string, force: boolean, out: Plan) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    for (const agents of yield* listAgentsFiles(root)) {
      const claude = path.join(path.dirname(agents), 'CLAUDE.md')
      const target = yield* linkTarget(path.join(root, claude))
      if (Option.isSome(target)) {
        if (target.value !== 'AGENTS.md')
          out.actions.push({ kind: 'link', file: claude, target: 'AGENTS.md', replace: true })
        continue
      }
      const text = yield* readTextOption(path.join(root, claude))
      if (Option.isNone(text)) {
        out.actions.push({ kind: 'link', file: claude, target: 'AGENTS.md', replace: false })
        continue
      }
      const master = yield* readTextOption(path.join(root, agents))
      if (force || isStub(text.value) || Option.contains(master, text.value))
        out.actions.push({ kind: 'link', file: claude, target: 'AGENTS.md', replace: true })
      else
        out.issues.push({
          file: claude,
          problem:
            'real file with its own content; merge it into AGENTS.md (Claude-only bits → .claude/rules/), or --force',
        })
    }
  })

/** `.claude/skills/<name>` → `../../.agents/skills/<name>` for each skill; orphan links pruned. */
const planSkillLinks = (root: string, out: Plan) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const names = yield* skillNames(root)
    for (const name of names) {
      const file = `${CLAUDE_SKILLS_DIR}/${name}`
      const want = `../../${SKILLS_DIR}/${name}`
      const target = yield* linkTarget(path.join(root, file))
      if (Option.contains(target, want)) continue
      if (Option.isSome(target)) out.actions.push({ kind: 'link', file, target: want, replace: true })
      else if (yield* exists(path.join(root, file)))
        out.issues.push({ file, problem: 'real directory; move it to .agents/skills/ (the master) and re-run' })
      else out.actions.push({ kind: 'link', file, target: want, replace: false })
    }
    for (const entry of yield* listDir(path.join(root, CLAUDE_SKILLS_DIR))) {
      if (names.includes(entry)) continue
      const file = `${CLAUDE_SKILLS_DIR}/${entry}`
      const target = yield* linkTarget(path.join(root, file))
      if (Option.isSome(target) && target.value.startsWith(`../../${SKILLS_DIR}/`))
        out.actions.push({ kind: 'unlink', file })
      else out.issues.push({ file, problem: 'not in .agents/skills; move it there (or delete it)' })
    }
  })

const decodeMcp = Schema.decodeUnknownEffect(Schema.fromJsonString(McpFile))
const decodeObject = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

/** One generated MCP file: written when missing or ours, reported when hand-written or a symlink. */
const planGenerated = (root: string, file: string, content: string, force: boolean, out: Plan) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const abs = path.join(root, file)
    if (Option.isSome(yield* linkTarget(abs))) {
      out.issues.push({ file, problem: 'is a symlink; repoagents does not write through links' })
      return
    }
    const current = yield* readTextOption(abs)
    if (Option.isSome(current) && sameGenerated(current.value, content)) return
    const ours = Option.isNone(current) || isGenerated(current.value) || file.endsWith('.json')
    if (ours || force) out.actions.push({ kind: 'write', file, content })
    else out.issues.push({ file, problem: 'hand-written file; move its servers into .mcp.json, then --force' })
  })

const CLAUDE_SETTINGS = '.claude/settings.json'
const GROK_CONFIG = '.grok/config.toml'

/** `allowedMcpServers` in `.claude/settings.json`: written by --isolate, kept in step with .mcp.json afterwards.
 *  Every other key is preserved. */
const planClaudeAllowlist = (root: string, servers: Readonly<Record<string, McpServer>>, isolate: boolean, out: Plan) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const abs = path.join(root, CLAUDE_SETTINGS)
    const raw = yield* readTextOption(abs)
    const parsed = Option.isNone(raw) ? Option.some({}) : yield* decodeObject(raw.value).pipe(Effect.option)
    if (Option.isNone(parsed)) {
      if (isolate) out.issues.push({ file: CLAUDE_SETTINGS, problem: 'does not parse as a JSON object' })
      return
    }
    const current: Readonly<Record<string, unknown>> = parsed.value
    if (!isolate && !('allowedMcpServers' in current)) return
    if (Option.isSome(yield* linkTarget(abs))) {
      out.issues.push({ file: CLAUDE_SETTINGS, problem: 'is a symlink; repoagents does not write through links' })
      return
    }
    const want = claudeAllowlist(servers)
    const inStep = JSON.stringify(current['allowedMcpServers']) === JSON.stringify(want)
    if (inStep && (!isolate || current['disableClaudeAiConnectors'] === true)) return
    const next = { ...current, allowedMcpServers: want, ...(isolate ? { disableClaudeAiConnectors: true } : {}) }
    out.actions.push({ kind: 'write', file: CLAUDE_SETTINGS, content: `${JSON.stringify(next, null, 2)}\n` })
  })

/** `.mcp.json` → `.codex/config.toml` + `.cursor/mcp.json` (+ `.grok/config.toml` and Claude's allowlist once
 *  isolated); refuses to replace hand-written or symlinked files. */
const planMcp = (root: string, options: PlanOptions, out: Plan) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const raw = yield* readTextOption(path.join(root, '.mcp.json'))
    if (Option.isNone(raw)) return
    const parsed = yield* decodeMcp(raw.value).pipe(Effect.option)
    if (Option.isNone(parsed)) {
      out.issues.push({ file: '.mcp.json', problem: 'does not parse as { mcpServers: { name: server } }' })
      return
    }
    const servers = parsed.value.mcpServers ?? {}
    const problems = validateServers(servers)
    for (const problem of problems) out.issues.push({ file: '.mcp.json', problem })
    if (problems.length > 0) return
    const { force, version, isolate } = options
    const grok = yield* readTextOption(path.join(root, GROK_CONFIG))
    const grokManaged = isolate || (Option.isSome(grok) && isGenerated(grok.value))
    const outputs: ReadonlyArray<readonly [string, string]> = [
      ['.codex/config.toml', renderCodex(servers, version)],
      ['.cursor/mcp.json', renderCursor(servers)],
      ...(grokManaged ? ([[GROK_CONFIG, renderGrok(servers, version)]] as const) : []),
    ]
    for (const [file, content] of outputs) yield* planGenerated(root, file, content, force, out)
    yield* planClaudeAllowlist(root, servers, isolate, out)
  })

export interface PlanOptions {
  readonly force: boolean
  readonly version: string
  /** Also write the repo-level isolation settings (Claude allowlist, .grok/config.toml). */
  readonly isolate: boolean
}

export const plan = (root: string, options: PlanOptions) =>
  Effect.gen(function* () {
    const out: Plan = { actions: [], issues: [] }
    yield* planInstructions(root, options.force, out)
    yield* planSkillLinks(root, out)
    yield* planMcp(root, options, out)
    return out
  })

export const describeAction = (a: Action): string => {
  switch (a.kind) {
    case 'write':
      return `write ${a.file}`
    case 'unlink':
      return `remove ${a.file}`
    case 'link':
      return `link ${a.file} -> ${a.target}`
  }
}

export const apply = (root: string, actions: readonly Action[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    for (const a of actions) {
      const abs = path.join(root, a.file)
      yield* fs.makeDirectory(path.dirname(abs), { recursive: true })
      if (a.kind === 'write') {
        if (Option.isSome(yield* linkTarget(abs))) return yield* new UnsafeWrite({ file: a.file, reason: 'symlink' })
        yield* fs.writeFileString(abs, a.content)
      } else if (a.kind === 'unlink') yield* fs.remove(abs)
      else {
        if (a.replace) yield* fs.remove(abs, { force: true })
        yield* fs.symlink(a.target, abs)
      }
    }
  })
