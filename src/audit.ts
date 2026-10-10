// `repoagents skills audit`: scan vendored skills for prompt-injection phrasing, piped remote scripts, credentials
// and invisible Unicode before agents load them. Patterns follow runkids/skillshare's audit rules in spirit.
import { Effect, FileSystem, Path } from 'effect'
import { walkFiles } from './fsx.ts'
import type { Issue } from './plan.ts'
import { SKILLS_DIR } from './repo.ts'
import { readSources } from './sources.ts'

interface Rule {
  readonly name: string
  readonly pattern: RegExp
}

const RULES: readonly Rule[] = [
  { name: 'prompt injection', pattern: /ignore (all |any )?(previous|prior|above) instructions/iu },
  { name: 'prompt injection', pattern: /disregard (the |your )?(system|previous) (prompt|instructions)/iu },
  { name: 'remote script piped to a shell', pattern: /(curl|wget)[^\n|]*\|\s*(ba|z)?sh\b/iu },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u },
  { name: 'OpenAI/Anthropic-style key', pattern: /\bsk-(ant-)?[A-Za-z0-9_-]{32,}\b/u },
  { name: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { name: 'invisible Unicode', pattern: /[​-‏‪-‮⁦-⁩﻿]/u },
]

const TEXT = /\.(md|mdx|txt|json|ya?ml|toml|sh|py|js|mjs|ts|html)$/iu

const scanText = (file: string, text: string): Issue[] =>
  text
    .split('\n')
    .flatMap((line, i) =>
      RULES.filter((rule) => rule.pattern.test(line)).map((rule) => ({ file: `${file}:${i + 1}`, problem: rule.name })),
    )

/** Findings in every vendored skill (repo-authored skills are the repo's own responsibility). */
export const skillsAudit = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const sources = yield* readSources(root)
    const issues: Issue[] = []
    for (const name of Object.keys(sources.skills)) {
      const dir = path.join(root, SKILLS_DIR, name)
      for (const rel of (yield* walkFiles(dir)).filter((f) => TEXT.test(f)))
        issues.push(...scanText(`${SKILLS_DIR}/${name}/${rel}`, yield* fs.readFileString(path.join(dir, rel))))
    }
    return issues
  })
