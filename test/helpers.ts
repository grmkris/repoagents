// Fixtures: temporary repositories on disk and a local "upstream" git repository to vendor skills from.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { Layer } from 'effect'
import { GitLive } from '../src/git.ts'
import { CliLive } from '../src/inventory/live.ts'

export const TestLayer = Layer.mergeAll(GitLive, CliLive).pipe(Layer.provideMerge(NodeServices.layer))

export const fixture = (files: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(join(tmpdir(), 'repoagents-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

export const sh = (cwd: string, ...args: string[]): string =>
  execFileSync(args[0] ?? 'true', args.slice(1), { cwd, encoding: 'utf8' }).trim()

const commit = (dir: string, message: string): void => {
  sh(dir, 'git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.')
  sh(dir, 'git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message)
}

/** An upstream repo with `skills/demo` (SKILL.md + references/a.md) and a root MIT LICENSE. */
export const upstream = (): string => {
  const dir = fixture({
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo skill for tests.\n---\nv1\n',
    'skills/demo/references/a.md': 'ref\n',
    LICENSE: 'MIT License\n\nPermission is hereby granted, free of charge, to any person\n',
  })
  sh(dir, 'git', 'init', '-q')
  commit(dir, 'v1')
  sh(dir, 'git', 'config', 'uploadpack.allowFilter', 'true')
  sh(dir, 'git', 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  return dir
}

export const bumpUpstream = (dir: string): string => {
  writeFileSync(join(dir, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: Demo skill for tests.\n---\nv2\n')
  commit(dir, 'v2')
  return sh(dir, 'git', 'rev-parse', 'HEAD')
}
