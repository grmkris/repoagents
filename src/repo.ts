// What a repository contains: its AGENTS.md files and its skills.
import { Effect, FileSystem, Path } from 'effect'
import { exists, isDirectory, listDir, SKIP_DIRS } from './fsx.ts'
import { agentsFiles } from './git.ts'

export const SKILLS_DIR = '.agents/skills'
export const CLAUDE_SKILLS_DIR = '.claude/skills'
export const SOURCES_FILE = '.agents/skills/sources.json'

const walkAgents = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const found: string[] = []
    const walk = (rel: string): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
      Effect.gen(function* () {
        for (const name of yield* fs
          .readDirectory(path.join(root, rel))
          .pipe(Effect.orElseSucceed((): string[] => []))) {
          const child = rel === '' ? name : path.join(rel, name)
          if (name === 'AGENTS.md') found.push(child)
          else if (!SKIP_DIRS.has(name) && (yield* isDirectory(path.join(root, child)))) yield* walk(child)
        }
      })
    yield* walk('')
    return found
  })

/** Relative paths of every AGENTS.md (via git when possible, so ignored trees are skipped), sorted. */
export const listAgentsFiles = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const viaGit = yield* agentsFiles(root)
    const candidates = viaGit ?? (yield* walkAgents(root))
    const present: string[] = []
    for (const file of candidates) {
      if (file.split('/').some((seg) => SKIP_DIRS.has(seg))) continue
      if (yield* exists(path.join(root, file))) present.push(file)
    }
    return present.toSorted()
  })

/** Names of `.agents/skills/<name>` directories that contain a SKILL.md. */
export const skillNames = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const names: string[] = []
    for (const name of yield* listDir(path.join(root, SKILLS_DIR))) {
      if (yield* exists(path.join(root, SKILLS_DIR, name, 'SKILL.md'))) names.push(name)
    }
    return names
  })
