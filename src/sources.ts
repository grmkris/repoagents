// `.agents/skills/sources.json` (v2): read, write, tree hashes and license detection.
import { Crypto, Effect, FileSystem, Option, Path, Schema } from 'effect'
import { InvalidFile } from './errors.ts'
import { readTextOption, walkFiles } from './fsx.ts'
import { SOURCES_FILE } from './repo.ts'
import { type SourcesFile, SourcesFile as SourcesSchema } from './schema.ts'

export const LICENSE_RE = /^(LICENSE|LICENCE|COPYING|NOTICE)(\.[a-z]+)?$/iu

const encoder = new TextEncoder()
const NUL = new Uint8Array([0])

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/** sha256 over sorted relative paths and bytes: `path \0 bytes \0` per file (vercel-labs/skills' folder hash idea). */
export const treeHash = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const parts: Uint8Array[] = []
    for (const rel of yield* walkFiles(dir))
      parts.push(encoder.encode(rel), NUL, yield* fs.readFile(path.join(dir, rel)), NUL)
    return hex(yield* crypto.digest('SHA-256', concat(parts)))
  })

const decodeSources = Schema.decodeUnknownEffect(Schema.fromJsonString(SourcesSchema))

/** The repository's sources.json; an empty v2 file when there is none. */
export const readSources = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const raw = yield* readTextOption(path.join(root, SOURCES_FILE))
    if (Option.isNone(raw)) return { version: 2, skills: {} } satisfies SourcesFile
    return yield* decodeSources(raw.value).pipe(
      Effect.mapError((e) => new InvalidFile({ file: SOURCES_FILE, reason: e.message })),
    )
  })

/** Writes sources.json with skills sorted by name (stable diffs). */
export const writeSources = (root: string, sources: SourcesFile) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const skills = Object.fromEntries(Object.entries(sources.skills).toSorted(([a], [b]) => a.localeCompare(b)))
    yield* fs.makeDirectory(path.join(root, '.agents/skills'), { recursive: true })
    yield* fs.writeFileString(path.join(root, SOURCES_FILE), `${JSON.stringify({ version: 2, skills }, null, 2)}\n`)
  })

/** SPDX id guessed from license text. */
export const detectLicense = (text: string): string => {
  if (/Apache License[\s\S]*Version 2\.0/iu.test(text)) return 'Apache-2.0'
  if (/Attribution-ShareAlike 4\.0/iu.test(text)) return 'CC-BY-SA-4.0'
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/iu.test(text)) return 'AGPL-3.0'
  if (/Permission is hereby granted, free of charge/iu.test(text)) return 'MIT'
  if (/BSD/u.test(text)) return 'BSD'
  return 'UNKNOWN'
}
