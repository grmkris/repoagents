// `repoagents` / `repoagents check`: compare the repository with the layout and list what to write (actions) and
// what needs a person (issues). apply() carries out the actions; check reports them as drift.
import { Effect, FileSystem, Option, Path, Schema } from 'effect'
import { UnsafeWrite } from './errors.ts'
import { exists, linkTarget, listDir, readTextOption } from './fsx.ts'
import { isGenerated, renderCodex, renderCursor, validateServers } from './render.ts'
import { CLAUDE_SKILLS_DIR, listAgentsFiles, SKILLS_DIR, skillNames } from './repo.ts'
import { McpFile } from './schema.ts'

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

/** `.mcp.json` → `.codex/config.toml` + `.cursor/mcp.json`; refuses to replace hand-written or symlinked files. */
const planMcp = (root: string, force: boolean, version: string, out: Plan) =>
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
    const outputs: ReadonlyArray<readonly [string, string]> = [
      ['.codex/config.toml', renderCodex(servers, version)],
      ['.cursor/mcp.json', renderCursor(servers)],
    ]
    for (const [file, content] of outputs) {
      const abs = path.join(root, file)
      if (Option.isSome(yield* linkTarget(abs))) {
        out.issues.push({ file, problem: 'is a symlink; repoagents does not write through links' })
        continue
      }
      const current = yield* readTextOption(abs)
      if (Option.contains(current, content)) continue
      const ours = Option.isNone(current) || isGenerated(current.value) || file.endsWith('.json')
      if (ours || force) out.actions.push({ kind: 'write', file, content })
      else out.issues.push({ file, problem: 'hand-written file; move its servers into .mcp.json, then --force' })
    }
  })

export const plan = (root: string, options: { readonly force: boolean; readonly version: string }) =>
  Effect.gen(function* () {
    const out: Plan = { actions: [], issues: [] }
    yield* planInstructions(root, options.force, out)
    yield* planSkillLinks(root, out)
    yield* planMcp(root, options.force, options.version, out)
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
