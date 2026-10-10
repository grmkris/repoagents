// `repoagents skills …`: vendor upstream skills with provenance, record local adaptations, verify, update and fan out.
import { Effect, FileSystem, Path } from 'effect'
import { UsageError } from './errors.ts'
import { copyTree, exists, listDir } from './fsx.ts'
import { fetchInto, remoteHead } from './git.ts'
import type { Issue } from './plan.ts'
import { SKILLS_DIR } from './repo.ts'
import type { SkillSource } from './schema.ts'
import { detectLicense, LICENSE_RE, readSources, treeHash, writeSources } from './sources.ts'

const LICENSE_SKIP: ReadonlySet<string> = new Set(['.git'])

/** Copies `path` of an upstream checkout into `dest`; adds the nearest ancestor license when the skill has none. */
const copySkill = (checkout: string, path: string, dest: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const p = yield* Path.Path
    const src = path === '.' ? checkout : p.join(checkout, path)
    if (!(yield* exists(p.join(src, 'SKILL.md'))))
      return yield* new UsageError({ message: `${path}/SKILL.md not found upstream` })
    yield* fs.remove(dest, { recursive: true, force: true })
    yield* copyTree(src, dest, LICENSE_SKIP)
    const parts = path === '.' ? [] : path.split('/').slice(0, -1)
    let licenses = (yield* listDir(dest)).filter((f) => LICENSE_RE.test(f))
    for (let i = parts.length; licenses.length === 0 && i >= 0; i--) {
      const at = p.join(checkout, ...parts.slice(0, i))
      for (const f of (yield* listDir(at)).filter((n) => LICENSE_RE.test(n)))
        yield* fs.copyFile(p.join(at, f), p.join(dest, f))
      licenses = (yield* listDir(dest)).filter((f) => LICENSE_RE.test(f))
    }
    const texts = yield* Effect.forEach(licenses, (f) => fs.readFileString(p.join(dest, f)))
    return { licenses, license: licenses.length > 0 ? detectLicense(texts.join('\n')) : 'UNKNOWN' }
  })

/** Fetches upstream into a scoped temp dir, copies the skill to `dest` and returns its provenance entry. */
const vendor = (repository: string, path: string, ref: string, dest: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'repoagents-' })
      const commit = yield* fetchInto(repository, path, ref, tmp)
      const lic = yield* copySkill(tmp, path, dest)
      const hash = yield* treeHash(dest)
      return {
        repository,
        commit,
        path,
        ...lic,
        treeSha256: hash,
        localTreeSha256: hash,
        unchanged: true,
      } satisfies SkillSource
    }),
  )

export interface AddOptions {
  readonly ref?: string | undefined
  readonly name?: string | undefined
  readonly license?: string | undefined
}

export const skillsAdd = (root: string, repository: string, path: string, options: AddOptions = {}) =>
  Effect.gen(function* () {
    const p = yield* Path.Path
    const name =
      options.name ?? (path === '.' ? (repository.split('/').pop() ?? repository) : (path.split('/').pop() ?? path))
    const entry = yield* vendor(repository, path, options.ref ?? 'HEAD', p.join(root, SKILLS_DIR, name))
    const withLicense = options.license === undefined ? entry : { ...entry, license: options.license }
    const sources = yield* readSources(root)
    yield* writeSources(root, { version: 2, skills: { ...sources.skills, [name]: withLicense } })
    return { name, entry: withLicense }
  })

/** Records local edits: new local hash, adapted flag, reason and base commit (or back to unchanged). */
export const skillsRehash = (root: string, name: string, adaptation: string | undefined) =>
  Effect.gen(function* () {
    const p = yield* Path.Path
    const sources = yield* readSources(root)
    const e = sources.skills[name]
    if (e === undefined) return yield* new UsageError({ message: `${name} is not in sources.json` })
    const local = yield* treeHash(p.join(root, SKILLS_DIR, name))
    const reason = adaptation ?? e.adaptation
    if (local !== e.treeSha256 && reason === undefined)
      return yield* new UsageError({
        message: `${name} differs from upstream: say why (skills rehash ${name} "<why>")`,
      })
    const { adaptation: _a, baseCommit: _b, ...base } = e
    const next: SkillSource =
      local === e.treeSha256
        ? { ...base, localTreeSha256: local, unchanged: true }
        : { ...base, localTreeSha256: local, unchanged: false, adaptation: reason ?? '', baseCommit: e.commit }
    yield* writeSources(root, { version: 2, skills: { ...sources.skills, [name]: next } })
    return next
  })

const verifyEntry = (root: string, name: string, e: SkillSource) =>
  Effect.gen(function* () {
    const p = yield* Path.Path
    const dir = p.join(root, SKILLS_DIR, name)
    const file = `${SKILLS_DIR}/${name}`
    if (!(yield* exists(p.join(dir, 'SKILL.md')))) return [{ file, problem: 'listed in sources.json but missing' }]
    const issues: Issue[] = []
    for (const l of e.licenses)
      if (!(yield* exists(p.join(dir, l)))) issues.push({ file, problem: `license file ${l} missing` })
    if (e.licenses.length === 0) issues.push({ file, problem: 'no license file vendored' })
    if ((yield* treeHash(dir)) !== e.localTreeSha256)
      issues.push({ file, problem: `edited since it was recorded; run: repoagents skills rehash ${name} "<why>"` })
    if (e.unchanged && e.localTreeSha256 !== e.treeSha256)
      issues.push({ file, problem: 'marked unchanged but differs from upstream' })
    if (!e.unchanged && (e.adaptation ?? '') === '')
      issues.push({ file, problem: 'adapted without an adaptation note' })
    return issues
  })

/** Offline checks of every vendored skill (also part of `check`). */
export const skillsVerify = (root: string) =>
  Effect.gen(function* () {
    const sources = yield* readSources(root)
    const all = yield* Effect.forEach(Object.entries(sources.skills), ([name, e]) => verifyEntry(root, name, e))
    return all.flat()
  })

type UpdateStatus = 'current' | 'moved' | 'outdated' | 'updated' | 'adapted'

interface UpdateResult {
  readonly name: string
  readonly status: UpdateStatus
  readonly from: string
  readonly to: string
}

const result = (name: string, status: UpdateStatus, from: string, to: string): UpdateResult => ({
  name,
  status,
  from,
  to,
})

const upstreamCopyHash = (e: SkillSource, head: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const p = yield* Path.Path
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: 'repoagents-' })
      const out = yield* fs.makeTempDirectoryScoped({ prefix: 'repoagents-copy-' })
      yield* fetchInto(e.repository, e.path, head, tmp)
      yield* copySkill(tmp, e.path, p.join(out, 'skill'))
      return yield* treeHash(p.join(out, 'skill'))
    }),
  )

const updateOne = (root: string, name: string, e: SkillSource, apply: boolean) =>
  Effect.gen(function* () {
    const head = yield* remoteHead(e.repository, root)
    if (head === e.commit) return result(name, 'current', e.commit, head)
    const upstream = yield* upstreamCopyHash(e, head)
    if (upstream === e.treeSha256) {
      if (apply) {
        const sources = yield* readSources(root)
        yield* writeSources(root, { version: 2, skills: { ...sources.skills, [name]: { ...e, commit: head } } })
      }
      return result(name, 'moved', e.commit, head)
    }
    if (!apply) return result(name, 'outdated', e.commit, head)
    if (!e.unchanged) return result(name, 'adapted', e.commit, head)
    yield* skillsAdd(root, e.repository, e.path, { ref: head, name, license: e.license })
    return result(name, 'updated', e.commit, head)
  })

/** Compares pins with upstream HEAD; with apply, re-vendors unchanged skills (adapted ones are only reported). */
export const skillsUpdate = (root: string, only: readonly string[], apply: boolean) =>
  Effect.gen(function* () {
    const sources = yield* readSources(root)
    const entries = Object.entries(sources.skills).filter(([n]) => only.length === 0 || only.includes(n))
    return yield* Effect.forEach(entries, ([name, e]) => updateOne(root, name, e, apply))
  })

/** Copies skill dirs and their entries from `root` into other repositories. */
export const skillsFanout = (root: string, names: readonly string[], targets: readonly string[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const p = yield* Path.Path
    const sources = yield* readSources(root)
    for (const target of targets) {
      const t = yield* readSources(target)
      const skills = { ...t.skills }
      for (const name of names) {
        const src = p.join(root, SKILLS_DIR, name)
        if (!(yield* exists(p.join(src, 'SKILL.md'))))
          return yield* new UsageError({ message: `${name} not found in ${root}` })
        const dest = p.join(target, SKILLS_DIR, name)
        yield* fs.remove(dest, { recursive: true, force: true })
        yield* copyTree(src, dest)
        const entry = sources.skills[name]
        if (entry === undefined) delete skills[name]
        else skills[name] = entry
      }
      yield* writeSources(target, { version: 2, skills })
    }
  })
