// Every failure a command can end with, as tagged errors; main.ts maps each to an exit code.
import { Schema } from 'effect'

/** Exit codes: 0 ok; 1 drift or issues found; 2 usage; 3 upstream (git/network); 4 invalid file; 5 unsafe write. */
export const EXIT = { issues: 1, usage: 2, upstream: 3, invalid: 4, unsafe: 5 } as const

/** `check`, `skills verify` or `skills update --check` found something to fix. */
export class IssuesFound extends Schema.TaggedError<IssuesFound>()('IssuesFound', { count: Schema.Finite }) {}

/** Bad arguments or a request that cannot be carried out as given. */
export class UsageError extends Schema.TaggedError<UsageError>()('UsageError', { message: Schema.String }) {}

/** A git command against an upstream repository failed. */
export class UpstreamError extends Schema.TaggedError<UpstreamError>()('UpstreamError', {
  command: Schema.String,
  stderr: Schema.String,
}) {}

/** A file repoagents reads does not parse or match its schema. */
export class InvalidFile extends Schema.TaggedError<InvalidFile>()('InvalidFile', {
  file: Schema.String,
  reason: Schema.String,
}) {}

/** A write was refused: it would go through a symlink or replace a file repoagents does not own. */
export class UnsafeWrite extends Schema.TaggedError<UnsafeWrite>()('UnsafeWrite', {
  file: Schema.String,
  reason: Schema.String,
}) {}

export type RepoAgentsError = IssuesFound | UsageError | UpstreamError | InvalidFile | UnsafeWrite
