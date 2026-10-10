// How results reach the terminal: human lines, or one JSON document under --json; --quiet keeps only problems.
import { Console, Effect } from 'effect'
import { IssuesFound } from './errors.ts'
import type { Issue } from './plan.ts'

export interface OutputOptions {
  readonly json: boolean
  readonly quiet: boolean
}

export const say = (o: OutputOptions, line: string) => (o.json || o.quiet ? Effect.void : Console.log(line))

export const json = (o: OutputOptions, value: unknown) =>
  o.json ? Console.log(JSON.stringify(value, null, 2)) : Effect.void

/** Prints issues (always, to stderr) and fails with IssuesFound when there are any. */
export const reportIssues = (o: OutputOptions, issues: readonly Issue[]) =>
  Effect.gen(function* () {
    if (!o.json) for (const i of issues) yield* Console.error(`✗ ${i.file}: ${i.problem}`)
    if (issues.length > 0) return yield* new IssuesFound({ count: issues.length })
  })
