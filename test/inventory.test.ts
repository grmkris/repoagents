import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { leftovers, resolve, warnings } from '../src/inventory/merge.ts'
import type { Item } from '../src/inventory/model.ts'
import { declared } from '../src/inventory/probes.ts'
import { parseToml } from '../src/toml.ts'
import { fixture, TestLayer } from './helpers.ts'

const REPO_MCP = JSON.stringify({
  mcpServers: {
    myplan: { type: 'http', url: 'https://myplan.lol/mcp' },
    mytab: { type: 'http', url: 'https://mytab.lol/mcp' },
  },
})

/** A home with the leftovers we found on real machines, and a repository on the standard. */
const setup = (repoFiles: Readonly<Record<string, string>> = {}) => {
  const root = fixture({ '.mcp.json': REPO_MCP, '.agents/skills/a/SKILL.md': 'a', ...repoFiles })
  const home = fixture({
    '.claude.json': JSON.stringify({
      mcpServers: { tldraw: { type: 'stdio', command: 'tldraw-mcp', args: [] } },
      projects: { [root]: { mcpServers: { mytab: { type: 'http', url: 'https://old.mytab.lol/mcp' } } } },
    }),
    '.grok/config.toml': '[mcp_servers.myplan]\nurl = "https://myplan.lol/mcp"\n',
    '.codex/config.toml':
      '[mcp_servers.extra]\nurl = "https://extra.example/mcp"\n\n[mcp_servers.node_repl]\ncommand = "node"\n',
    '.claude/skills/tool/SKILL.md': 'tool',
    '.claude/skills/synced/x/SKILL.md': 'x',
  })
  mkdirSync(join(root, '.codex'), { recursive: true })
  return { root, homes: { home, codexHome: join(home, '.codex') } }
}

const find = (items: readonly Item[], harness: Item['harness'], name: string, source: Item['source']) =>
  items.find((i) => i.harness === harness && i.name === name && i.source === source)

describe('inventory', () => {
  it.effect('resolves precedence per harness and lists machine-level leftovers', () =>
    Effect.gen(function* () {
      const { root, homes } = setup({ '.codex/config.toml': '[mcp_servers.extra]\nenabled = false\n' })
      const d = yield* declared(root, homes)
      const items = resolve(d.entries, d.claudeAllow)
      // Claude: the machine-local entry for this path beats .mcp.json.
      expect(find(items, 'Claude Code', 'mytab', 'local')?.state).toBe('active')
      expect(find(items, 'Claude Code', 'mytab', 'repo')?.state).toBe('shadowed')
      // Grok: a user config.toml server shadows a same-named .mcp.json server.
      expect(find(items, 'Grok', 'myplan', 'user')?.state).toBe('active')
      expect(find(items, 'Grok', 'myplan', 'repo')?.state).toBe('shadowed')
      // Codex: the project switches a user server off by name; app servers are bundled.
      expect(find(items, 'Codex', 'extra', 'user')?.state).toBe('disabled')
      expect(find(items, 'Codex', 'node_repl', 'bundled')?.state).toBe('active')
      const rows = leftovers(items, new Set())
      expect(rows.map((r) => `${r.kind}:${r.name}`).toSorted()).toEqual([
        'mcp:myplan',
        'mcp:mytab',
        'mcp:tldraw',
        'skill:tool',
      ])
      expect(rows.find((r) => r.name === 'tldraw')?.harnesses).toEqual(['Claude Code', 'Grok'])
      expect(leftovers(items, new Set(['myplan', 'mytab', 'tldraw', 'tool']))).toEqual([])
      expect(warnings(items).map((w) => w.message)).toContain(
        'Grok: repo mcp myplan is shadowed by ~/.grok/config.toml',
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("Claude's allowedMcpServers blocks user and local servers that do not match", () =>
    Effect.gen(function* () {
      const allow = [{ serverUrl: 'https://myplan.lol/mcp' }, { serverUrl: 'https://mytab.lol/mcp' }]
      const { root, homes } = setup({ '.claude/settings.json': JSON.stringify({ allowedMcpServers: allow }) })
      const d = yield* declared(root, homes)
      const items = resolve(d.entries, d.claudeAllow)
      expect(find(items, 'Claude Code', 'tldraw', 'user')?.state).toBe('blocked')
      expect(find(items, 'Claude Code', 'mytab', 'local')?.state).toBe('blocked')
      expect(find(items, 'Claude Code', 'mytab', 'repo')?.state).toBe('active')
      expect(leftovers(items, new Set()).some((r) => r.harnesses.includes('Claude Code') && r.kind === 'mcp')).toBe(
        false,
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it('reads the TOML harness configs use', () => {
    const t = parseToml(
      'top = 1\n[mcp_servers."a.b"]\nurl = "u" # comment\nenabled = false\n[compat.claude]\nmcps = false\n',
    )
    expect(t.get('mcp_servers\0a.b')).toEqual({ url: 'u', enabled: false })
    expect(t.get('compat\0claude')).toEqual({ mcps: false })
  })
})
