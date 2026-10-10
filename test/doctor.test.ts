import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { doctor } from '../src/doctor.ts'
import { fixture, TestLayer } from './helpers.ts'

describe('doctor', () => {
  it.effect('explains a shadowed AGENTS.md and Cursor double-loading linked skills', () =>
    Effect.gen(function* () {
      const root = fixture({ 'AGENTS.md': '# A\n', 'CLAUDE.md': '# own rules\n', '.agents/skills/x/SKILL.md': 'x' })
      mkdirSync(join(root, '.claude/skills'), { recursive: true })
      symlinkSync('../../.agents/skills/x', join(root, '.claude/skills/x'))
      const findings = yield* doctor(root)
      expect(findings.find((f) => f.topic === 'Grok')?.message).toContain('shadowed')
      expect(
        findings.some((f) => f.topic === 'Cursor agent' && f.level === 'info' && f.message.includes('unverified')),
      ).toBe(true)
      expect(findings.find((f) => f.topic === 'Codex')?.message).toBe('reads AGENTS.md')
    }).pipe(Effect.provide(TestLayer)),
  )
})
