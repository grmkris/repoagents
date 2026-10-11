// Just enough TOML to read harness configs: `[a."b.c"]` tables with single-line `key = value` pairs (strings,
// booleans, numbers, single-line arrays and inline tables are kept as text). Multi-line values are skipped.

export type TomlTables = ReadonlyMap<string, Readonly<Record<string, unknown>>>

const ARRAY_START = /^[A-Za-z0-9_-]+\s*=\s*\[/u
const KEY_PART = /"([^"]*)"|([^.\s"]+)/gu

/** `mcp_servers."my.server"` → ['mcp_servers', 'my.server']. */
const splitKey = (key: string): string[] => [...key.matchAll(KEY_PART)].map((m) => m[1] ?? m[2] ?? '')

const value = (raw: string): unknown => {
  const text = raw.replace(/\s+#.*$/u, '').trim()
  if (text === 'true' || text === 'false') return text === 'true'
  if (text.startsWith('"') || text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text.replace(/,\s*\]$/u, ']'))
      return parsed
    } catch {
      return text
    }
  }
  return text
}

/** Open brackets minus closed ones outside strings and comments (> 0 while an array is still open). */
/** A line without its trailing ` # comment` (a `#` inside a string is kept). */
const uncomment = (line: string): string => line.replace(/\s+#[^"]*$/u, '')

const depth = (line: string): number => {
  let d = 0
  let quoted = false
  for (const ch of uncomment(line)) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '[') d += 1
    else if (!quoted && ch === ']') d -= 1
  }
  return d
}

/** The trimmed line at `start`; a multi-line array (`disabled_mcp_servers = [` … `]`) is joined into one line.
 *  Returns it with the index of the last physical line it used. */
const logicalLine = (lines: readonly string[], start: number): readonly [string, number] => {
  let line = (lines[start] ?? '').trim()
  let i = start
  while (ARRAY_START.test(line) && depth(line) > 0 && i + 1 < lines.length) {
    i += 1
    line += ` ${uncomment((lines[i] ?? '').trim())}`
  }
  return [line, i]
}

/** Tables by their dotted path joined with `\0` (`''` for the top level). */
export const parseToml = (text: string): TomlTables => {
  const tables = new Map<string, Record<string, unknown>>([['', {}]])
  let current = ''
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const [line, last] = logicalLine(lines, i)
    i = last
    const header = /^\[([^[\]]+)\]$/u.exec(line)
    if (header) {
      current = splitKey(header[1] ?? '').join('\0')
      if (!tables.has(current)) tables.set(current, {})
      continue
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u.exec(line)
    const table = tables.get(current)
    if (pair && table) table[pair[1] ?? ''] = value(pair[2] ?? '')
  }
  return tables
}

/** Direct child tables of `prefix` (e.g. every `[mcp_servers.<name>]`), by child name. */
export const childTables = (tables: TomlTables, prefix: string): Map<string, Readonly<Record<string, unknown>>> => {
  const out = new Map<string, Readonly<Record<string, unknown>>>()
  for (const [key, table] of tables) {
    const parts = key.split('\0')
    if (parts.length === 2 && parts[0] === prefix) out.set(parts[1] ?? '', table)
  }
  return out
}

export const table = (tables: TomlTables, ...path: string[]): Readonly<Record<string, unknown>> =>
  tables.get(path.join('\0')) ?? {}
