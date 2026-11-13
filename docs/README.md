# WrongStack Documentation

This is the on-ramp to the WrongStack documentation. If you're new to the project, start with the [Architecture](#architecture) section to get the big picture, then jump to the relevant [Author Guide](#author-guides) if you're adding a tool, plugin, provider, or help module.

---

## Quick links

| You want to… | Start here |
|---|---|
| Start a first session and choose a surface | [getting-started.md](getting-started.md) |
| Tour what WrongStack can do, capability by capability | [capabilities.md](capabilities.md) |
| Understand how the system is wired | [architecture.md](architecture.md) — the maintained architecture overview |
| Add a new tool, plugin, provider, or help module | [Author Guides](#author-guides) below |
| Choose and use built-in tools | [Tool workflows](tools/README.md) |
| Connect an application to the WebUI API | [client-api.md](client-api.md) |
| Look up CLI flags, subcommands, and `wstack update` | [cli-reference.md](cli-reference.md) |
| Scan tools, providers, slash commands, modes, and skills at a glance | [reference.md](reference.md) |
| Check exact source registrations | [current-catalog.md](current-catalog.md) |
| Update or check documentation | [maintenance.md](maintenance.md) |
| Understand a specific subcommand | [Subcommand Reference](#subcommand-reference) |
| Understand a specific slash command | [Slash Command Reference](#slash-command-reference) |
| Configure MCP servers (browser, SSH, GitHub, …) | [subcommands/mcp.md](subcommands/mcp.md) → `mcpServers` in [configuration.md](configuration.md) |
| Read the architectural decision history | [ADRs](#architecture-decision-records-adrs) |
| Manage persistent project decisions and user reviews | [Project architecture decisions](architecture-decisions.md) |
| Configure runtime behavior | [configuration.md](configuration.md) |
| Compare all official plugins at a glance | [feature-matrix.md](feature-matrix.md) |
| Understand the release gates (`release:check`; npm publishing is retired) | [release-process.md](release-process.md) |
| Debug a problem | [troubleshooting.md](troubleshooting.md) |
| Understand the security posture / report a vulnerability | [SECURITY.md](../SECURITY.md) |

---

## Architecture

| Document | What it covers | When to read |
|---|---|---|
| [architecture.md](architecture.md) | Package layout, layer model, dependency direction, IPC contracts | **Read first** — the canonical architecture entry point |
| [architecture/package-owners.md](architecture/package-owners.md) | Shared package owners, public integration surfaces and host boundaries | Read when selecting a package dependency or integration API |
| [wrongtrace.md](wrongtrace.md) | WrongTrace integration: the optional external daemon, `@wrongstack/wrongtrace` adapter (HTTP/IPC/MCP), guardrail hooks, WrongProxy provider routing, testing & troubleshooting | Read when working on `packages/wrongtrace/`, the CLI guardrail hooks, or `tools.wrongProxy` |
| [architecture-rules.md](architecture-rules.md) | Seven-layer internal runtime-import ordering with automated enforcement | Read when adding a new file to `packages/core/src/` |
| [architecture/session-catalog.md](architecture/session-catalog.md) | Catalog claims, presence and transcript ownership | Read before changing session ownership or resume |
| [webui.md](webui.md) | WebUI architecture: Vite + React 19 + WebSocket + Monaco | Read when working on `packages/webui/` |
| [hq.md](hq.md) | HQ server, browser transport and state ownership | Read when working on the cross-machine dashboard |
| [agent-monitoring.md](agent-monitoring.md) | Agent monitoring system: FleetBus → AgentMonitorService → HQ browser + TUI timeline | Read when working on subagent visibility or HQ integration |
| [mcp-server.md](mcp-server.md) | MCP server architecture: stdio / SSE / streamable-HTTP transports | Read when working on `packages/mcp/` |
| [director-architecture.md](director-architecture.md) | Multi-agent Director orchestration: phase-based pipeline, brain handoff, autonomy levels | Read when working on `packages/coordination/src/` |
| [kanban-architecture.md](kanban-architecture.md) | Project-scoped multi-kanban architecture: storage, queue semantics, TaskGraph bridge, Director/fleet dispatch, managed lifecycle, completion verification, and the execution-time security boundary | Read when working on `packages/kanban/`, the `kanban` tool, Kanban CLI/TUI/WebUI surfaces, or `tools.kanbanGovernance` |
| [kanban-contract-graph.md](kanban-contract-graph.md) | Goodhart-safe objective, impact, guardrail, risk, and verification graph for autonomous coding tasks | Read before changing contract-graph types, completion enforcement, or autonomous Kanban instructions |
| [kanban-workbench.md](kanban-workbench.md) | Bounded cross-board Now, Next, Blocked, Review, alerts, and shared WebUI/TUI visibility | Read before changing global Kanban navigation, work-surface projections, or task-flow presentation |
| [kanban-orchestration-contract.md](kanban-orchestration-contract.md) | Canonical task/assignment lifecycle contract for Kanban-backed LLM, Director, subagent, review, and recovery work | Read before changing Kanban queue semantics, assignment lifecycle, stale recovery, or orchestration prompts |
| [architecture/project-goals.md](architecture/project-goals.md) | Goal ids, workspaces, leases, My Goals and verification | Read before changing phase goals |
| [todos_architecture.md](todos_architecture.md) | Todo/plan/queue storage architecture | Read when working on `packages/core/src/storage/` |
| [goal-pause-resume-stage-reporting.md](goal-pause-resume-stage-reporting.md) | Goal-driven autonomous run lifecycle (pause / resume / stage reporting) | Read when working on `/goal` or `autonomous-runner` |
| [collab-debug.md](collab-debug.md) | 3-agent parallel collab-debug flow (BugHunter + RefactorPlanner + Critic) | Read when working on `/collab debug` |
| [yolo-mode.md](yolo-mode.md) | YOLO mode: risk classifier, permission policy, audit log | Read when working on `/yolo` or the security layer |
| [hooks.md](hooks.md) | Hooks runner: cross-cutting events, shell hooks, plugin integration | Read when adding a hook trigger or working on `/hooks` |
| [present-artifact.md](present-artifact.md) | Session-scoped artifact presentation and editor preservation | Read when changing tool result presentation |
| [subcommands/sandbox.md](subcommands/sandbox.md) | Isolated Docker execution, source snapshots and patch artifacts | Read when running autonomous work in a container |
| [subcommands/automation.md](subcommands/automation.md) | Persistent jobs, GitHub intake, credential references and run lifecycle | Read when managing scheduled or event-driven agent work |
| [subcommands/bench-experiments.md](subcommands/bench-experiments.md) | Offline routing, behavior review and paired compaction experiments | Read when measuring changes to existing agent behavior |
| [subcommands/provider-cloud.md](subcommands/provider-cloud.md) | Native cloud routing settings per saved provider profile | Read when configuring Bedrock, Vertex or Azure aliases |
| [subcommands/provider-preflight.md](subcommands/provider-preflight.md) | Read-only native provider setup diagnostics | Read before diagnosing cloud credential chains |
| [skills.md](skills.md) | Skill system: SKILL.md format, skill loader, registry | Read when working on `packages/core/src/skills/` |
| [codebase-index-calls.md](codebase-index-calls.md) | Incoming/outgoing calls tools: ref-graph caller/callee lookup, 7-layer dispatch, edit→index pipeline, impact analysis | Read when working on `codebase-incoming-calls`/`codebase-outgoing-calls` or the index dispatch stack |
| [sage/SYSTEM-REPORT.md](sage/SYSTEM-REPORT.md) | SAGE long-term memory end to end: SQLite schema, IPC project server, injection middleware, tools, MCP, CLI/TUI/WebUI/VibeUI surfaces | **Read first** before changing memory storage, inject policy, `/memory`, MemoryManager, or `sage-mcp` |
| [sage/retrieval.md](sage/retrieval.md) | SAGE, durable vectors, host fusion and visibility | Read before changing retrieval |
| [context-editor.md](context-editor.md) | Revision checks, validation and context edits | Read before changing the context editor |

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
| [openai-cache-management.md](openai-cache-management.md) | Codex/ChatGPT cache identity, stable prompts, usage diagnostics and quota measurement |
| [slash/profile.md](slash/profile.md) | Profile copy/switch and which state requires a restart |
| [subcommands/config-transfer.md](subcommands/config-transfer.md) | Portable settings, included controls and merge semantics |
| [slash/permissions.md](slash/permissions.md) | Explain live policy decisions and manage session rules |
| [slash/effort.md](slash/effort.md), [slash/tier.md](slash/tier.md) | Reasoning effort versus role/phase cost-tier routing |
| [subcommands/remote.md](subcommands/remote.md) | Remote project runtime with a local SSH WebUI tunnel |
| [subcommands/chronicle.md](subcommands/chronicle.md) | Recorded work, metrics and retention maintenance |
| [subcommands/sage.md](subcommands/sage.md) | External-agent memory and memory-only HQ synchronization |
| [project-daemons.md](project-daemons.md) | The per-project IPC daemons: ownership election, stale-endpoint self-healing, degradation rules, `wstack doctor --daemons` |
| [troubleshooting.md](troubleshooting.md) | Common problems and their fixes: provider failures, model registry, session replay, MCP issues |
| [SECURITY.md](../SECURITY.md) | Threat model, current controls, known limitations, HQ implementation status, vulnerability reporting |

---

## CLI & Reference

High-level, README-adjacent reference. Start here for a quick map, then drill into
the per-subcommand and per-slash-command docs below.

| Document | What it covers |
|---|---|
| [cli-reference.md](cli-reference.md) | Launch flags, subcommands, and the GitHub Releases `wstack update` self-updater (`--check-only`, legacy package migration) |
| [reference.md](reference.md) | Tool families, providers, slash commands, modes and skills |
| [current-catalog.md](current-catalog.md) | Generated package, tool, shell-command, mode, skill and plugin inventories |

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
| [adr-003-telegram-broker-and-webhook.md](adr/adr-003-telegram-broker-and-webhook.md) | 2026-07-28 | Accepted | Telegram delivery choices |
| [adr-004-step-budgeted-regex-ambiguity-matcher.md](adr/adr-004-step-budgeted-regex-ambiguity-matcher.md) | 2026-09-01 | Proposed | Bounded regex ambiguity matching |

**For new ADRs**: use `docs/adr/adr-NNN-short-title.md` (zero-padded, kebab-case). The on-ramp for the help-delegation pattern is [help-modules.md](help-modules.md); the ADR is the historical record.

---

## Plans & Historical Material

| Location | What it covers |
|---|---|
| [plans/README.md](plans/README.md) | Ongoing ledgers, pending proposals and retained decisions; refresh baselines before executing. |
| [designs/README.md](designs/README.md) | Proposed or partly delivered contracts, separate from runtime guidance. |
| [specs/README.md](specs/README.md) | Specification status and acceptance contracts; planned paths do not establish delivery. |
| [notes/](notes/) | Short-lived working notes; promote durable guidance to a maintained document. |
| [archive/](archive/) | Superseded architecture documents, completed work items, dated reports, audits, and release snapshots. |

---

For documentation checks and source-derived inventories, see [maintenance](maintenance.md).

## Conventions

- **Markdown formatting**: ATX-style headings (`#`, `##`), fenced code blocks with language tags, two-space indent, 100-char soft wrap. See [typescript-style-guide.md](typescript-style-guide.md) for code style.
- **Cross-references**: use relative links (for example, `[Architecture](architecture.md)`) so docs render correctly on GitHub and in editors.
- **Code paths**: reference files with their full path from the repo root in backticks (e.g. `` `packages/cli/src/subcommands/handlers/per-subcommand-help.ts` ``).
- **Verification**: run `bun run docs:check`; refresh inventories with `bun run docs:catalog:write`. Behavior claims still need code/test evidence.
- **New docs**: add maintained guidance to the appropriate category and index it here. Put dated snapshots and completed work in `archive/` instead of the current-docs path.

---

## Contributing

1. **Read the [architecture.md](architecture.md)** for the package layout and layering rules.
2. **Read the relevant Author Guide** for the surface you're adding (tool, plugin, provider, help module).
3. **Read the [typescript-style-guide.md](typescript-style-guide.md)** before writing code.
4. **Run `bun run typecheck` and `bun run test`** before opening a PR. Both are required to pass.
5. **Update this README** when you add maintained documentation to a category. Do not add archival snapshots to the main navigation.

For questions, the [`/help` slash command](slash/help.md) and the [`wstack <sub> --help`](subcommands/version-help.md) surfaces are the canonical in-product references. Anything not covered by the in-product help is either a bug or a missing doc.
