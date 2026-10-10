#!/usr/bin/env bun
// Entry point: runs the command tree on Bun's platform services and maps failures to exit codes (errors.ts).
import { BunServices } from '@effect/platform-bun'
import { Console, Effect, Layer, Match } from 'effect'
import { Command } from 'effect/cli'
import { app, VERSION } from './cli.ts'
import {
  EXIT,
  InvalidFile,
  IssuesFound,
  type RepoAgentsError,
  UnsafeWrite,
  UpstreamError,
  UsageError,
} from './errors.ts'
import { GitLive } from './git.ts'

const exitCode = (e: RepoAgentsError): number =>
  Match.value(e).pipe(
    Match.tagsExhaustive({
      IssuesFound: () => EXIT.issues,
      UsageError: () => EXIT.usage,
      UpstreamError: () => EXIT.upstream,
      InvalidFile: () => EXIT.invalid,
      UnsafeWrite: () => EXIT.unsafe,
    }),
  )

/** What to print; nothing for IssuesFound, whose issues were already printed. */
const message = (e: RepoAgentsError): string | undefined =>
  Match.value(e).pipe(
    Match.tagsExhaustive({
      IssuesFound: () => undefined,
      UsageError: (u) => u.message,
      UpstreamError: (u) => `${u.command} failed: ${u.stderr}`,
      InvalidFile: (u) => `${u.file}: ${u.reason}`,
      UnsafeWrite: (u) => `refused to write ${u.file}: ${u.reason}`,
    }),
  )

const layer = GitLive.pipe(Layer.provideMerge(BunServices.layer))

const isOwn = (e: unknown): e is RepoAgentsError =>
  e instanceof IssuesFound ||
  e instanceof UsageError ||
  e instanceof UpstreamError ||
  e instanceof InvalidFile ||
  e instanceof UnsafeWrite

/** Our errors get their exit code (and a message unless issues were already printed); effect/cli has already
 *  rendered its own parse and usage errors, which exit as usage errors. */
const handle = (e: unknown) => {
  if (!isOwn(e)) return Effect.sync(() => void (process.exitCode = EXIT.usage))
  const text = message(e)
  return (text === undefined ? Effect.void : Console.error(`✗ ${text}`)).pipe(
    Effect.andThen(Effect.sync(() => void (process.exitCode = exitCode(e)))),
  )
}

const program = Command.run(app, { version: VERSION }).pipe(Effect.catch(handle), Effect.provide(layer))

void Effect.runPromise(program).catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
