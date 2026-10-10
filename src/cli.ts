// The command tree. Handlers stay thin: resolve the shared flags, call the module, print.
import { Config, Console, Effect, Option, Path } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'
import pkg from '../package.json' with { type: 'json' }
import { skillsAudit } from './audit.ts'
import { doctor } from './doctor.ts'
import { HARNESSES } from './harnesses.ts'
import { leftovers } from './inventory/merge.ts'
import { UsageError } from './errors.ts'
import { json, reportIssues, say } from './output.ts'
import { apply, describeAction, plan } from './plan.ts'
import { skillsAdd, skillsFanout, skillsRehash, skillsUpdate, skillsVerify } from './skills.ts'
import { inventory, renderStatus } from './status.ts'

export const VERSION = pkg.version

const shared = {
  cwd: Flag.String('cwd').pipe(Flag.withDescription('repository root (default: current directory)'), Flag.optional),
  force: Flag.Boolean('force').pipe(
    Flag.withDescription('replace files repoagents did not write'),
    Flag.withDefault(false),
  ),
  json: Flag.Boolean('json').pipe(Flag.withDescription('print JSON'), Flag.withDefault(false)),
  quiet: Flag.Boolean('quiet').pipe(Flag.withDescription('print only problems'), Flag.withDefault(false)),
}

const resolveRoot = (cwd: Option.Option<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.resolve(Option.getOrElse(cwd, () => '.'))
  })

interface SyncFlags {
  readonly cwd: Option.Option<string>
  readonly force: boolean
  readonly json: boolean
  readonly quiet: boolean
  readonly isolate?: boolean
  readonly strict?: boolean
  readonly allow?: readonly string[]
}

/** check --strict: machine-level config a harness loads here, and repository entries something else overrides. */
const strictIssues = (root: string, allowFlags: readonly string[]) =>
  Effect.gen(function* () {
    const fromEnv = yield* Config.String('REPOAGENTS_ALLOW').pipe(Config.withDefault(''))
    const allow = new Set([...allowFlags, ...fromEnv.split(',').map((a) => a.trim())].filter((a) => a !== ''))
    const inv = yield* inventory(root, { live: false })
    return [
      ...leftovers(inv.items, allow).map((m) => ({
        file: m.path,
        problem: `machine-level ${m.kind} ${m.name} loads in ${m.harnesses.join(', ')} (--allow ${m.name} to accept)`,
      })),
      ...inv.warnings.filter((w) => w.level === 'warn').map((w) => ({ file: 'machine', problem: w.message })),
    ]
  })

const sync = (flags: SyncFlags, check: boolean) =>
  Effect.gen(function* () {
    const root = yield* resolveRoot(flags.cwd)
    const isolate = flags.isolate === true
    const planned = yield* plan(root, { force: flags.force, version: VERSION, isolate })
    const issues = [...planned.issues, ...(yield* skillsVerify(root))]
    if (check) {
      const drift = planned.actions.map((a) => ({ file: a.file, problem: `drift: ${describeAction(a)}` }))
      const strict = flags.strict === true ? yield* strictIssues(root, flags.allow ?? []) : []
      const all = [...issues, ...drift, ...strict]
      yield* json(flags, { ok: all.length === 0, issues: all })
      yield* reportIssues(flags, all)
      return yield* say(flags, 'repoagents: ok')
    }
    yield* apply(root, planned.actions)
    for (const a of planned.actions) yield* say(flags, `✓ ${describeAction(a)}`)
    yield* json(flags, { actions: planned.actions.map(describeAction), issues })
    if (planned.actions.length === 0 && issues.length === 0) yield* say(flags, 'repoagents: up to date')
    if (isolate) for (const h of HARNESSES) yield* say(flags, `· ${h.name}: ${h.isolation}`)
    yield* reportIssues(flags, issues)
  })

const root = Command.make(
  'repoagents',
  {
    ...shared,
    isolate: Flag.Boolean('isolate').pipe(
      Flag.withDescription('also write repo-level isolation: Claude allowedMcpServers, .grok/config.toml'),
      Flag.withDefault(false),
    ),
  },
  (flags) => sync(flags, false),
).pipe(Command.withDescription("Keep one repository's agent config consistent for Claude Code, Codex, Grok and Cursor"))

const checkCmd = Command.make(
  'check',
  {
    ...shared,
    strict: Flag.Boolean('strict').pipe(
      Flag.withDescription('also fail on machine-level MCP servers, skills and plugins that load here (local use)'),
      Flag.withDefault(false),
    ),
    allow: Flag.String('allow').pipe(
      Flag.withDescription('accept a machine-level item by name (repeatable; or REPOAGENTS_ALLOW=a,b)'),
      Flag.atLeast(0),
    ),
  },
  (flags) => sync(flags, true),
).pipe(Command.withDescription('Fail on drift: links, generated MCP files, vendored skills (for CI and pre-commit)'))

const statusCmd = Command.make(
  'status',
  {
    ...shared,
    live: Flag.Boolean('live').pipe(
      Flag.withDescription('also ask the harnesses (grok inspect, codex mcp list)'),
      Flag.withDefault(false),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const result = yield* inventory(yield* resolveRoot(flags.cwd), { live: flags.live })
      yield* json(flags, result)
      if (!flags.quiet) for (const line of renderStatus(result)) yield* say(flags, line)
      if (!flags.json)
        for (const w of result.warnings) yield* Console.error(`${w.level === 'warn' ? '!' : '·'} ${w.message}`)
    }),
).pipe(Command.withDescription('What each harness loads here and from where: MCP servers, skills, plugins'))

const doctorCmd = Command.make('doctor', shared, (flags) =>
  Effect.gen(function* () {
    const findings = yield* doctor(yield* resolveRoot(flags.cwd))
    yield* json(flags, findings)
    for (const f of findings) {
      if (flags.quiet && f.level === 'ok') continue
      yield* say(
        { ...flags, quiet: false },
        `${f.level === 'ok' ? '✓' : f.level === 'warn' ? '!' : '·'} ${f.topic}: ${f.message}`,
      )
    }
  }),
).pipe(Command.withDescription('Explain what each harness loads here; spot double-loaded skills and machine leftovers'))

const addCmd = Command.make(
  'add',
  {
    ...shared,
    repository: Argument.String('repository').pipe(Argument.withDescription('owner/repo on GitHub (or a git URL)')),
    path: Argument.String('path').pipe(Argument.withDescription('skill directory upstream; "." for the whole repo')),
    ref: Flag.String('ref').pipe(Flag.withDescription('commit or branch (default HEAD)'), Flag.optional),
    name: Flag.String('name').pipe(Flag.withDescription('local skill name'), Flag.optional),
    license: Flag.String('license').pipe(Flag.withDescription('SPDX id when detection fails'), Flag.optional),
  },
  (a) =>
    Effect.gen(function* () {
      const { name, entry } = yield* skillsAdd(yield* resolveRoot(a.cwd), a.repository, a.path, {
        ref: Option.getOrUndefined(a.ref),
        name: Option.getOrUndefined(a.name),
        license: Option.getOrUndefined(a.license),
      })
      yield* json(a, { name, ...entry })
      yield* say(a, `✓ ${name} @ ${entry.repository}@${entry.commit.slice(0, 7)} (${entry.license})`)
    }),
).pipe(Command.withDescription('Vendor an upstream skill and record its provenance'))

const rehashCmd = Command.make(
  'rehash',
  {
    ...shared,
    name: Argument.String('name'),
    why: Argument.String('why').pipe(Argument.withDescription('why the copy differs from upstream'), Argument.optional),
  },
  (a) =>
    Effect.gen(function* () {
      const e = yield* skillsRehash(yield* resolveRoot(a.cwd), a.name, Option.getOrUndefined(a.why))
      yield* json(a, { name: a.name, ...e })
      yield* say(a, `✓ ${a.name} recorded (${e.unchanged ? 'unchanged' : 'adapted'})`)
    }),
).pipe(Command.withDescription('Record local edits to a vendored skill'))

const verifyCmd = Command.make('verify', shared, (flags) =>
  Effect.gen(function* () {
    const issues = yield* skillsVerify(yield* resolveRoot(flags.cwd))
    yield* json(flags, { ok: issues.length === 0, issues })
    yield* reportIssues(flags, issues)
    yield* say(flags, 'skills: ok')
  }),
).pipe(Command.withDescription('Check vendored skills against sources.json (offline)'))

const updateCmd = Command.make(
  'update',
  {
    ...shared,
    check: Flag.Boolean('check').pipe(Flag.withDescription('only report'), Flag.withDefault(false)),
    names: Argument.String('name').pipe(Argument.variadic()),
  },
  (a) =>
    Effect.gen(function* () {
      const results = yield* skillsUpdate(yield* resolveRoot(a.cwd), a.names, !a.check)
      yield* json(a, results)
      for (const r of results)
        yield* say(
          a,
          `${r.status === 'current' || r.status === 'moved' || r.status === 'updated' ? '✓' : '↑'} ${r.name}: ${r.status} (${r.from.slice(0, 7)} → ${r.to.slice(0, 7)})`,
        )
      const pending = results.filter((r) => r.status === 'outdated' || r.status === 'adapted')
      yield* reportIssues(
        a,
        pending.map((r) => ({
          file: r.name,
          problem:
            r.status === 'adapted' ? 'adapted locally; re-apply the upstream change by hand' : 'upstream changed',
        })),
      )
    }),
).pipe(Command.withDescription('Compare pins with upstream; re-vendor unchanged skills'))

const fanoutCmd = Command.make(
  'fanout',
  {
    ...shared,
    names: Argument.String('name').pipe(Argument.variadic({ min: 1 })),
    to: Flag.String('to').pipe(Flag.withDescription('target repository (repeatable)'), Flag.atLeast(1)),
  },
  (a) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      if (a.to.length === 0) return yield* new UsageError({ message: 'give at least one --to <repo>' })
      yield* skillsFanout(
        yield* resolveRoot(a.cwd),
        a.names,
        a.to.map((t) => path.resolve(t)),
      )
      yield* say(a, `✓ copied ${a.names.join(', ')} to ${a.to.join(', ')}`)
    }),
).pipe(Command.withDescription('Copy vendored skills (dir + provenance) into other repositories'))

const auditCmd = Command.make('audit', shared, (flags) =>
  Effect.gen(function* () {
    const issues = yield* skillsAudit(yield* resolveRoot(flags.cwd))
    yield* json(flags, { ok: issues.length === 0, issues })
    yield* reportIssues(flags, issues)
    yield* say(flags, 'audit: no findings')
  }),
).pipe(Command.withDescription('Scan vendored skills for prompt injection, piped scripts, credentials, hidden Unicode'))

const skillsCmd = Command.make('skills').pipe(
  Command.withDescription('Vendored skills with provenance'),
  Command.withSubcommands([addCmd, rehashCmd, verifyCmd, updateCmd, fanoutCmd, auditCmd]),
)

export const app = root.pipe(Command.withSubcommands([checkCmd, statusCmd, doctorCmd, skillsCmd]))
