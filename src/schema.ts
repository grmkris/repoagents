// The two files repoagents owns the format of: `.mcp.json` (the MCP master, in Claude Code's shape) and
// `.agents/skills/sources.json` (version 2 provenance for vendored skills).
import { Schema } from 'effect'

export const McpServer = Schema.Struct({
  type: Schema.optional(Schema.Literals(['stdio', 'http', 'sse'])),
  url: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type McpServer = typeof McpServer.Type

export const McpFile = Schema.Struct({ mcpServers: Schema.optional(Schema.Record(Schema.String, McpServer)) })

export const SkillSource = Schema.Struct({
  /** `owner/repo` on GitHub (or a git URL / absolute path). */
  repository: Schema.String,
  /** Pinned upstream commit (40 hex). */
  commit: Schema.String,
  /** Skill directory inside the upstream repository; `.` for the whole repository. */
  path: Schema.String,
  /** SPDX id, or `LicenseRef-…`. */
  license: Schema.String,
  /** License files copied into the skill directory. */
  licenses: Schema.Array(Schema.String),
  /** Tree hash of the files as copied from upstream. */
  treeSha256: Schema.String,
  /** Tree hash of the directory as committed. */
  localTreeSha256: Schema.String,
  /** The committed copy equals the upstream copy. */
  unchanged: Schema.Boolean,
  /** Why and how the copy differs; required when `unchanged` is false. */
  adaptation: Schema.optional(Schema.String),
  /** Upstream commit the adaptation was made on. */
  baseCommit: Schema.optional(Schema.String),
})
export type SkillSource = typeof SkillSource.Type

export const SourcesFile = Schema.Struct({
  version: Schema.Literal(2),
  skills: Schema.Record(Schema.String, SkillSource),
})
export type SourcesFile = typeof SourcesFile.Type
