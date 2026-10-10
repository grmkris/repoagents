// Compiles single-file executables (Bun runtime included) for every release target, plus SHA256SUMS.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const TARGETS = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-linux-x64-musl',
  'bun-linux-arm64-musl',
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-windows-x64',
] as const

const only = process.argv.slice(2)
const sums: string[] = []
for (const target of TARGETS.filter((t) => only.length === 0 || only.includes(t))) {
  const name = `repoagents-${target.replace(/^bun-/u, '')}${target.includes('windows') ? '.exe' : ''}`
  const out = `dist/bin/${name}`
  const proc = Bun.spawnSync(
    ['bun', 'build', 'src/main.ts', '--compile', '--minify', `--target=${target}`, '--outfile', out],
    { stdout: 'inherit', stderr: 'inherit' },
  )
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1)
  // Bun's embedded signature is rejected by recent macOS (the binary is SIGKILLed); an ad-hoc re-sign fixes it.
  // Darwin binaries are therefore built on macOS (release.yml) where codesign exists.
  if (target.includes('darwin') && process.platform === 'darwin') {
    const sign = Bun.spawnSync(['codesign', '--force', '--sign', '-', out], { stdout: 'inherit', stderr: 'inherit' })
    if (sign.exitCode !== 0) process.exit(sign.exitCode ?? 1)
  }
  sums.push(`${createHash('sha256').update(readFileSync(out)).digest('hex')}  ${name}`)
}
writeFileSync('dist/bin/SHA256SUMS', `${sums.join('\n')}\n`)
console.log(sums.join('\n'))
