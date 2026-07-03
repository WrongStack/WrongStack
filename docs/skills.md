# Skill Writing Guide

Skills are Markdown files that inject domain-specific knowledge into the agent's system prompt. They activate automatically when the agent detects a matching context — no code required.

---

## Quick start

```
<project>/.wrongstack/skills/
  my-skill/
    SKILL.md        ← this is the only required file
```

A skill is a directory containing a `SKILL.md` file with YAML frontmatter. That's it.

```markdown
---
name: my-skill
description: |
  One-sentence summary of what this skill covers and when to activate it.
  The agent reads this description to decide whether the skill is relevant.
version: 1.0.0
---

# My Skill

Body content injected into the system prompt when the skill activates.
Keep it concise, actionable, and focused on one domain.
```

---

## File format

### Frontmatter (required)

| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Unique identifier. Lowercase letters, digits, hyphens; must match the parent directory (agentskills.io). First-seen wins on collisions across layers. |
| `description` | ✅ | One-sentence trigger summary. The agent uses this to decide relevance. |
| `version` | ❌ | SemVer string. Informational only — not used for comparison. |
| `license` | ❌ | License name or bundled license file (agentskills.io). |
| `compatibility` | ❌ | Environment requirements — intended product, system packages, network (agentskills.io). |
| `metadata` | ❌ | Arbitrary key-value map. |
| `allowed-tools` | ❌ | Space-separated pre-approved tools (experimental, agentskills.io). |

### Body (required)

Everything after the frontmatter delimiter (`---`) is the skill content. This is injected verbatim into the system prompt when the skill is active. Keep it under 2000 tokens — the system prompt has a budget.

---

## Discovery

Skills are discovered at boot across the layers below. The first layer with a given `name` wins — `.wrongstack` skills shadow foreign and bundled ones.

| Priority | Location | Scope | Use case |
|---|---|---|---|
| 1 (highest) | `<project>/.wrongstack/skills/` | Per-project, committed to git | Repo-specific conventions, build system quirks, team standards |
| 2 | `<project>/.claude/skills/` | Per-project, foreign (read-only) | Skills authored for Claude Code |
| 3 | `<project>/.{codex,cursor,agents,gemini,qwen,trae,windsurf}/skills/` | Per-project, foreign (read-only) | Skills authored for other coding agents (Cursor uses `skills-cursor`) |
| 4 | `~/.wrongstack/skills/` | Per-user, not committed | Personal preferences, cross-project habits |
| 5 | `~/.claude/skills/` | Per-user, foreign (read-only) | Your Claude Code user-level skills |
| 6 | `~/.{codex,cursor,agents,gemini,qwen,trae,windsurf}/skills/` | Per-user, foreign (read-only) | Your skills in other coding agents |
| 7 | `config.skills.extraDirs` | User-config only | Any extra directory (stripped from in-project config) |
| 8 (lowest) | Bundled with `@wrongstack/core` | Ships with the package | General-purpose skills (git-flow, bug-hunter, etc.) |

### Directory structure

```
<skill-name>/
  SKILL.md            ← required: metadata + instructions
  scripts/            ← optional: executable code (the agent runs via bash)
  references/         ← optional: docs loaded on demand (REFERENCE.md, …)
  assets/             ← optional: templates, data, snippets
  …                   ← any other files/subdirectories
```

The loader discovers a skill by its `SKILL.md`; the other files are **bundled resources** the agent loads on demand via the `skill` tool (see [Progressive disclosure](#progressive-disclosure--the-skill-tool)). Keep `SKILL.md` under ~500 lines and move deep material into `references/`.

---

## Cross-agent compatibility (`.claude/skills` + other agents)

WrongStack reads skills authored for other coding agents **natively** — no copying required. Every agent below uses the same [agentskills.io](https://agentskills.io/specification) `SKILL.md` format, so WrongStack discovers and injects them just like a native skill:

| Tool | User dir | Project dir |
|---|---|---|
| Claude Code | `~/.claude/skills` | `<project>/.claude/skills` |
| OpenAI Codex | `~/.codex/skills` | `<project>/.codex/skills` |
| Cursor | `~/.cursor/skills-cursor` | `<project>/.cursor/skills-cursor` |
| Gemini CLI | `~/.gemini/skills` | `<project>/.gemini/skills` |
| Qwen Code | `~/.qwen/skills` | `<project>/.qwen/skills` |
| Trae | `~/.trae/skills` | `<project>/.trae/skills` |
| Windsurf | `~/.windsurf/skills` | `<project>/.windsurf/skills` |
| Shared (`asm` / agentskills.io) | `~/.agents/skills` | `<project>/.agents/skills` |

All foreign layers are **read-only** — the installer never writes there. To edit or commit a foreign skill, import it with `/skill-import` (below). A skill discovered earlier in the priority order shadows a same-named one discovered later, so `.wrongstack` always wins over foreign; and deduplication is by name, so the same skill symlinked into several agent dirs appears once.

Control which foreign tools are scanned with `skills.foreignSources` (default: all known tools) and `skills.readClaudeSkills` (default: `true`).

## Configuration (`config.skills`)

| Field | Default | Description |
|---|---|---|
| `readClaudeSkills` | `true` | Read the `.claude/skills/` layers (project + user). |
| `foreignSources` | `true` (all) | Scan other agents' skill dirs (`~/.codex/skills`, `~/.cursor/skills-cursor`, `~/.agents/skills`, …). Pass a tool-id list to restrict, or `false` to disable. |
| `mode` | `'eager'` | `'eager'` injects every skill body into the prompt; `'progressive'` injects only a name+trigger manifest (the agent loads bodies via the `skill` tool). |
| `eagerMaxChars` | `24000` | In eager mode, the total chars of skill bodies injected (highest-priority first); the rest become a load-on-demand manifest. Bounds prompt cost when many skills are discovered. Ignored in progressive mode. |
| `extraDirs` | `[]` | Extra directories to scan (lowest priority). **User config only** — stripped from a repo-committed `<project>/.wrongstack/config.json`. |

## Progressive disclosure & the `skill` tool

By default (`mode: 'eager'`) every discovered skill body is injected into the system prompt. Set `skills.mode: 'progressive'` to follow the agentskills.io three-tier model instead: the prompt carries only each skill's name + trigger, and the agent calls the **`skill`** tool to load a skill's full body on demand.

The `skill` tool also handles **bundled resources** (tier 3) — scripts, references, assets, any subdirectory:

- `skill({ name: "docker-deploy" })` → the SKILL.md body + a recursive listing of every bundled file.
- `skill({ name: "docker-deploy", resource: "references/COMPOSE.md" })` → that file's content.
- Scripts come back with an absolute path; the agent runs them via `bash`.

Use the `skill` tool (not `read`) for skill resources: it works for foreign skills that live outside the project root (`~/.claude/skills/…`, `~/.cursor/skills-cursor/…`), which a project-root-restricted `read` tool may refuse.

```jsonc
// ~/.wrongstack/config.json
{ "skills": { "mode": "progressive" } }
```

## Importing skills (`/skill-import`)

Foreign skills are usable as-is, but to **own, edit, or commit** one, import it into `.wrongstack/skills/`:

```
/skill-import --from cursor             # copy project .cursor/skills-cursor → .wrongstack/skills
/skill-import --from codex --global     # copy ~/.codex/skills
/skill-import --from claude             # copy project .claude/skills (--from-claude alias)
/skill-import /abs/path/to/skills       # copy from any directory
/skill-import --from trae --link        # symlink instead of copy (falls back to copy on Windows w/o Dev Mode)
```

`--from <tool>` resolves each agent's skill dir automatically (cursor's `skills-cursor` included). Known tools: `claude`, `agents`, `codex`, `gemini`, `cursor`, `qwen`, `trae`, `windsurf`.

---

## Bundled skills

WrongStack ships with 23 bundled skills:

| Skill | Description |
|---|---|
| `api-design` | REST API design, error codes, pagination, auth patterns |
| `audit-log` | Session log parsing, anomaly detection, cost and tool usage analysis |
| `bug-hunter` | Systematic bug and code smell detection, severity ranking |
| `chimera` | Post-session code quality review of changed files |
| `docker-deploy` | Docker containerization, multi-stage builds, image scanning |
| `git-flow` | Commit message style, branch hygiene, safe history operations |
| `mailbox-bridge` | Loopback HTTP bridge that exposes the project's shared WrongStack mailbox so external agents (Claude Code, Aider, scripts) can read, send, and acknowledge messages |
| `multi-agent` | Leader/worker roles, task delegation, result aggregation, fleet management |
| `node-modern` | Node.js ≥ 22 idioms: ESM-only, native fetch, AbortSignal patterns |
| `observability` | Structured logging, traces, metrics, redaction, instrumentation |
| `output-standards` | Output formatting standards, `<next_steps>` conventions |
| `plugin-author` | Creating, reviewing, or refactoring a WrongStack plugin |
| `prompt-engineering` | System prompt design, tool descriptions, trigger sentences |
| `react-modern` | React 19+ Server Components, useTransition, Suspense, the `use` hook |
| `refactor-planner` | Dependency mapping, risk assessment, phased planning, migration strategy |
| `research-web` | Web research methodology — disciplined search + fetch workflow, source validation, cross-referencing, structured context-manager injection |
| `wrongstack-mailbox` | External-facing client for the project's shared WrongStack mailbox — register as an online agent, read messages, send replies, broadcast, and stay visible in the WebUI fleet |
| `sdd` | Spec parsing, task graph generation, dependency tracking, done-condition execution |
| `security-scanner` | Code and configuration security vulnerability scanning |
| `skill-creator` | Guide to creating new WrongStack skills with YAML frontmatter |
| `tech-stack` | Package version validation, ecosystem preference maps, dead-package detection |
| `testing` | vitest patterns, mocking, coverage, unit/integration/e2e test strategy |
| `typescript-strict` | Strict null checks, exhaustive switch, branded types, discriminated unions |

Override any bundled skill by creating a project- or user-level skill with the same `name`.

---

## Roster roles vs. skills

A skill is a passive Markdown file. A **roster role** is a TypeScript subagent definition. They reach the agent through completely different paths, which is why some names you'll see in the CLI — most notably `shadow-agent` — never appear in the bundled-skills table above.

| | Skill | Roster role |
|---|---|---|
| What it is | `SKILL.md` with YAML frontmatter | TypeScript `SubagentConfig` object |
| Where it lives | `packages/core/skills/<name>/SKILL.md` (or `~/.wrongstack/skills/`, `<project>/.wrongstack/skills/`) | `packages/core/src/coordination/fleet.ts` (or related agent modules) |
| How it reaches the agent | Injected into the system prompt via `DefaultSkillLoader` when `DefaultSystemPromptBuilder` builds the prompt | Spawned via `spawn_subagent { role: '<id>' }` and runs in its own context/budget |
| Who maintains it | Humans (with AI assistance via `/skill-gen`) | WrongStack core team — compiled into the binary |
| Listed in `/skill` | Yes | No |
| Listed in `fleet (action: status)` | No | Yes |

### Example: `shadow-agent`

`shadow-agent` is a roster role, not a skill. Its definition lives at `packages/core/src/coordination/agents/shadow-agent-role.ts` as `export const SHADOW_AGENT: SubagentConfig = { id: 'shadow-agent', role: 'shadow-agent', ... }`. The roster catalog in `packages/core/src/coordination/fleet.ts` registers it under the key `'shadow-agent'`. You start it with:

```
spawn_subagent { role: 'shadow-agent', task: '...', maxIterations: 12 }
```

If you have ever seen a file at `<project>/.wrongstack/skills/shadow-agent/SKILL.md`, that is a **runtime side-effect** — the shadow agent writes its own SKILL.md to disk while it runs so its prompt survives session restarts. It is not how the role is *defined*; it is how the role is *persisted*. The actual source of truth is the `SHADOW_AGENT` constant in `agents/shadow-agent-role.ts`.

Other roster roles follow the same pattern (see `packages/core/src/coordination/agents/`). If you're looking for "how do I make the agent smarter about X", you almost always want to write a skill. If you're looking for "how do I spawn a specialized subagent that runs X", you want a roster role.

---

## Writing effective skills

### Description quality

The `description` field is the trigger. The agent reads it to decide whether the skill is relevant to the current task. Make it:

- **Specific**: "Use this skill when writing or reviewing React 19+ code" ✅
- **Not too broad**: "General programming help" ❌
- **Action-oriented**: "Use when proposing, creating, or reviewing git commits" ✅
- **Scope-limited**: Include what the skill does NOT cover if there's ambiguity

### Body structure

```markdown
---
name: example
description: |
  Use this skill when doing X. Covers Y and Z.
version: 1.0.0
---

# Title

One-line summary of the skill's purpose.

## Section 1 — Domain rules

- Rule 1
- Rule 2
- Rule 3

## Section 2 — Patterns

| Pattern | When to use | Example |
|---|---|---|
| A | When X | `code example` |
| B | When Y | `code example` |

## Anti-patterns

- Don't do X because Y.
- Avoid Z — it causes W.
```

### Token budget

The system prompt has a finite context window. Skills that are too long will be truncated or will crowd out other important context. Guidelines:

- **Target**: 200–800 tokens per skill
- **Hard limit**: ~2000 tokens (the loader doesn't enforce this, but the compactor will trim)
- **Tip**: Use tables and bullet points over prose. Code examples should be minimal — show the pattern, not the full implementation.

### Common mistakes

| Mistake | Why it's bad | Fix |
|---|---|---|
| Too broad description | Activates on irrelevant tasks, wastes context | Narrow the trigger to specific scenarios |
| No examples | Agent can't infer the pattern from rules alone | Add at least one concrete code example |
| Too long | Crowds out other skills and user messages | Split into multiple focused skills |
| Duplicate name | Shadows the other skill silently | Use unique, descriptive names |
| No anti-patterns | Agent may apply the skill incorrectly | List what NOT to do |

---

## Viewing discovered skills

```bash
# CLI subcommand
wrongstack skills

# Slash command (in REPL/TUI)
/skill
```

Both show the skill name, source layer (project / user / bundled), and description.

---

## Example: Project-specific skill

```markdown
---
name: acme-conventions
description: |
  Use this skill when writing or modifying code in the acme-web repository.
  Covers naming conventions, test patterns, and deployment rules specific to Acme.
version: 1.0.0
---

# Acme Web Conventions

## Naming

- Components: PascalCase (`UserProfile.tsx`)
- Hooks: `use` prefix (`useUserData.ts`)
- Utilities: camelCase (`formatDate.ts`)
- Constants: SCREAMING_SNAKE (`MAX_RETRIES`)

## Testing

- Unit tests co-located: `foo.ts` → `foo.test.ts`
- Integration tests in `tests/integration/`
- Use `vi.mock()` for external deps, never for internal modules
- Run `pnpm test` before every commit

## Deployment

- `main` = production, `develop` = staging
- Never push directly to `main` — use PRs
- CI runs lint + typecheck + test on every PR
```

Save as `<project>/.wrongstack/skills/acme-conventions/SKILL.md` and commit it.

---

## Installing, searching, and authoring skills

WrongStack ships a toolkit of slash commands (the first-party `wstack-skills`
plugin) for discovering, installing, and creating skills:

| Command | Purpose |
|---|---|
| `/skill` | List available skills or show one skill's body. |
| `/skill-search <query>` | Search the skill registry (skills.sh) for installable skills. |
| `/skill-install <ref>` | Install from `<user/repo[@ref]>`, `skills.sh:<owner/repo>`, or any registry id. |
| `/skill-import [--from <tool>]` | Take ownership of a foreign agent's skill (copy/symlink into `.wrongstack/skills`). |
| `/skill-update [name]` | Re-fetch installed skills from their source. |
| `/skill-uninstall <name>` | Remove an installed skill. |
| `/skill-gen` | Authoring toolkit — see below. |

### Searching the registry

`/skill-search` queries **skills.sh** (the open agent-skills marketplace backed
by [mastra-ai/skills-api](https://github.com/mastra-ai/skills-api), 34k+ skills
across 2.8k+ repos). Each hit shows a security score (0–100): hits below 30 are
flagged with ⚠ and warrant a review before installing.

```
/skill-search react
```

To point at a self-hosted skills-api instance, set `config.skills.registryUrl`
in `~/.wrongstack/config.json`. This field is **stripped from repo-committed
config** (`<project>/.wrongstack/config.json`) because the parsed registry
response flows into the prompt — a repo-controlled URL would be an
SSRF / prompt-injection vector.

### Installing

```
/skill-install octocat/react-pro              # GitHub, default branch
/skill-install octocat/react-pro@v2.0.0       # GitHub, specific ref
/skill-install skills.sh:octocat/react-pro    # registry-resolved
/skill-install octocat/react-pro --global     # → ~/.wrongstack/skills/
```

**Private repos:** set `GITHUB_TOKEN` (or `GH_TOKEN`) in your environment. The
token is sent as `Authorization: Bearer <token>` to the GitHub API; without it
only public repos work and the anonymous 60/hour rate limit applies.

Supports both single-skill repos (`SKILL.md` at root) and multi-skill repos
(`skills/<name>/SKILL.md`).

### Authoring with `/skill-gen`

`/skill-gen` is a toolkit with sub-commands for the mechanical parts of skill
creation (validation, scaffolding) plus an AI-guided wizard for the open-ended
parts:

| Sub-command | Purpose |
|---|---|
| `/skill-gen` (bare) | AI-guided wizard — you answer questions, the agent writes the file. |
| `/skill-gen skeleton <name> --desc "..." --trigger a,b` | Generate a valid SKILL.md skeleton to edit. |
| `/skill-gen from-prompt "<text>"` | Turn a prompt into a skill draft. |
| `/skill-gen validate <name>` | Validate a name (kebab-case format + collisions) before writing. |
| `/skill-gen view <name>` | Show a skill's body (read-only). |
| `/skill-gen edit <name>` | Open a skill in `$EDITOR` / `$VISUAL`. |
| `/skill-gen list` | List skills with their source layer. |

The bundled `skill-creator` skill (loaded into the prompt) is the wizard's
brain — it holds the authoring rules and workflow. Always run
`/skill-gen validate <name>` after writing a new skill to confirm it loads.

