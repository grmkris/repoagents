import { defineConfig } from 'oxfmt'

export default defineConfig({
  singleQuote: true,
  semi: false,
  printWidth: 120,
  ignorePatterns: [
    'ref/**',
    'dist/**',
    'bun.lock',
    'tools/oxlint/anti-slop/**',
    '.agents/skills/**',
    '.claude/skills/**',
    '.codex/**',
    '.cursor/mcp.json',
  ],
})
