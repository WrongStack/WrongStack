# WrongStack Documentation

This is the on-ramp to the WrongStack documentation. If you're new to the project, start with the [Architecture](#architecture) section to get the big picture, then jump to the relevant [Author Guide](#author-guides) if you're adding a tool, plugin, provider, or help module.

---

## Quick links

| You want to… | Start here |
|---|---|
| Understand how the system is wired | [architecture.md](architecture.md) (overview) → [architecture-reference.md](architecture-reference.md) (deep) |
| Add a new tool, plugin, provider, or help module | [Author Guides](#author-guides) below |
| Understand a specific subcommand | [Subcommand Reference](#subcommand-reference) |
| Understand a specific slash command | [Slash Command Reference](#slash-command-reference) |
| Configure MCP servers (browser, SSH, GitHub, …) | [subcommands/mcp.md](subcommands/mcp.md) → `mcpServers` in [configuration.md](configuration.md) |
| Read the architectural decision history | [ADRs](#architecture-decision-records-adrs) |
| Configure runtime behavior | [configuration.md](configuration.md) |
| Compare all official plugins at a glance | [feature-matrix.md](feature-matrix.md) |
| Understand the release gates (`release:check` + `prepublishOnly`) | [release-process.md](release-process.md) |
| Debug a problem | [troubleshooting.md](troubleshooting.md) |
| Understand the security posture / report a vulnerability | [SECURITY.md](../SECURITY.md) |

---

## Architecture

| Document | What it covers | When to read |
|---|---|---|
| [architecture.md](architecture.md) | Package layout, layer model, dependency direction, IPC contracts | **Read first** — the canonical entry point |
| [architecture-reference.md](architecture-reference.md) | Complete technical reference: kernel primitives, agent lifecycle, prompt architecture, compaction, events, security, persistence, multi-agent coordination, autonomy, MCP, TUI, WebUI | Read when you need the full picture of a specific subsystem |
| [architecture-rules.md](architecture-rules.md) | Strict internal layering rules (Layer 1 / 2 / 3) with automated enforcement | Read when adding a new file to `packages/core/src/` |
| [webui.md](webui.md) | WebUI architecture: Vite + React 19 + WebSocket + Monaco | Read when working on `packages/webui/` |
| [plans/hq-command-center-2026-07.md](plans/hq-command-center-2026-07.md) | HQ command center enhancement plan — `packages/webui-hq/` React app (Phase 5) | Read when working on the cross-machine HQ dashboard |
| [agent-monitoring.md](agent-monitoring.md) | Agent monitoring system: FleetBus → AgentMonitorService → HQ browser + TUI timeline | Read when working on subagent visibility or HQ integration |
| [mcp-server.md](mcp-server.md) | MCP server architecture: stdio / SSE / streamable-HTTP transports | Read when working on `packages/mcp/` |
| [director-architecture.md](director-architecture.md) | Multi-agent Director orchestration: phase-based pipeline, brain handoff, autonomy levels | Read when working on `packages/core/src/coordination/` |
| [todos_architecture.md](todos_architecture.md) | Todo/plan/queue storage architecture | Read when working on `packages/core/src/storage/` |
| [goal-pause-resume-stage-reporting.md](goal-pause-resume-stage-reporting.md) | Goal-driven autonomous run lifecycle (pause / resume / stage reporting) | Read when working on `/goal` or `autonomous-runner` |
| [collab-debug.md](collab-debug.md) | 3-agent parallel collab-debug flow (BugHunter + RefactorPlanner + Critic) | Read when working on `/collab debug` |
| [yolo-mode.md](yolo-mode.md) | YOLO mode: risk classifier, permission policy, audit log | Read when working on `/yolo` or the security layer |
| [hooks.md](hooks.md) | Hooks runner: cross-cutting events, shell hooks, plugin integration | Read when adding a hook trigger or working on `/hooks` |
| [skills.md](skills.md) | Skill system: SKILL.md format, skill loader, registry | Read when working on `packages/core/src/skills/` |

---

## Author Guides

How to add new things. Each guide is self-contained — read the one for the surface you're adding.

| Guide | What it covers | Use when |
|---|---|---|
| [tool-author-guide.md](tool-author-guide.md) | How to write a WrongStack tool (the agent's hands): `Tool<I, O>` interface, permission policy, risk tier, streaming | Adding a new file / bash / network / domain tool |
| [plugin-author-guide.md](plugin-author-guide.md) | How to write a plugin: register tools, providers, slash commands, pipeline middleware, MCP servers | Adding a new plugin to `packages/plugins/` or `examples/` |
| [provider-author-guide.md](provider-author-guide.md) | How to add a new LLM provider: declarative `WireFormatConfig` path (preferred) or imperative `WireAdapter` subclass | Adding a new provider to `packages/providers/src/presets/` |
| [help-modules.md](help-modules.md) | How to write a dedicated help module for a subcommand: the `customBody` delegation pattern, single-source-of-truth flag list, parser integration, byte-for-byte parity test | Adding help to a deep subcommand (e.g. `wstack <sub> <deep> --help`) |
| [plugin-management.md](plugin-management.md) | How the plugin management commands work (`wstack plugin list`, `add`, `enable`, etc.) | Working on the plugin-management surface |

### Style guide

| Guide | Use when |
|---|---|
| [typescript-style-guide.md](typescript-style-guide.md) | TypeScript style conventions, type-safety rules, strict-mode patterns | Writing or reviewing any TypeScript code |

---

## Configuration & Operations

| Document | What it covers |
|---|---|
| [configuration.md](configuration.md) | Configuration model, secret vault, environment variables, config migration |
| [troubleshooting.md](troubleshooting.md) | Common problems and their fixes: provider failures, model registry, session replay, MCP issues |
| [SECURITY.md](../SECURITY.md) | Threat model, security posture, controls in place, known limitations, HQ Phase 2 auth roadmap, vulnerability reporting |

---

## Subcommand Reference

Per-subcommand documentation. Each entry in `docs/subcommands/` documents one subcommand in the `wstack <sub>` form.

| Subcommand | Document |
|---|---|
| `init` | [subcommands/init.md](subcommands/init.md) |
| `auth` | [subcommands/auth.md](subcommands/auth.md) |
| `acp` | [subcommands/acp.md](subcommands/acp.md) |
| `audit` | [subcommands/audit.md](subcommands/audit.md) |
| `bench` | [subcommands/bench.md](subcommands/bench.md) |
| `diag` / `doctor` | [subcommands/diag-doctor.md](subcommands/diag-doctor.md) |
| `export` | [subcommands/export.md](subcommands/export.md) |
| `hq` (`--hq`) | [subcommands/hq.md](subcommands/hq.md) |
| `mcp` | [subcommands/mcp.md](subcommands/mcp.md) |
| `plugin` | [subcommands/plugin.md](subcommands/plugin.md) |
| `projects` | [subcommands/projects.md](subcommands/projects.md) |
| `providers` / `models` | [subcommands/providers-models.md](subcommands/providers-models.md) |
| `replay` | [subcommands/replay.md](subcommands/replay.md) |
| `sessions` | [subcommands/sessions-config.md](subcommands/sessions-config.md) |
| `tools` / `skills` | [subcommands/tools-skills.md](subcommands/tools-skills.md) |
| `update` | [subcommands/update.md](subcommands/update.md) |
| `version` / `help` | [subcommands/version-help.md](subcommands/version-help.md) |

For an index, see [subcommands/README.md](subcommands/README.md).

---

## Slash Command Reference

Per-slash-command documentation. Each entry in `docs/slash/` documents one slash command in the `/<cmd>` form (used in the REPL).

For the full index, see [slash/README.md](slash/README.md), which lists every built-in slash command with its source file and a one-line description.

---

## Architecture Decision Records (ADRs)

ADRs capture significant architectural decisions, the alternatives considered, and the reasons. They're the historical record for "why is it this way?".

| ADR | Date | Status | Decision |
|---|---|---|---|
| [adr-001-layer-instead-of-split.md](adr/adr-001-layer-instead-of-split.md) | 2026-05-20 | Accepted | Rejected extracting `@wrongstack/kernel` as a separate package; kept everything in `@wrongstack/core` with strict internal layering + automated enforcement |
| [adr-002-help-delegation-pattern.md](adr/adr-002-help-delegation-pattern.md) | 2026-06-15 | Accepted (audit predictions confirmed) | Added `customBody?: () => string` to `PerSubcommandHelp`; the canonical pattern for help modules that don't fit the standard layout |

**For new ADRs**: use `docs/adr/adr-NNN-short-title.md` (zero-padded, kebab-case). The on-ramp for the help-delegation pattern is [help-modules.md](help-modules.md); the ADR is the historical record.

---

## Plans, Notes & Analysis

| Document | What it covers |
|---|---|
| [plans_architecture.md](plans_architecture.md) | Architectural plans / roadmap notes |
| [refactor-next.md](refactor-next.md) | Next refactor candidates (in-progress / planned) |
| [codebase-analysis-2026-06-07.md](codebase-analysis-2026-06-07.md) | Codebase analysis (2026-06-07 snapshot) |
| [wrongstack-architecture-analysis.md](wrongstack-architecture-analysis.md) | Earlier architecture analysis (pre-ADR-001) |
| [tui-feature-inventory.md](tui-feature-inventory.md) | TUI feature inventory — what the Ink/React surface does and doesn't do |
| [plans/security-hardening-2026-06.md](plans/security-hardening-2026-06.md) | Security hardening plan (2026-06) |
| [plans/hq-command-center-2026-06.md](plans/hq-command-center-2026-06.md) | HQ command center plan for cross-project fleet/client monitoring |
| [notes/refactor.md](notes/refactor.md) | Refactor notes (running log) |
| [notes/refactor-2026-06-05.md](notes/refactor-2026-06-05.md) | Refactor notes (2026-06-05 snapshot) |
| [notes/bugs.md](notes/bugs.md) | Bug notes (running log) |
| [notes/EDITING.md](notes/EDITING.md) | Editing notes for docs/ |
| [issues/2026-06-13-cli-main-refactor.md](issues/2026-06-13-cli-main-refactor.md) | CLI main refactor issue notes |
| [issues/2026-06-13-tui-app-refactor.md](issues/2026-06-13-tui-app-refactor.md) | TUI app refactor issue notes |
| [issues/2026-06-13-tui-app-refactor-tasks.md](issues/2026-06-13-tui-app-refactor-tasks.md) | TUI app refactor task list |
| [issues/2026-06-13-tui-app-refactor-update.md](issues/2026-06-13-tui-app-refactor-update.md) | TUI app refactor status update |
| [issues/2026-06-13-webui-package-server-refactor.md](issues/2026-06-13-webui-package-server-refactor.md) | WebUI package server refactor issue notes |
| [issues/2026-06-13-webui-server-refactor.md](issues/2026-06-13-webui-server-refactor.md) | WebUI server refactor issue notes |

---

## Conventions

- **Markdown formatting**: ATX-style headings (`#`, `##`), fenced code blocks with language tags, two-space indent, 100-char soft wrap. See [typescript-style-guide.md](typescript-style-guide.md) for code style.
- **Cross-references**: use relative links (`[text](file.md)`) so docs render correctly on GitHub and in editors.
- **Code paths**: reference files with their full path from the repo root in backticks (e.g. `` `packages/cli/src/subcommands/handlers/per-subcommand-help.ts` ``).
- **New docs**: drop them in the right category (or create a new category if needed). Add a row to the appropriate table in this README so the index stays current.

---

## Contributing

1. **Read the [architecture.md](architecture.md)** for the package layout and layering rules.
2. **Read the relevant Author Guide** for the surface you're adding (tool, plugin, provider, help module).
3. **Read the [typescript-style-guide.md](typescript-style-guide.md)** before writing code.
4. **Run `pnpm typecheck` and `pnpm test`** before opening a PR. Both are required to pass.
5. **Update this README** when you add a new document to a category, or when you create a new category.

For questions, the [`/help` slash command](slash/help.md) and the [`wstack <sub> --help`](subcommands/version-help.md) surfaces are the canonical in-product references. Anything not covered by the in-product help is either a bug or a missing doc.
