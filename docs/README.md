# WrongStack Documentation

This is the on-ramp to the WrongStack documentation. If you're new to the project, start with the [Architecture](#architecture) section to get the big picture, then jump to the relevant [Author Guide](#author-guides) if you're adding a tool, plugin, provider, or help module.

---

## Quick links

| You want to… | Start here |
|---|---|
| Understand how the system is wired | [architecture.md](architecture.md) — the maintained architecture overview |
| Add a new tool, plugin, provider, or help module | [Author Guides](#author-guides) below |
| Look up CLI flags, subcommands, and `wstack update` | [cli-reference.md](cli-reference.md) |
| Scan tools, providers, slash commands, modes, and skills at a glance | [reference.md](reference.md) |
| Understand a specific subcommand | [Subcommand Reference](#subcommand-reference) |
| Understand a specific slash command | [Slash Command Reference](#slash-command-reference) |
| Configure MCP servers (browser, SSH, GitHub, …) | [subcommands/mcp.md](subcommands/mcp.md) → `mcpServers` in [configuration.md](configuration.md) |
| Read the architectural decision history | [ADRs](#architecture-decision-records-adrs) |
| Configure runtime behavior | [configuration.md](configuration.md) |
| Compare all official plugins at a glance | [feature-matrix.md](feature-matrix.md) |
| Review plugin defaults, risks, findings, and roadmap | [plugin-audit-2026-07-10.md](plugin-audit-2026-07-10.md) |
| Understand the release gates (`release:check` + `prepublishOnly`) | [release-process.md](release-process.md) |
| Debug a problem | [troubleshooting.md](troubleshooting.md) |
| Understand the security posture / report a vulnerability | [SECURITY.md](../SECURITY.md) |

---

## Architecture

| Document | What it covers | When to read |
|---|---|---|
| [architecture.md](architecture.md) | Package layout, layer model, dependency direction, IPC contracts | **Read first** — the canonical architecture entry point |
| [architecture-rules.md](architecture-rules.md) | Seven-layer internal runtime-import ordering with automated enforcement | Read when adding a new file to `packages/core/src/` |
| [plans/session-catalog-project-service-2026-08.md](plans/session-catalog-project-service-2026-08.md) | Detailed project plan for daemon-owned session claims, live presence, and shared session catalog operations | Read before changing session ownership, resume, registry, session index, or cross-surface presence |
| [webui.md](webui.md) | WebUI architecture: Vite + React 19 + WebSocket + Monaco | Read when working on `packages/webui/` |
| [architecture/simpleui-message-lifecycle.md](architecture/simpleui-message-lifecycle.md) | SimpleUI message lifecycle end to end: composer → `user_message` frame → webui-server → `@wrongstack/core` emit sites → rendered chat, plus the client/server protocol frame registry | Read when working on `packages/simpleui/`, the surface protocol, or the chat frame flow |
| [plans/hq-command-center-2026-07.md](plans/hq-command-center-2026-07.md) | HQ command center enhancement plan — `packages/webui-hq/` React app (Phase 5) | Read when working on the cross-machine HQ dashboard |
| [agent-monitoring.md](agent-monitoring.md) | Agent monitoring system: FleetBus → AgentMonitorService → HQ browser + TUI timeline | Read when working on subagent visibility or HQ integration |
| [mcp-server.md](mcp-server.md) | MCP server architecture: stdio / SSE / streamable-HTTP transports | Read when working on `packages/mcp/` |
| [director-architecture.md](director-architecture.md) | Multi-agent Director orchestration: phase-based pipeline, brain handoff, autonomy levels | Read when working on `packages/core/src/coordination/` |
| [kanban-architecture.md](kanban-architecture.md) | Project-scoped multi-kanban architecture: storage, queue semantics, TaskGraph bridge, Director/fleet dispatch, managed lifecycle, completion verification, and the execution-time security boundary | Read when working on `packages/kanban/`, the `kanban` tool, Kanban CLI/TUI/WebUI surfaces, or `tools.kanbanGovernance` |
| [kanban-database.md](kanban-database.md) | Kanban persistence layer end to end: `_kanban.sqlite` tables, why each column exists, document-internal relationships, cross-system links (SDD, HQ, governance, session mirror), and consistency invariants | Read before changing the Kanban schema, storage backend, IPC protocol, or any persisted Kanban type |
| [kanban-contract-graph.md](kanban-contract-graph.md) | Goodhart-safe objective, impact, guardrail, risk, and verification graph for autonomous coding tasks | Read before changing contract-graph types, completion enforcement, or autonomous Kanban instructions |
| [kanban-workbench.md](kanban-workbench.md) | Bounded cross-board Now, Next, Blocked, Review, alerts, and shared WebUI/TUI/SimpleUI visibility | Read before changing global Kanban navigation, work-surface projections, or task-flow presentation |
| [kanban-orchestration-contract.md](kanban-orchestration-contract.md) | Canonical task/assignment lifecycle contract for Kanban-backed LLM, Director, subagent, review, and recovery work | Read before changing Kanban queue semantics, assignment lifecycle, stale recovery, or orchestration prompts |
| [kanban-orchestration-roadmap.md](kanban-orchestration-roadmap.md) | Roadmap for turning Kanban into the source-of-truth orchestration state machine for LLM/fleet work | Read when planning Kanban leases, stale recovery, event logs, quality gates, phase orchestration, or E2E fleet tests |
| [todos_architecture.md](todos_architecture.md) | Todo/plan/queue storage architecture | Read when working on `packages/core/src/storage/` |
| [goal-pause-resume-stage-reporting.md](goal-pause-resume-stage-reporting.md) | Goal-driven autonomous run lifecycle (pause / resume / stage reporting) | Read when working on `/goal` or `autonomous-runner` |
| [collab-debug.md](collab-debug.md) | 3-agent parallel collab-debug flow (BugHunter + RefactorPlanner + Critic) | Read when working on `/collab debug` |
| [yolo-mode.md](yolo-mode.md) | YOLO mode: risk classifier, permission policy, audit log | Read when working on `/yolo` or the security layer |
| [hooks.md](hooks.md) | Hooks runner: cross-cutting events, shell hooks, plugin integration | Read when adding a hook trigger or working on `/hooks` |
| [skills.md](skills.md) | Skill system: SKILL.md format, skill loader, registry | Read when working on `packages/core/src/skills/` |
| [codebase-index-calls.md](codebase-index-calls.md) | Incoming/outgoing calls tools: ref-graph caller/callee lookup, 7-layer dispatch, edit→index pipeline, impact analysis | Read when working on `codebase-incoming-calls`/`codebase-outgoing-calls` or the index dispatch stack |
| [sage/SYSTEM-REPORT.md](sage/SYSTEM-REPORT.md) | SAGE long-term memory end to end: SQLite schema, IPC project server, injection middleware, tools, MCP, CLI/TUI/WebUI/SimpleUI surfaces | **Read first** before changing memory storage, inject policy, `/memory`, MemoryManager, or `sage-mcp` |
| [sage/ARCHITECTURE.md](sage/ARCHITECTURE.md) | Older SAGE package write-up (partially superseded; JSONL-era sections are historical) | Background only — prefer `SYSTEM-REPORT.md` for runtime truth |

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
| [plugin-audit-2026-07-10.md](plugin-audit-2026-07-10.md) | Audit of 73 managed first-party rows (core, suite catalog, and bridges) | Reviewing plugin policy or planning follow-up work |

### Style guide

| Guide | Use when |
|---|---|
| [typescript-style-guide.md](typescript-style-guide.md) | TypeScript style conventions, type-safety rules, strict-mode patterns | Writing or reviewing any TypeScript code |

---

## Configuration & Operations

| Document | What it covers |
|---|---|
| [configuration.md](configuration.md) | Configuration model, secret vault, environment variables, config migration |
| [project-daemons.md](project-daemons.md) | The per-project IPC daemons: ownership election, stale-endpoint self-healing, degradation rules, `wstack doctor --daemons` |
| [troubleshooting.md](troubleshooting.md) | Common problems and their fixes: provider failures, model registry, session replay, MCP issues |
| [SECURITY.md](../SECURITY.md) | Threat model, current controls, known limitations, HQ implementation status, vulnerability reporting |

---

## CLI & Reference

High-level, README-adjacent reference. Start here for a quick map, then drill into
the per-subcommand and per-slash-command docs below.

| Document | What it covers |
|---|---|
| [cli-reference.md](cli-reference.md) | Launch flags, subcommands, and the `wstack update` self-updater (`--check-only`, `--pm`, `--allow-scripts`) |
| [reference.md](reference.md) | Condensed map of the 70 built-in tools, ~140 providers, slash commands, the 19 modes, and the 29 bundled skills |

---

## Subcommand Reference

Per-subcommand documentation. Each entry in `docs/subcommands/` documents one subcommand in the `wstack <sub>` form.

| Subcommand | Document |
|---|---|
| `init` (deprecated compatibility alias) | [subcommands/init.md](subcommands/init.md) |
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

## Plans & Historical Material

| Location | What it covers |
|---|---|
| [plans/](plans/) | Active, implementation-oriented plans. Keep status, owner, and last-verified date in every plan. |
| [competitive-roadmap-2026-2027/](competitive-roadmap-2026-2027/) | Product strategy and roadmap proposals. |
| [specs/](specs/) | Spec-driven-development contracts and acceptance criteria. |
| [notes/](notes/) | Short-lived working notes; promote durable guidance to a maintained document. |
| [archive/](archive/) | Superseded architecture documents, completed work items, dated reports, audits, and release snapshots. |

---

## Conventions

- **Markdown formatting**: ATX-style headings (`#`, `##`), fenced code blocks with language tags, two-space indent, 100-char soft wrap. See [typescript-style-guide.md](typescript-style-guide.md) for code style.
- **Cross-references**: use relative links (for example, `[Architecture](architecture.md)`) so docs render correctly on GitHub and in editors.
- **Code paths**: reference files with their full path from the repo root in backticks (e.g. `` `packages/cli/src/subcommands/handlers/per-subcommand-help.ts` ``).
- **New docs**: add maintained guidance to the appropriate category and index it here. Put dated snapshots and completed work in `archive/` instead of the current-docs path.

---

## Contributing

1. **Read the [architecture.md](architecture.md)** for the package layout and layering rules.
2. **Read the relevant Author Guide** for the surface you're adding (tool, plugin, provider, help module).
3. **Read the [typescript-style-guide.md](typescript-style-guide.md)** before writing code.
4. **Run `pnpm typecheck` and `pnpm test`** before opening a PR. Both are required to pass.
5. **Update this README** when you add maintained documentation to a category. Do not add archival snapshots to the main navigation.

For questions, the [`/help` slash command](slash/help.md) and the [`wstack <sub> --help`](subcommands/version-help.md) surfaces are the canonical in-product references. Anything not covered by the in-product help is either a bug or a missing doc.
