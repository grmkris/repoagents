// The command tree. Handlers stay thin: resolve the shared flags, call the module, print.
import { Effect, Option, Path } from 'effect'
import { Argument, Command, Flag } from 'effect/cli'
import pkg from '../package.json' with { type: 'json' }
import { skillsAudit } from './audit.ts'
import { doctor } from './doctor.ts'
import { UsageError } from './errors.ts'
import { json, reportIssues, say } from './output.ts'
import { apply, describeAction, plan } from './plan.ts'
import { skillsAdd, skillsFanout, skillsRehash, skillsUpdate, skillsVerify } from './skills.ts'

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

const sync = (flags: { cwd: Option.Option<string>; force: boolean; json: boolean; quiet: boolean }, check: boolean) =>
  Effect.gen(function* () {
    const root = yield* resolveRoot(flags.cwd)
    const planned = yield* plan(root, { force: flags.force, version: VERSION })
    const issues = [...planned.issues, ...(yield* skillsVerify(root))]
    if (check) {
      const drift = planned.actions.map((a) => ({ file: a.file, problem: `drift: ${describeAction(a)}` }))
      yield* json(flags, { ok: issues.length + drift.length === 0, issues: [...issues, ...drift] })
      yield* reportIssues(flags, [...issues, ...drift])
      return yield* say(flags, 'repoagents: ok')
    }
    yield* apply(root, planned.actions)
    for (const a of planned.actions) yield* say(flags, `✓ ${describeAction(a)}`)
    yield* json(flags, { actions: planned.actions.map(describeAction), issues })
    if (planned.actions.length === 0 && issues.length === 0) yield* say(flags, 'repoagents: up to date')
    yield* reportIssues(flags, issues)
  })

const root = Command.make('repoagents', shared, (flags) => sync(flags, false)).pipe(
  Command.withDescription("Keep one repository's agent config consistent for Claude Code, Codex, Grok and Cursor"),
)

const checkCmd = Command.make('check', shared, (flags) => sync(flags, true)).pipe(
  Command.withDescription('Fail on drift: links, generated MCP files, vendored skills (for CI and pre-commit)'),
)

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

export const app = root.pipe(Command.withSubcommands([checkCmd, doctorCmd, skillsCmd]))
