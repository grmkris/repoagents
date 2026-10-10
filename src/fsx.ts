// Small FileSystem helpers the commands share. Missing paths are values (Option / false), not failures.
import { Effect, FileSystem, Option, Path } from 'effect'

/** Directories never scanned for AGENTS.md or skill files. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.local',
  '.crew',
  '.wrangler',
])

/** The target of a symlink, or none when the path is missing or not a link. */
export const linkTarget = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readLink(path).pipe(Effect.option)
  })

export const exists = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
  })

/** File contents, or none when the file does not exist. */
export const readTextOption = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* exists(path))) return Option.none<string>()
    return Option.some(yield* fs.readFileString(path))
  })

/** Entries of a directory (names), or none when it does not exist. */
export const listDir = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* exists(path))) return []
    return (yield* fs.readDirectory(path)).toSorted()
  })

/** Whether `path` is a real directory (following links). */
export const isDirectory = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(path).pipe(Effect.option)
    return Option.isSome(info) && info.value.type === 'Directory'
  })

/** Every regular file below `dir`, relative and `/`-separated, skipping .git and node_modules. */
export const walkFiles = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const files: string[] = []
    const walk = (rel: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        const abs = rel === '' ? dir : path.join(dir, rel)
        for (const name of yield* fs.readDirectory(abs).pipe(Effect.orElseSucceed((): string[] => []))) {
          if (name === '.git' || name === 'node_modules') continue
          const child = rel === '' ? name : `${rel}/${name}`
          if (Option.isSome(yield* linkTarget(path.join(dir, child)))) continue
          const info = yield* fs.stat(path.join(dir, child)).pipe(Effect.option)
          if (Option.isNone(info)) continue
          if (info.value.type === 'Directory') yield* walk(child)
          else if (info.value.type === 'File') files.push(child)
        }
      })
    yield* walk('')
    return files.toSorted()
  })

/** Copies a directory tree (regular files only), creating `to`. */
export const copyTree = (from: string, to: string, skip: ReadonlySet<string> = new Set()) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    for (const rel of yield* walkFiles(from)) {
      if (rel.split('/').some((seg) => skip.has(seg))) continue
      yield* fs.makeDirectory(path.dirname(path.join(to, rel)), { recursive: true })
      yield* fs.copyFile(path.join(from, rel), path.join(to, rel))
    }
  })
