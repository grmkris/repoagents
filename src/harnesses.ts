// What each agent harness reads from a repository, verified 2026-10-09/10 on the versions listed. doctor uses it to
// explain where instructions come from and to spot skills a harness would load twice.
//
// MCP precedence (verified 2026-10-10 with temp HOMEs; inventory/probes.ts encodes it as ranks):
// - Claude Code: local (~/.claude.json projects[path]) > .mcp.json > user. A project `allowedMcpServers` in
//   .claude/settings.json blocks user, local and plugin servers that do not match (allowlists merge across scopes).
// - Codex: .codex/config.toml > ~/.codex/config.toml; a project `[mcp_servers.x] enabled = false` switches a user
//   server off by name.
// - Grok: .grok/config.toml > ~/.grok/config.toml > ~/.claude.json (user + local) > ~/.cursor/mcp.json > .mcp.json —
//   a user server shadows a .mcp.json server of the same name. Imported servers cannot be switched off from the repo.
// - Cursor agent: .cursor/mcp.json and ~/.cursor/mcp.json; nothing repo-level suppresses user servers.

type InstructionMode = 'direct' | 'fallback' | 'symlink-only'

export interface Harness {
  readonly name: string
  readonly verified: string
  /** Instruction files in the order the harness prefers them. */
  readonly instructions: readonly string[]
  /** How it reads AGENTS.md: directly, only when no CLAUDE.md exists, or only through a CLAUDE.md symlink. */
  readonly agentsMd: InstructionMode
  /** Skill directories it scans in a repository. */
  readonly skillDirs: readonly string[]
  /** The project MCP file it reads. */
  readonly mcp: string
  /** It lists a skill found in two of its dirs once (verified), so the .claude/skills links are harmless. */
  readonly dedupesSkills: boolean
  /** What `repoagents --isolate` can do about machine-level config for it, and what is left. */
  readonly isolation: string
}

export const HARNESSES: readonly Harness[] = [
  {
    name: 'Claude Code',
    verified: '2.1.295',
    instructions: ['CLAUDE.md', 'AGENTS.md'],
    agentsMd: 'fallback',
    skillDirs: ['.claude/skills'],
    mcp: '.mcp.json',
    dedupesSkills: true,
    isolation:
      'allowedMcpServers + disableClaudeAiConnectors in .claude/settings.json block user, local and plugin MCP servers; user skills and plugins still load',
  },
  {
    name: 'Codex',
    verified: '0.162.0',
    instructions: ['AGENTS.md'],
    agentsMd: 'direct',
    skillDirs: ['.agents/skills'],
    mcp: '.codex/config.toml',
    dedupesSkills: true,
    isolation:
      'repo servers win over same-named user ones; other user servers and skills still load (CODEX_HOME=<clean dir> for a clean run)',
  },
  {
    name: 'Grok',
    verified: '1.0.46',
    instructions: ['CLAUDE.md'],
    agentsMd: 'symlink-only',
    skillDirs: ['.agents/skills', '.claude/skills'],
    mcp: '.mcp.json',
    dedupesSkills: true,
    isolation:
      '.grok/config.toml wins over user config; servers imported from ~/.claude.json and ~/.cursor still load (GROK_CLAUDE_MCPS_ENABLED=0 GROK_CURSOR_MCPS_ENABLED=0 for a clean run)',
  },
  {
    name: 'Cursor agent',
    verified: '2026.09.23',
    instructions: ['AGENTS.md', '.cursor/rules'],
    agentsMd: 'direct',
    skillDirs: ['.agents/skills', '.claude/skills'],
    mcp: '.cursor/mcp.json',
    // Not verified yet: doctor warns that Cursor may list each linked skill twice.
    dedupesSkills: false,
    isolation: 'nothing repo-level; user servers in ~/.cursor/mcp.json still load',
  },
]
