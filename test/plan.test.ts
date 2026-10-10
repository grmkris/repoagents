import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { apply, plan } from '../src/plan.ts'
import { fixture, TestLayer } from './helpers.ts'

const opts = { force: false, version: '0.0.0' }

describe('plan / apply', () => {
  it.effect('creates CLAUDE.md and skill links and generated MCP files; then nothing is left', () =>
    Effect.gen(function* () {
      const root = fixture({
        'AGENTS.md': '# Repo\n',
        'apps/web/AGENTS.md': '# Web\n',
        'apps/web/CLAUDE.md': '@AGENTS.md\n',
        '.agents/skills/foo/SKILL.md': '---\nname: foo\ndescription: d\n---\n',
        '.mcp.json': JSON.stringify({ mcpServers: { myplan: { type: 'http', url: 'https://myplan.lol/mcp' } } }),
      })
      const first = yield* plan(root, opts)
      expect(first.issues).toEqual([])
      yield* apply(root, first.actions)
      expect(readlinkSync(join(root, 'CLAUDE.md'))).toBe('AGENTS.md')
      expect(readlinkSync(join(root, 'apps/web/CLAUDE.md'))).toBe('AGENTS.md')
      expect(readlinkSync(join(root, '.claude/skills/foo'))).toBe('../../.agents/skills/foo')
      expect(readFileSync(join(root, '.codex/config.toml'), 'utf8')).toContain('[mcp_servers.myplan]')
      expect((yield* plan(root, opts)).actions).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('refuses to replace a CLAUDE.md with its own content unless forced', () =>
    Effect.gen(function* () {
      const root = fixture({ 'AGENTS.md': '# A\n', 'CLAUDE.md': '# Different rules\n' })
      const p = yield* plan(root, opts)
      expect(p.issues[0]?.file).toBe('CLAUDE.md')
      expect(lstatSync(join(root, 'CLAUDE.md')).isSymbolicLink()).toBe(false)
      expect((yield* plan(root, { ...opts, force: true })).issues).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('prunes orphan skill links and flags real dirs in .claude/skills', () =>
    Effect.gen(function* () {
      const root = fixture({ 'AGENTS.md': '# A\n', '.claude/skills/real/SKILL.md': 'x' })
      mkdirSync(join(root, '.claude/skills'), { recursive: true })
      symlinkSync('../../.agents/skills/gone', join(root, '.claude/skills/gone'))
      const p = yield* plan(root, opts)
      expect(p.actions).toContainEqual({ kind: 'unlink', file: '.claude/skills/gone' })
      expect(p.issues.some((i) => i.file === '.claude/skills/real')).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('keeps hand-written codex config and generated files that are symlinks', () =>
    Effect.gen(function* () {
      const root = fixture({
        'AGENTS.md': '# A\n',
        '.codex/config.toml': '[mcp_servers.x]\nurl = "https://x"\n',
        '.mcp.json': JSON.stringify({ mcpServers: { y: { url: 'https://y/mcp' } } }),
        'elsewhere.json': '{}',
      })
      mkdirSync(join(root, '.cursor'))
      symlinkSync('../elsewhere.json', join(root, '.cursor/mcp.json'))
      const p = yield* plan(root, opts)
      expect(p.issues.map((i) => i.file).toSorted()).toEqual(['.codex/config.toml', '.cursor/mcp.json'])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('reports an unparsable .mcp.json and inline secrets as issues', () =>
    Effect.gen(function* () {
      const root = fixture({ 'AGENTS.md': '# A\n', '.mcp.json': '{nope' })
      expect((yield* plan(root, opts)).issues[0]?.file).toBe('.mcp.json')
      writeFileSync(
        join(root, '.mcp.json'),
        JSON.stringify({ mcpServers: { a: { url: 'https://a', headers: { Authorization: 'Bearer x' } } } }),
      )
      expect((yield* plan(root, opts)).issues.some((i) => i.problem.includes('inline secret'))).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )
})
