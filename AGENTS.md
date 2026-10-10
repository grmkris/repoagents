# repoagents: instructions for coding agents

Master file. `CLAUDE.md` is a symlink to it — edit `AGENTS.md`. This repository uses itself: `bun run agents:check`
runs `repoagents check` on it.

repoagents keeps one repository's agent config consistent for Claude Code, Codex, Grok and Cursor. Read
[README.md](README.md) for what it does and why.

## Stack

- Bun 1.4 (`.bun-version`), Effect 4.0.1 (pinned exactly; `effect/cli` is marked unstable, the pin is the
  stability boundary), `@effect/platform-bun` in `src/main.ts`, `@effect/platform-node` in tests (Vitest runs on Node).
- Modules: `cli.ts` (command tree, thin handlers), `plan.ts` (sync/check), `render.ts` (pure MCP renderers),
  `skills.ts` + `sources.ts` (vendored skills, sources.json v2), `doctor.ts`, `audit.ts`, `git.ts` (Git service),
  `harnesses.ts` (what each harness reads — update it with the version you verified), `inventory/` (probes read
  repo + home config, `merge.ts` resolves precedence purely, `live.ts` asks harnesses), `status.ts`, `toml.ts`.
- Re-verify precedence with temporary home directories (never a real one) before changing ranks in
  `inventory/probes.ts`.

## Rules

- Effect everywhere in `src/`: FileSystem/Path/Crypto services, no `node:*` imports, no `process.env` (use Config),
  tagged errors (`errors.ts`) mapped to exit codes in `main.ts`.
- Keep `.agents/skills/sources.json` v2 backward compatible: repositories already carry it.
- Every behaviour change gets a test in `test/` (fixture repos on disk, local git upstreams; no network).
- `bun run check` must pass before a commit: format, lint (type-aware oxlint + anti-slop), typecheck, Effect
  diagnostics, knip, tests, build, self-check.
- Releases: bump `package.json` version, tag `vX.Y.Z`; `.github/workflows/release.yml` publishes npm + binaries.
