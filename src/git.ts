// The git CLI as a service: sparse, shallow fetches of one upstream path, remote HEAD lookups and the files a
// repository would commit. Tests swap in a layer that fetches from local fixture repositories.
import { Context, Effect, Layer, Option, Path, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { UpstreamError } from './errors.ts'

const LICENSE_GLOBS = ['LICENSE*', 'LICENCE*', 'COPYING*', 'NOTICE*']

export class Git extends Context.Service<
  Git,
  {
    /** stdout of `git <args>` in `cwd`; fails with UpstreamError on a non-zero exit. */
    readonly run: (args: readonly string[], cwd: string) => Effect.Effect<string, UpstreamError>
  }
>()('repoagents/Git') {}

const decode = (chunks: readonly Uint8Array[]): string => new TextDecoder().decode(Buffer.concat(chunks))

export const GitLive = Layer.effect(
  Git,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const run = (args: readonly string[], cwd: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make('git', args, { cwd }))
          const [out, err, code] = yield* Effect.all(
            [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
            { concurrency: 'unbounded' },
          )
          if (code !== 0)
            return yield* new UpstreamError({ command: `git ${args.join(' ')}`, stderr: decode(err).trim() })
          return decode(out).trim()
        }),
      ).pipe(
        Effect.catchTag('PlatformError', (e) =>
          Effect.fail(new UpstreamError({ command: `git ${args.join(' ')}`, stderr: e.message })),
        ),
      )
    return Git.of({ run })
  }),
)

/** owner/repo → GitHub URL; URLs and absolute paths pass through (tests use local repositories). */
const repoUrl = (repository: string): string =>
  repository.includes('://') || repository.startsWith('/') ? repository : `https://github.com/${repository}.git`

/** Sparse paths for one skill dir plus the license files of every ancestor directory (plugin repos keep LICENSE
 *  beside the plugin rather than at the root). */
const sparsePaths = (path: string): string[] => {
  const parts = path.split('/')
  const ancestors = ['', ...parts.slice(0, -1).map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)]
  return [`/${path}/`, ...ancestors.flatMap((a) => LICENSE_GLOBS.map((g) => `${a}/${g}`))]
}

/** Checks out `path` (or the whole repo for `.`) of `repository` at `ref` into `dir`; returns the resolved commit. */
export const fetchInto = (repository: string, path: string, ref: string, dir: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    yield* git.run(['init', '-q'], dir)
    yield* git.run(['remote', 'add', 'origin', repoUrl(repository)], dir)
    if (path !== '.') yield* git.run(['sparse-checkout', 'set', '--no-cone', ...sparsePaths(path)], dir)
    yield* git.run(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', ref], dir)
    yield* git.run(['checkout', '-q', 'FETCH_HEAD'], dir)
    return yield* git.run(['rev-parse', 'HEAD'], dir)
  })

/** The commit a remote's HEAD points at. */
export const remoteHead = (repository: string, cwd: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const out = yield* git.run(['ls-remote', repoUrl(repository), 'HEAD'], cwd)
    return out.split(/\s/u)[0] ?? ''
  })

/** AGENTS.md files git would commit (tracked + untracked, minus ignores); none when `root` is not a git repo. */
export const agentsFiles = (root: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const path = yield* Path.Path
    const out = yield* git
      .run(['ls-files', '-co', '--exclude-standard', '--', 'AGENTS.md', '**/AGENTS.md'], root)
      .pipe(Effect.option)
    if (Option.isNone(out)) return undefined
    return out.value
      .split('\n')
      .filter((p) => p !== '')
      .map((p) => path.normalize(p))
  })
