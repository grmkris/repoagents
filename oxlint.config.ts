import { defineConfig } from 'oxlint'

/**
 * Lint rules, all at error (the same stack as grmkris/goblin): type-aware oxlint, the vendored anti-slop plugins
 * (tools/oxlint/anti-slop/PROVENANCE.md) and cognitive complexity. Relaxations are targeted overrides with reasons.
 */
export default defineConfig({
  ignorePatterns: [
    'ref/**',
    'dist/**',
    'tools/oxlint/anti-slop/**',
    '.agents/skills/**',
    '.claude/skills/**',
    '.codex/**',
  ],
  options: { typeAware: true, reportUnusedDisableDirectives: 'error' },
  jsPlugins: [
    './tools/oxlint/anti-slop/index.ts',
    './tools/oxlint/anti-slop/effect/index.ts',
    'oxlint-plugin-complexity',
  ],
  categories: { correctness: 'error', suspicious: 'error' },
  plugins: ['typescript', 'unicorn', 'oxc', 'import'],
  env: { es2024: true },
  rules: {
    'import/no-unassigned-import': 'off',
    'typescript/no-explicit-any': 'error',
    'no-unused-vars': [
      'error',
      { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
    'typescript/no-misused-promises': 'error',
    'typescript/switch-exhaustiveness-check': 'error',
    'typescript/only-throw-error': 'error',
    'typescript/no-deprecated': 'error',
    'typescript/ban-ts-comment': [
      'error',
      { 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 10 },
    ],
    // Replaced by anti-slop's SAFETY-comment rule: an assertion is allowed when it states its invariant.
    'typescript/no-unsafe-type-assertion': 'off',
    // Off: it flags Effect's `return yield* Effect.fail(...)`, which Effect's missingReturnYieldStar requires.
    'typescript/consistent-return': 'off',
    'anti-slop/require-safety-comment-for-type-assertion': 'error',
    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop-effect/no-manual-tag-comparison': 'error',
    'anti-slop-effect/no-manual-effect-error-tag': 'error',
    'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
    'max-depth': ['error', 4],
    'max-params': ['error', 5],
    'complexity/complexity': ['error', { cyclomatic: 1000, cognitive: 15 }],
  },
  overrides: [
    {
      // Tests describe behaviour in long, flat scenarios.
      files: ['test/**'],
      rules: { 'max-lines-per-function': 'off', 'max-lines': 'off' },
    },
  ],
})
