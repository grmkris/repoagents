// What each agent harness reads from a repository, verified 2026-10-09/10 on the versions listed. doctor uses it to
// explain where instructions come from and to spot skills a harness would load twice.

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
  },
  {
    name: 'Codex',
    verified: '0.162.0',
    instructions: ['AGENTS.md'],
    agentsMd: 'direct',
    skillDirs: ['.agents/skills'],
    mcp: '.codex/config.toml',
    dedupesSkills: true,
  },
  {
    name: 'Grok',
    verified: '1.0.46',
    instructions: ['CLAUDE.md'],
    agentsMd: 'symlink-only',
    skillDirs: ['.agents/skills', '.claude/skills'],
    mcp: '.mcp.json',
    dedupesSkills: true,
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
  },
]
