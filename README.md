# repoagents

**Repo-only agent config for Claude Code, Codex, Grok and Cursor.** One `AGENTS.md`, one `.mcp.json`, vendored skills
with provenance — committed in the repository, checked in CI, nothing installed on the machine.

```sh
bunx repoagents          # create/repair links, regenerate MCP files
bunx repoagents check    # fail on drift (CI, pre-commit)
bunx repoagents status   # what each harness really loads here, and from where
bunx repoagents doctor   # explain what each harness loads here
```

## The problem

Every coding agent reads its config from different places:

| Harness (verified)      | Instructions                                                                           | Skills                                | MCP servers                                     |
| ----------------------- | -------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| Claude Code 2.1.295     | `CLAUDE.md` (reads `AGENTS.md` only if no `CLAUDE.md` exists anywhere up the tree)     | `.claude/skills`                      | `.mcp.json`                                     |
| Codex 0.162             | `AGENTS.md`                                                                            | `.agents/skills`                      | `.codex/config.toml` (TOML, trusted repos only) |
| Grok 1.0.46             | `CLAUDE.md` only — ignores a real `AGENTS.md` and does not expand `@AGENTS.md` imports | `.agents/skills`, `.claude/skills`    | `.mcp.json`                                     |
| Cursor agent 2026.09.23 | `AGENTS.md`, `.cursor/rules`                                                           | `.agents/skills` (+ `.claude/skills`) | `.cursor/mcp.json` (`${env:VAR}`)               |

So a repository that wants all four ends up with copies that drift. Three more problems show up in practice:

1. **Vendored skills lose their origin.** You copy a skill from GitHub, tweak a sentence, and a month later nobody
   knows which upstream version it was, whether it was edited, or under which license.
2. **Machine-level config leaks in.** Skills and MCP servers installed in `~/.claude`, `~/.codex` or `~/.grok`
   apply to every repo (Grok even loads Claude's), so behaviour differs per machine and per person.
3. **Nothing tells you when it broke.** A hand edit to a generated file, a dangling link or an unrecorded skill
   edit goes unnoticed until an agent behaves oddly.

## How repoagents solves it

You edit three masters; repoagents derives the rest and fails CI when they disagree.

```
AGENTS.md                     ──► CLAUDE.md -> AGENTS.md            (symlink, also next to every nested AGENTS.md)
.agents/skills/<name>/        ──► .claude/skills/<name> -> ../../.agents/skills/<name>
.agents/skills/sources.json       provenance for vendored skills (see below)
.mcp.json                     ──► .codex/config.toml                (TOML, secrets by env var name)
                              ──► .cursor/mcp.json                  (${VAR} → ${env:VAR})
```

- `CLAUDE.md` is a **symlink**, not an `@AGENTS.md` import, because Grok sends the import line verbatim. Put a line
  at the top of `AGENTS.md` saying it is the master, so agents edit it rather than the link.
- Every MCP server is written as a full entry (Codex merges a project file field by field over the user's global
  config). Inline secrets, `${VAR:-default}` and `sse` servers are rejected because one of the targets cannot
  express them. OAuth servers are just a URL; each harness keeps its own login, so the MCP server still sees
  which client acted.
- repoagents never writes through a symlink and never overwrites a hand-written `.codex/config.toml` or a
  `CLAUDE.md` with its own content without `--force`.

### Vendored skills with provenance

Skills are copied as real files (not symlinks, not gitignored), so a fresh clone, a worktree or a read-only sandbox
works without an install step. Each one is pinned in `.agents/skills/sources.json`:

```jsonc
{
  "version": 2,
  "skills": {
    "shadcn": {
      "repository": "shadcn-ui/ui",
      "commit": "2d3f1cd…",
      "path": "skills/shadcn",
      "license": "MIT",
      "licenses": ["LICENSE.md"],
      "treeSha256": "baa5d621…", // the files as copied from upstream
      "localTreeSha256": "baa5d621…", // the directory as committed
      "unchanged": true,
    },
    "mobile-native": {
      "repository": "emilkowalski/skills",
      "commit": "e8a175d…",
      "path": "skills/mobile-native",
      "license": "MIT",
      "licenses": ["LICENSE"],
      "treeSha256": "e09d6a58…",
      "localTreeSha256": "1f4c1833…", // differs: we edited it…
      "unchanged": false,
      "adaptation": "Description narrowed to touch/mobile web; Apple specifics deferred to apple-web-app.",
      "baseCommit": "e8a175d…", // …on top of this upstream version
    },
  },
}
```

The tree hash covers every file (sorted paths + bytes), not just `SKILL.md`. The workflow:

```sh
repoagents skills add emilkowalski/skills skills/mobile-native   # fetch one dir (sparse, shallow) + its license
# edit .agents/skills/mobile-native/SKILL.md → `check` now fails: "edited since it was recorded"
repoagents skills rehash mobile-native "why it differs"          # record the adaptation
repoagents skills update --check                                 # which pins are behind upstream?
repoagents skills update                                         # re-vendor unchanged skills; adapted ones are reported
repoagents skills fanout mobile-native --to ../other-repo        # same files + same record elsewhere
repoagents skills audit                                          # prompt injection, piped scripts, keys, hidden Unicode
```

Licenses are found next to the skill, or in the nearest ancestor directory (plugin repos keep `LICENSE` beside the
plugin), and recorded as SPDX ids.

## What a repository can and cannot switch off

The repository adds config; every harness still merges the user's own on top. What `status` shows and `--isolate`
writes, verified 2026-10-10 with temporary home directories:

| Harness      | MCP precedence (first wins)                                                                       | Repo-level control (`--isolate`)                                                                                                           | Left over                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Claude Code  | `~/.claude.json` entry for this path > `.mcp.json` > user                                         | `allowedMcpServers` (by URL / exact command) + `disableClaudeAiConnectors` in `.claude/settings.json` block user, local and plugin servers | user skills and plugins; a user-scope allowlist can widen it                                                |
| Codex        | `.codex/config.toml` > `~/.codex/config.toml`                                                     | repo entries replace same-named user ones (already the case)                                                                               | other user servers and skills; `CODEX_HOME=<dir>` for a clean run                                           |
| Grok         | `.grok/config.toml` > `~/.grok/config.toml` > `~/.claude.json` > `.cursor/mcp.json` > `.mcp.json` | generated `.grok/config.toml` beats the user's config                                                                                      | servers imported from `~/.claude.json`/`~/.cursor`; `GROK_CLAUDE_MCPS_ENABLED=0 GROK_CURSOR_MCPS_ENABLED=0` |
| Cursor agent | `.cursor/mcp.json`, `~/.cursor/mcp.json`                                                          | none                                                                                                                                       | user servers                                                                                                |

Without `--isolate`, a user's Grok server named like a repository server silently wins, and a machine-local Claude
entry for the project path shadows `.mcp.json`; `status` marks both with `!`. Grok 1.0.46 reports servers from the
project `.cursor/mcp.json` as coming from `~/.cursor/mcp.json`; repoagents accounts for that.

## Install

|                          |                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ad hoc                   | `bunx repoagents`                                                                                                                                                                                                      |
| In a repo's scripts / CI | `"agents:check": "bunx repoagents@1 check"` — pins the major version, no dependency or lockfile entry                                                                                                                  |
| Without Bun              | `curl -fsSL https://raw.githubusercontent.com/grmkris/repoagents/main/install.sh \| sh` — single executable with the Bun runtime inside (linux x64/arm64 incl. musl, macOS x64/arm64, Windows x64; checksums verified) |

## Commands

| Command                                                                  | What it does                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repoagents`                                                             | Create/repair `CLAUDE.md` and skill links, regenerate MCP files, verify skills                                                                                                                                        |
| `repoagents check`                                                       | Same checks, change nothing, exit 1 on any drift or issue                                                                                                                                                             |
| `repoagents status [--live]`                                             | MCP and skills matrix per harness: repo, user, local, imported (`compat`) or bundled; overridden repo entries; machine-level leftovers. `--live` also asks Grok (`inspect --json`) and Codex (`mcp list --json`)      |
| `repoagents check --strict [--allow name…]`                              | Also fail on machine-level MCP servers, skills and plugins that load here (local use; `REPOAGENTS_ALLOW=a,b` works too). Plain `check` stays machine-independent for CI                                               |
| `repoagents --isolate`                                                   | Also write the repo-level isolation settings (see below); afterwards plain `repoagents` keeps them in step with `.mcp.json`                                                                                           |
| `repoagents doctor`                                                      | Per harness: where instructions come from (direct, fallback, through the symlink, or shadowed), skills it may load twice, MCP env vars that are not set (names only), machine-level skills that should live in a repo |
| `repoagents skills add <owner/repo> <path> [--ref] [--name] [--license]` | Vendor a skill (`.` for a repo whose root is the skill)                                                                                                                                                               |
| `repoagents skills rehash <name> [why]`                                  | Record local edits                                                                                                                                                                                                    |
| `repoagents skills verify`                                               | Offline provenance check (part of `check`)                                                                                                                                                                            |
| `repoagents skills update [--check] [name…]`                             | Compare with upstream HEAD; update unchanged skills                                                                                                                                                                   |
| `repoagents skills fanout <name…> --to <repo>`                           | Copy skills and their records to other repositories                                                                                                                                                                   |
| `repoagents skills audit`                                                | Security scan of vendored skills                                                                                                                                                                                      |

Global flags: `--cwd <dir>`, `--force`, `--json`, `--quiet`. Exit codes: 0 ok, 1 issues/drift, 2 usage, 3 upstream
(git/network), 4 invalid file, 5 unsafe write.

Trust is per machine and cannot be committed: approve the repository once in each harness (Claude's trust
dialog, Codex's trust prompt, `grok --trust`, `cursor-agent --trust`) and log in to OAuth MCP servers once per tool.

## Compared with other tools

|                                                   | repoagents                                 | [rulesync](https://github.com/dyoshikawa/rulesync) | [skillshare](https://github.com/runkids/skillshare) | [dotagents](https://github.com/getsentry/dotagents) | [`npx skills`](https://github.com/vercel-labs/skills) | [apm](https://github.com/microsoft/apm) |
| ------------------------------------------------- | ------------------------------------------ | -------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| Source of truth                                   | `AGENTS.md`, `.agents/skills`, `.mcp.json` | `.rulesync/`                                       | global `~/.config/skillshare` or `.skillshare/`     | `agents.toml`                                       | lock file                                             | `apm.yml`                               |
| Machine state                                     | none                                       | none                                               | yes (`~/.local/state`)                              | yes                                                 | no                                                    | cache                                   |
| Upstream skills committed as real files           | ✅                                         | ✅ (generated)                                     | ❌ gitignored, restored on install                  | ❌ symlinked/gitignored                             | optional                                              | ✅                                      |
| Hash of the committed copy + recorded adaptations | ✅                                         | ❌                                                 | ❌ (`update --force` discards edits)                | ❌                                                  | ❌                                                    | ❌                                      |
| License recorded                                  | ✅                                         | ❌                                                 | shown only                                          | ❌                                                  | ❌                                                    | ✅                                      |
| MCP generation                                    | 3 harnesses                                | many                                               | 22 clients                                          | yes                                                 | ❌                                                    | yes                                     |
| Harnesses                                         | 4 (verified)                               | 20+                                                | 80                                                  | several                                             | many                                                  | several                                 |
| CI drift check                                    | `check`                                    | `generate --check`                                 | ❌                                                  | ❌                                                  | `check` (skills)                                      | `audit`                                 |

When to use something else:

- **rulesync** if you want one generator for many harnesses and are fine with `.rulesync/` as the source instead of
  `AGENTS.md`.
- **skillshare** if you want one personal skill library synced to many tools across machines (global first), with a
  UI.
- **apm** for organisation-wide package management with governance and SBOMs.
- **`npx skills`** to install a skill quickly where provenance does not matter.

repoagents is for the narrower case: everything in the repository, the same result on every machine and in CI,
and an honest record of which upstream skill you copied and how you changed it.

## Limitations

- `status` reads config files; `--live` cross-checks Grok and Codex only (Claude and Cursor print text with slow
  health checks). Skill precedence between directories is not verified, so `status` lists every copy.
- Four harnesses, each verified on the version in the table; behaviour changes upstream (it moves fast) and the
  table is updated when re-verified. Cursor's handling of a skill present in both `.agents/skills` and
  `.claude/skills` is not verified yet (`doctor` mentions it).
- Bun is required for `bunx`; the release binaries include it.
- Adapted skills are never merged automatically: `skills update` reports them and you re-apply upstream changes.

## Development

```sh
bun install
bun run check   # format, type-aware lint (oxlint + anti-slop), typecheck, Effect diagnostics, knip, tests, build, self-check
```

Effect v4 (`effect/cli`), Bun, Vitest with `@effect/vitest`. See [AGENTS.md](AGENTS.md).

MIT © Kristjan Grm
