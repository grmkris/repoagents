// `--live`: ask the harnesses themselves. Grok (`inspect --json`) reports MCP servers and skills with the file they
// came from; Codex (`mcp list --json`) reports enabled state and auth. A missing binary, a timeout or output that
// does not parse yields nothing. Claude and Cursor only print text with slow health checks, so they are not asked.
import { Context, Effect, Layer, Option, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import type { LiveReport } from './merge.ts'

export class Cli extends Context.Service<
  Cli,
  {
    /** stdout of a successful run, or none (missing binary, non-zero exit, timeout). */
    readonly run: (command: string, args: readonly string[], cwd: string) => Effect.Effect<Option.Option<string>>
  }
>()('repoagents/Cli') {}

const decode = (chunks: readonly Uint8Array[]): string => new TextDecoder().decode(Buffer.concat(chunks))

export const CliLive = Layer.effect(
  Cli,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const run = (command: string, args: readonly string[], cwd: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd }))
          const [out, , code] = yield* Effect.all(
            [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
            { concurrency: 'unbounded' },
          )
          return code === 0 ? Option.some(decode(out)) : Option.none<string>()
        }),
      ).pipe(
        Effect.timeout('30 seconds'),
        Effect.orElseSucceed(() => Option.none<string>()),
      )
    return Cli.of({ run })
  }),
)

const Source = Schema.Struct({ type: Schema.String, path: Schema.optional(Schema.String) })
const GrokInspect = Schema.Struct({
  mcpServers: Schema.Array(Schema.Struct({ name: Schema.String, source: Source })),
  skills: Schema.Array(Schema.Struct({ name: Schema.String, source: Source })),
})
const CodexList = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    enabled: Schema.Boolean,
    auth_status: Schema.optional(Schema.NullOr(Schema.String)),
  }),
)

const parse = <S extends Schema.Top>(schema: S, text: Option.Option<string>) =>
  Option.isNone(text)
    ? Effect.succeed(Option.none<S['Type']>())
    : Schema.decodeEffect(Schema.fromJsonString(schema))(text.value).pipe(Effect.option)

/** Paths inside the repository become relative, like the declared ones. */
const relative = (root: string, home: string, p: string | undefined): string | undefined => {
  if (p === undefined) return undefined
  if (p.startsWith(`${root}/`)) return p.slice(root.length + 1)
  return home !== '' && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p
}

export const liveReports = (root: string, home: string) =>
  Effect.gen(function* () {
    const cli = yield* Cli
    const [grok, codex] = yield* Effect.all(
      [cli.run('grok', ['inspect', '--json'], root), cli.run('codex', ['mcp', 'list', '--json'], root)],
      { concurrency: 'unbounded' },
    )
    const reports: LiveReport[] = []
    const g = yield* parse(GrokInspect, grok)
    if (Option.isSome(g)) {
      for (const s of g.value.mcpServers) {
        const path = relative(root, home, s.source.path)
        reports.push({ harness: 'Grok', kind: 'mcp', name: s.name, path, note: `loaded from ${path ?? s.source.type}` })
      }
      for (const s of g.value.skills) {
        const path = relative(root, home, s.source.path?.replace(/\/SKILL\.md$/u, ''))
        reports.push({ harness: 'Grok', kind: 'skill', name: s.name, path, note: 'loaded' })
      }
    }
    const c = yield* parse(CodexList, codex)
    if (Option.isSome(c))
      for (const s of c.value)
        reports.push({
          harness: 'Codex',
          kind: 'mcp',
          name: s.name,
          note: `${s.enabled ? 'enabled' : 'disabled'}${s.auth_status ? `, auth ${s.auth_status}` : ''}`,
        })
    return { reports, asked: { grok: Option.isSome(g), codex: Option.isSome(c) } }
  })
