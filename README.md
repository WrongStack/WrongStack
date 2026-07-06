<div align="center">

# WrongStack

### _Built on the wrong stack. Shipped anyway._

**An AI coding agent that reads your code, edits files, runs commands, and reasons through bugs — across a terminal REPL, a full-screen TUI, a browser UI, an Electron desktop shell, and a cross-machine HQ command center, while you keep your hand on every permission.**

[![npm](https://img.shields.io/npm/v/wrongstack?style=flat-square&color=0b7285&label=npm)](https://www.npmjs.com/package/wrongstack)
[![downloads](https://img.shields.io/npm/dm/wrongstack?style=flat-square&color=0b7285)](https://www.npmjs.com/package/wrongstack)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![tests](https://img.shields.io/badge/tests-passing-2f9e44?style=flat-square)](#status)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

```bash
npm i -g wrongstack && wrongstack
```

</div>

---

WrongStack drives **autonomous goal loops**, **parallel subagent fan-out**, **multi-agent Director orchestration**, **Brain-governed policy decisions**, and **collaborative debugging** — and walks you through full **Spec-Driven Development** cycles. It ships with **36 built-in tools**, **23 skills**, **8 core first-party plugins** + **36 official plugins** in `@wrongstack/plugins`, and **~140 providers** pulled live from [models.dev](https://models.dev) — 138 with a built-in transport (8 `anthropic` / 3 `openai` / 126 `openai-compatible` / 1 `google`) plus 3 OAuth families (`anthropic-oauth`, `openai-codex`, `github-copilot`). No hardcoded model names, no hardcoded pricing, no hardcoded lists. Secrets are **AES-256-GCM** encrypted at rest with a per-machine key; every tool call clears a **per-tool permission policy**. Everything lives under `~/.wrongstack/` — the only thing you'd ever commit is `.wrongstack/AGENTS.md`.

### ✨ Why it slaps

- 🧠 **Four surfaces, one brain** — a plain readline REPL, an Ink/React **TUI** (`--tui`), a standalone **web UI** (`--webui`), and **WrongStack Desktop** (`--desktop` / `wstack desktop`).
- 🤖 **A fleet, not a lone agent** — a 47-role roster + smart dispatcher fan out under a Director, each subagent fully isolated with its own budget and JSONL transcript.
- 🛰️ **HQ for the whole room** — `wstack --hq` aggregates live sessions, agents, fleets, mailbox state, cost, tools, Brain decisions, and worktrees across machines, then can steer or stop connected clients through their own guardrails.
- 🧠 **Brain as an authority seam** — risky AutoPhase and Director choices can be auto-decided by policy, denied, or escalated to the human through the TUI.
- ♾️ **Set a goal, walk away** — `/goal` locks in a contract and the eternal / parallel engines grind until it's _verifiably_ done.
- 🔌 **~140 providers, zero lock-in** — Anthropic, OpenAI, Google, and ~125 OpenAI-compatible endpoints, catalog refreshed from models.dev at boot.
- 🔑 **Sign in with a subscription** — authenticate with a **ChatGPT (Codex)**, **Claude Pro/Max**, or **GitHub Copilot** subscription over OAuth, *alongside* (not instead of) API keys. See [`docs/oauth-signin.md`](docs/oauth-signin.md).
- 🔎 **Fast model switching** — the TUI `/model` picker supports type-to-search filtering with scroll-window navigation, and `wstack models` supports search + pagination.
- 🔐 **Locked down by default** — encrypted secrets, SSRF guards on every redirect hop, fail-closed subagents, symlink containment, plugin trust tiers, WebUI redaction, and cloud-sync path guards.
- 🪶 **A compact kernel** — `Container · Pipeline · EventBus · RunController` (~1670 lines including the full event type catalog). Everything above it is swappable; `--no-features` boots it fully offline.

## Requirements

- **Node.js** ≥ 22.19.0
- **pnpm** ≥ 9.0.0 (recommended) or npm

## Install

```bash
npm install -g wrongstack
# or
pnpm install -g wrongstack
```

This pulls in the full stack — `@wrongstack/core`, `@wrongstack/runtime`, `@wrongstack/providers`, `@wrongstack/tools`, `@wrongstack/mcp`, `@wrongstack/acp`, `@wrongstack/bench`, `@wrongstack/plug-lsp`, `@wrongstack/plugins`, and `@wrongstack/tui`. The TUI is shipped but lazy-loaded behind `--tui`, so plain-REPL users pay no React/Ink import cost at startup. The web-based UI (`@wrongstack/webui`) is available as a separate binary (`wstackui`). WrongStack Desktop (`@wrongstack/desktop`) is an optional Electron package; launch it with `wrongstack --desktop`, `wstack desktop`, or the direct `wrongstack-desktop` / `wstack-desktop` binaries when installed.

After install, `wrongstack` is on your `PATH`. (`wstack` works too — it's an alias.)

---

## Features

### Interactive surfaces + HQ

**Plain REPL** (default): readline-based, multiline heredoc, slash commands, streaming text. Works everywhere a terminal works.

**TUI** (`--tui`): Ink + React frontend, lazy-loaded. Key features:

- Multi-line paste collapse, `@<query>` fuzzy file picker, clipboard image paste (`Alt+V`)
- Live status bar: model · tokens · cache hit · cost · `running: <tool>` while tools execute
- **LiveActivityStrip**: tool in flight + elapsed timer per running subagent
- **Esc-to-steer**: aborts run, terminates fleet, prepends STEERING preamble to your next message
- **`/goal <description>`**: locks in full-autonomy mode — no implicit budget cap
- Signal-safe cleanup, non-TTY guard, re-entrancy guard on Enter, resize ghost mitigation
- Real-time stage chip: `⟳ DECIDE` / `⚡ EXECUTE` / `◎ REFLECT` updates every tick during eternal/parallel runs

**Web UI** (`@wrongstack/webui`): React + Radix + Tailwind frontend with a Node `ws` backend. Standalone `wstackui` binary serves on `3456/3457`; CLI can opt in with `wrongstack --webui`. Highlights:

- Topbar status bar: ctx% · tokens · cache hit · cost · elapsed · iteration
- Per-message footer: token usage, Pin / Edit & resend / Retry
- Tool bubbles: live `tool.progress` stream, collapsible gutter, Download/Copy on hover
- Sidebar: live TODO snapshot, Pinned panel, History with grouping + search
- Operations panels: Goal, Process Monitor, Checkpoint Timeline, AutoPhase, phase agents, task board, and worktree lanes
- Autonomy picker: switch `off` / `suggest` / `auto` / `eternal` / `eternal-parallel` from the UI
- Overlays: `Ctrl+K` command palette, `Ctrl+M` model switcher, `Ctrl+F` chat search, `?` shortcuts
- Slash commands with keyboard nav, day-separator dividers, dynamic tab title

```bash
# Standalone (recommended for the full experience)
wstackui                       # binds backend to 127.0.0.1:3457, serves UI on 3456
WS_HOST=0.0.0.0 wstackui       # expose on the LAN

# Or piggy-back on the CLI process
wrongstack --webui
```

**Desktop** (`@wrongstack/desktop`): Electron shell that hosts one or more local, token-required WebUI runtimes and keeps project/session switching native. Launch it with `wrongstack --desktop`, `wstack desktop`, `wrongstack-desktop`, or `wstack-desktop`.

- Recent and registered project launcher backed by the shared `~/.wrongstack/projects.json` manifest
- Multiple concurrent sessions per project, each with isolated local HTTP/WS ports and a per-runtime access token
- Embedded WebUI plus native menu routing for chat, files, changes, sessions, Fleet HQ, settings, command palette, model switcher, and terminal
- Desktop toggles for YOLO, next prediction, and context auto-compact that flow into the hosted WebUI
- Window/sidebar/workspace restoration, project folder reveal, open-in-browser, WebUI reload, and runtime log visibility

```bash
wrongstack --desktop
wstack desktop
wrongstack-desktop
```

**HQ Command Center** (`--hq` / `wstack hq`): a project-independent HTTP+WebSocket dashboard on `127.0.0.1:3499` that aggregates every connected REPL, TUI, CLI-hosted WebUI, and standalone WebUI. It is the one deliberate cross-machine surface in WrongStack; the normal WebUI, mailbox server, and MCP server stay loopback-first.

- Same-machine clients auto-discover `~/.wrongstack/hq/runtime.json` and the first client token from `auth.json`, even if HQ starts after them or restarts on a new port
- Browser and client tokens are separate, capability-scoped, and stored in `~/.wrongstack/hq/auth.json`
- Live HQ views include sessions, transcripts, agents, fleet snapshots, mailbox rollups, Brain events, worktrees, tool events, cost trends, and active alerts
- Control commands queue through `/api/command`: `steer`, `abort`, `spawn`, `broadcast`, and gated `run-command` (routed as a steer behind `--hq-allow-exec`, so the agent permission policy still applies)
- Persistence survives restart through `events.jsonl`, `snapshot.json`, and `timeseries.jsonl`

```bash
wstack --hq --open
wstack hq token create "browser"
wstack hq token create --client "build-box"
```

### 36 built-in tools

All tools are registered out of the box — no plugin required.

| Tool | What it does |
|------|--------------|
| `read` | Read file contents with offset/limit |
| `write` | Write or overwrite a file |
| `edit` | Surgical string replacement in existing files |
| `replace` | Batch regex replacement across matched files |
| `glob` | Find files matching a pattern |
| `grep` | Search file contents with regex |
| `bash` | Run shell commands |
| `exec` | Restricted shell with an allowlist (`node`, `npm`, `pnpm`, …) |
| `fetch` | HTTP fetch with HTML→markdown (localhost blocked by default) |
| `search` | Web search (DuckDuckGo / Google / Bing) |
| `patch` | Apply unified diff patches |
| `json` | Parse and query JSON with dot notation |
| `diff` | Show differences between files or commits |
| `tree` | Display directory structure as ASCII tree |
| `lint` | Run linter (Biome / ESLint / TSLint) |
| `format` | Format code with Biome / Prettier |
| `typecheck` | TypeScript type checking |
| `test` | Run tests with Vitest / Jest / Mocha |
| `install` | Install npm packages |
| `audit` | Security vulnerability audit |
| `outdated` | Check for outdated packages |
| `logs` | Stream or fetch service log files |
| `document` | Generate JSDoc/TSDoc comments |
| `scaffold` | Generate boilerplate from templates |
| `tool_search` / `tool_use` / `batch_tool_use` / `tool_help` | Meta-tooling for tool discovery and orchestration |
| `todo` | Track multi-step tasks |
| `git` | Common git operations |
| `task` | Structured work items with dependencies, types, and priorities |
| `context_manager` | Inspect / trim / compact the in-flight context window |
| `remember` / `forget` | Persist notes across sessions (project- or user-scoped, gated by `features.memory`) |
| `codebase-index` | Build / update the SQLite symbol index (incremental; multi-language) |
| `codebase-search` | BM25-ranked search over indexed symbol names, signatures, and doc comments |
| `codebase-stats` | Summary of the current symbol index |

### Autonomy engine

The engine has two modes, both launched via `/autonomy`:

**`eternal`** — single-leader goal-driven loop. Runs `decide → execute → reflect → sleep` cycles against the persistent `/goal` until you stop it (Esc / `/steer` / Ctrl+C / `/autonomy stop`). Force-enables YOLO. Hybrid decide pipeline walks pending todos → dirty git → LLM brainstorm, so the loop produces useful work even with no queued task. Each phase transition calls the `onStage` callback — the TUI renders the live stage chip (`⟳ DECIDE`, `⚡ EXECUTE`, `◎ REFLECT`) updating every tick. TUI shows a red `ETERNAL` chip; WebUI receives a live `eternal.iteration` WS broadcast per cycle.

**`parallel`** — leader drives, N subagents fan out simultaneously. `ParallelEternalEngine` decomposes the goal into up to `parallelSlots` tasks per tick (default 4, max 16), spawns that many subagents via `DefaultMultiAgentCoordinator`, awaits all results, aggregates, and writes a journal entry. `[GOAL_COMPLETE]` in any subagent's output stops the engine cleanly. `maxConcurrent: 8` supports the higher fan-out density. TUI shows an amber `⟳ PARALLEL` chip with the live iteration count.

Both engines persist state to `goal.json`. Both can be paused and resumed without losing work: `/goal pause` sets `goalState: 'paused'` — the engine exits gracefully after the current iteration finishes (no AbortController kill, no work torn mid-task); `/goal resume` flips `goalState` back to `'active'`.

### Goal system

`/goal <text>` persists to `~/.wrongstack/projects/<hash>/goal.json` and injects a full-autonomy preamble into the next turn:

```
[GOAL — LOCKED IN. You will work on this until it is verifiably done.

YOUR GOAL: <user text>

AUTHORITY: Spawn unlimited subagents · Use any provider/model · Unlimited tool calls + iterations
           Agent loop auto-extends every 100 iterations. Retry failed tools; switch providers on 429.

WHAT "DONE" MEANS: Named artifact (passing test, file at a path, fixed bug verified by re-running)
                   A 10-second user verification recipe. No hedges.

WHAT IS NOT DONE: Unhandled error · empty result · "should I continue?" · partial progress as success

PERSISTENCE: Blocked? Try 3 angles. Tool failed? Read error, alter input, retry.
             Subagent useless? Respawn with tighter prompt.

BEGIN.]
```

`/goal` shows status + journal. `/goal clear` stops the engine. `/goal journal [N]` prints the FIFO ring (default 25, cap 500). Goal state lives in `goalState: 'active' | 'paused' | 'done'`.

### Multi-agent fleet + Director

**Fleet tools** (12 on the Director's belt from first message): `spawn_subagent`, `assign_task`, `await_tasks`, `ask_subagent`, `ask_result`, `roll_up`, `terminate_subagent`, `terminate_all`, `fleet`, `fleet_emit`, `collab_debug`, `work_complete`. The `fleet` tool consolidates status/usage/health/session queries behind an `action` parameter. Large `ask_subagent` responses (>2K chars) are stashed in a per-Director `LargeAnswerStore` and returned as a summary + key — the Director pulls the full text back with `ask_result` only when it needs it, so its context stays bounded no matter how many big asks happen.

**`/fleet`** command: `status` — task progress per subagent · `usage` — token + cost breakdown · `kill <id>` — stop one subagent · `kill` — stop all · `manifest` — full fleet snapshot · `log <id>` — transcript summary · `log <id> raw` — full JSONL dump · `journal` — recent parallel engine entries · `spawn <role> [count]` — spawn N subagents of a role · `terminate <subagentId>` — stop one · `retry <id>` — re-spawn a failed subagent · `stream on|off` — toggle live output streaming.

**`/spawn [--provider --model --name --tools] <task>`** — launch a single subagent. No implicit budget cap; runs until done.

**`/director`** — promote the session to Director mode at runtime (must be called before any subagent is spawned).

**`/autonomy parallel`** — LLM-driven fan-out mode described above.

**Subagent failure taxonomy** (14-kind discriminated union): `budget_timeout` (✓ retryable), `budget_tool_calls`, `budget_iterations`, `provider_rate_limit` (✓), `provider_5xx` (✓), `provider_auth`, `tool_failed`, `empty_response`, `aborted_by_parent`, `context_overflow`. Every failure includes `cause` (error name + message + stack). The delegate tool exposes `errorKind` / `retryable` / `backoffMs` so the calling LLM can branch on classification.

Architecture: Host EventBus (always-on bridge) → Leader Agent (Director) + FleetBus (director-only fan-in) → `DefaultMultiAgentCoordinator` → `AgentSubagentRunner` per task (fresh Agent + Context + EventBus, full isolation) → per-subagent JSONL transcripts on disk.

**47-agent roster + smart dispatcher.** The Director draws from a 47-role agent catalog; a smart dispatcher routes each task to the best-matching role instead of spawning generic clones. The TUI fleet monitor (**Ctrl+F**) shows per-subagent status and a fleet-wide token gauge, and auto-extended budgets surface as a `⚡ extended ×N` badge across all fleet UIs. Spawned subagents take a memorable scientist nickname (Turing, Shannon, Gauss, …) so you can track them across the fleet at a glance.

**Fleet supervision + peer awareness.** `await_tasks` can wait in `all` or `any` mode, so the Director can process early finishers while slower siblings keep working. A Brain-gated `FleetSupervisor` watches for pinned-task starvation, overloaded workers, deep backlogs, stuck agents, and failure streaks; it can retarget pending work, spawn helpers, steer workers, or notify the leader. Agents also see each other mid-run through the `[FLEET PULSE]` context digest, the read-only `fleet_status` tool, and rate-capped status broadcasts in the project mailbox.

**Collaborative debugging.** `Director.spawnCollab()` runs **BugHunter, RefactorPlanner, and Critic in parallel on one shared, immutable file snapshot**. Findings flow through the FleetBus as structured events (`bug.found → refactor.plan → critic.evaluation`); the Director routes each output to its dependents through a shared scratchpad — so agents build on each other's conclusions without exchanging full transcripts — and returns a single structured `CollabDebugReport`. Subagents signal upward with the `fleet_emit` tool.

**`--director` flag** launches the full fleet roster from the CLI directly:
```bash
wrongstack --director "audit src/ for security issues"
```

### Brain-governed decisions

Brain is a small authority layer for decisions that are bigger than one tool
permission prompt. Director and AutoPhase can ask a `BrainArbiter` whether to
continue, deny, or escalate a risky choice — for example extending a subagent's
budget or attempting an automatic worktree merge-conflict resolution.

The default Brain is conservative: low-risk requests with an explicit
recommended option can be answered automatically; higher-risk choices route to a
human decision prompt in the TUI. The prompt appears in chat history, the status
bar shows a compact `🧠` chip, and the answer flows back through typed
`brain.*` EventBus events.

### Spec-Driven Development (`/sdd`)

The `/sdd` slash command guides the agent through the SDD loop: an interactive Q&A interview → spec → implementation plan → task graph → execute. Built on `SpecParser`, `TaskTracker`, `TaskGenerator`, and `TaskFlow` from `@wrongstack/core/sdd`. `/sdd new` starts a session, `/sdd approve` advances each phase, and `/sdd tasks` / `/sdd graph` / `/sdd critical` track progress.

```ts
const parser = new SpecParser();
const spec = parser.parse(markdownSpec);
const analysis = parser.analyze(spec);

const tracker = new TaskTracker({ store });
const generator = new TaskGenerator({ taskTracker: tracker });
await generator.generateFromSpec(spec);

const flow = new TaskFlow({ tracker });
await flow.execute({ executeTask: async (task) => { /* ... */ } });
```

#### Parallel SDD — live multi-agent board

`/sdd parallel [slots]` fans the task graph out across a real subagent fleet
(`SddParallelRun` + `DefaultMultiAgentCoordinator`), with every run observable and
controllable on every surface:

- **Live board** — an `SddBoardProjector` turns `sdd.run.*` / `sdd.task.*` / `sdd.wave`
  events into a persisted snapshot rendered as an animated React-Flow DAG + kanban in the
  WebUI **Live Board** (both servers) and a TUI overlay (**Ctrl+B**) — live agent and
  worktree badges, an activity feed, and deadlock banners.
- **Continuous dependency scheduler** — a fast task's dependents start the moment their
  `dependsOn` edges are satisfied; independents run in parallel; chains run in order.
- **Per-task / per-run model + fallback** — pick a default model/provider/fallback chain
  for a run and override the worker model on any task (WebUI `ModelPicker` +
  `FallbackEditor`, or WS `set_task_model` / `set_task_fallbacks`).
- **Never stuck, never explode** — a verification gate (optional, opt-in from acceptance
  criteria via `WRONGSTACK_SDD_VERIFY_FROM_ACCEPTANCE=1`) and merge gate (each task in its
  own git worktree, success→squash-merge; opt-in conflict resolver via
  `WRONGSTACK_SDD_CONFLICT_RESOLVER=prefer-incoming|prefer-base|llm`, re-verified and
  reverted on regression); an idle reaper instead of a hard wall-clock kill; a bounded
  failed-task retry sweep; and a Brain `SddSupervisor` that, once retries are exhausted,
  reassigns the model, splits the task, or escalates.
- **Start from the WebUI** — the `SddInterviewDriver` wizard runs the whole goal → Q&A →
  spec → graph → run flow in the browser and drives a real fleet via the runtime light
  subagent factory.
- **Stop & lifecycle** — **Ctrl+C** stops a live run from the CLI/TUI; `/sdd stop`,
  `/sdd retry-failed`, `/sdd split <id> <A ; B>`, `/sdd clean` (remove managed worktrees),
  `/sdd rollback` (history-preserving `git revert` of the run's merge commits), and
  `/sdd destroy` (clean worktrees + delete specs/graphs/session/boards) round out control.

### Plugin ecosystem — `@wrongstack/plugins`

`@wrongstack/plugins` ships 36 official plugins in one package, each available via a subpath export (`@wrongstack/plugins/<name>`). The retired `web-search` and `json-path` plugin names are intentionally skipped at load time; use the built-in `search` / `fetch` and `json` tools instead.

| Plugin | Tools / hooks | Notes |
|--------|---------------|-------|
| `auto-doc` | `auto_doc` | JSDoc / TSDoc comment generation with dry-run preview |
| `git-autocommit` | `git_autocommit` | LLM-assisted conventional commit messages with staging support |
| `shell-check` | `shellcheck` | ShellCheck wrapper for files or directory scans |
| `cost-tracker` | `cost_summary`, `cost_reset`, `cost_export` | Token usage + estimated cost per model from provider events |
| `file-watcher` | `watch_start`, `watch_stop`, `watch_list` | Project file watchers that emit `file-watcher:changed` |
| `cron` | `cron_schedule`, `cron_list`, `cron_cancel` | Recurring tasks via iteration hooks |
| `template-engine` | `template_expand`, `template_render`, `template_create`, `template_list` | File templates with variable substitution and prompt contribution |
| `semver-bump` | `semver_bump`, `semver`, `semver_current`, `semver_changelog` | Conventional-commit-driven version bumps and changelog helpers |
| `secret-scanner` | PreToolUse / PostToolUse | Blocks, redacts, or warns on plaintext credentials in tool input/output |
| `todo-tracker` | `todo_tracker_*` | Persistent project todo backlog that survives sessions |
| `token-budget` | `token_budget_status`, hooks | Warns near a session token limit and can stop when exhausted |
| `lint-gate` | `lint_gate_status`, hooks | Runs Biome/ESLint before write/edit commits content |
| `branch-guard` | `branch_guard_status`, hooks | Blocks unsafe commits, pushes, and merges on protected branches |
| `diff-summary` | `diff_summary_status`, hooks | Injects compact git diff context after write/edit |
| `commit-validator` | `commit_validator_status`, hooks | Enforces conventional-commit shape before commit operations |
| `format-on-save` | `format_on_save_status`, hooks | Runs formatter after write/edit |
| `test-runner-gate` | `test_gate_status`, hooks | Runs relevant tests after source edits |
| `import-organizer` | `import_organizer_status`, hooks | Sorts imports and removes unused entries after write/edit |
| `todo-listener` | `todo_listener_status`, hooks | Broadcasts todo-list snapshots to the project mailbox |
| `session-recap` | `session_recap_status`, Stop hook | Posts a session summary to the project mailbox |
| `spec-linker` | `spec_linker_status`, hooks | Finds unlinked plugin references in markdown and can auto-link them |
| `loop-breaker` | hooks | Detects identical-repeat and A-B-A-B tool-call loops |
| `path-guard` | `path_guard_status`, hooks | Blocks writes/destructive commands touching protected paths |
| `context-pins` | `pin_add`, `pin_remove`, `pin_list` | Pinned facts persist across sessions and compaction |
| `checkpoint` | `checkpoint_create`, `checkpoint_list`, `checkpoint_restore` | Captures file snapshots before edits and restores them on demand |
| `error-lens` | `error_lens_history`, hooks | Distills failed command output into compact error context |
| `dep-guard` | `dep_guard_status`, hooks | Supervises dependency installs for deny lists, typosquats, and unpinned versions |
| `config-validator` | `config_validator_status`, hooks | Validates JSON/JSONC/YAML/TOML after edits |
| `notify-hub` | `notify_send`, `notify_hub_status`, hooks | Sends session/tool/budget notifications to a webhook |
| `changelog-writer` | `changelog_add`, `changelog_preview`, `changelog_write` | Collects session work and writes Keep-a-Changelog entries |
| `injection-shield` | `injection_shield_status`, hooks | Flags prompt-injection patterns in tool output |
| `llm-cache` | `llm_cache_status`, `llm_cache_clear`, provider wrapper | Opt-in deterministic provider-response cache |
| `model-router` | `model_router_status`, provider wrapper | Opt-in request-size/tool-aware model routing within the active provider |
| `prompt-firewall` | `prompt_firewall_status`, provider wrapper | Opt-in credential-leak scanner on the provider wire |
| `auto-escalate` | `auto_escalate_status`, error hook | Opt-in retry ladder for transient provider failures |
| `token-throttle` | `token_throttle_status`, provider wrapper | Opt-in rolling tokens-per-minute throttle |

All plugins type-check under `strict` + `noUncheckedIndexedAccess`, use the real plugin API (`api.onEvent`, hooks, and `AgentExtension` wrappers rather than ad hoc pipeline mutation), and ship `Record<string, unknown>` typings on every tool `execute`.

#### Core first-party plugins

Eight core plugins ship **enabled by default** and load before user plugins — they wire core infrastructure and claim bare slash-command names (only `official` first-party plugins may do so; external plugins stay namespaced). Opt a specific one out with `{ "name": "wstack-git", "enabled": false }` in `config.plugins`, or disable all with `features.plugins: false`.

| Built-in plugin | Slash commands | What it adds |
|-----------------|----------------|--------------|
| `wstack-prompts` | `/prompts`, `/prompt`, `/prompt-gen` | Personal prompt library, merged prompt search, and AI prompt authoring |
| `wstack-sync` | `/sync status\|enable\|disable\|push\|pull\|categories` | GitHub cloud sync for settings, skills, prompts, memory, and history — token encrypted via the secret vault, no `git` CLI needed |
| `wstack-git` | `/commit`, `/gitcheck`, `/push` | LLM-written conventional commits, pre-commit sanity check, push |
| `wstack-observability` | `/metrics`, `/health` | Prometheus metrics + health snapshot |
| `wstack-security` | _backend_ | Security scanning orchestrator; the CLI owns the `/security` command surface |
| `wstack-chimera` | `/chimera` | Post-session code quality review agent and configuration status |
| `wstack-skills` | `/skill`, `/skill-gen`, `/skill-search`, `/skill-install`, `/skill-import`, `/skill-update`, `/skill-uninstall` | Skill discovery, registry search, generation, import, install, update, and uninstall |
| `wstack-plan` | `/plan show\|add\|start\|done\|remove\|clear` | Per-session strategic roadmap (chip in the TUI status bar) |

**Cloud sync** (`/sync`) pushes/pulls user-selected `~/.wrongstack` categories — `settings`, `skills`, `prompts`, `memory`, `history` — to a private GitHub repo over the REST API. State lives in `~/.wrongstack/sync.json` (token encrypted) + `sync-state.json`; pick categories with `/sync categories`. Pulls validate every remote tree entry and reject traversal (`..`, absolute paths, or paths resolving outside the category root); file-backed categories such as `settings` also reject nested paths.

Manage from CLI or REPL:
```bash
wstack plugin list
wstack plugin install telegram
wstack plugin official
wstack plugin disable telegram
wstack plugin enable telegram
wstack plugin remove telegram
```
`telegram` and `lsp` are bundled aliases for `@wrongstack/telegram` and `@wrongstack/plug-lsp`.

### Sign in with a subscription (OAuth)

Authenticate against a vendor **subscription** instead of a metered API key — an
orthogonal credential layer that sits *next to* the API-key providers, not in
place of them:

```bash
wstack auth login chatgpt     # ChatGPT Plus/Pro/Team (Codex) → provider openai-codex
wstack auth login claude      # Claude Pro/Max               → provider anthropic-oauth
wstack auth login copilot     # GitHub Copilot               → provider github-copilot
# or: wstack auth → "s) Sign in with a subscription"
```

Inside a live session, `/auth` opens the same interactive key manager as an Ink/TUI panel; `/auth login` jumps straight to the OAuth view. In the plain REPL, `/auth` stays non-blocking and shows a saved-provider/key dashboard plus the `wstack auth` command to run for edits.

Codex and Claude use a PKCE loopback flow; Copilot uses GitHub's device flow.
Tokens self-refresh (near-expiry + once on `401`) and are AES-256-GCM encrypted
at rest like any other secret. After login, select the provider/model from the
`/model` picker or with `--provider … --model …` — eligible long-context
models serve their full **1M-token** context on this path automatically.

> ⚠️ **Using a subscription outside its official client is a ToS gray area and
> can get your account rate-limited or banned.** The sanctioned path for
> programmatic use is an API key; sign in with a subscription only if you accept
> that risk. Full reference + per-provider details: [`docs/oauth-signin.md`](docs/oauth-signin.md).

### Provider catalog (~140 providers, 4 API-key families + 3 subscription families + 1 stub)

| Family | Transport | Providers |
|--------|-----------|-----------|
| `anthropic` | Native Claude API + SSE | Anthropic, MiniMax, Kimi, Google Vertex (Anthropic) |
| `openai` | Native OpenAI Chat Completions + SSE | OpenAI, Perplexity Agent, Vivgrid |
| `openai-compatible` | OpenAI-spec endpoints + SSE | ~125 providers: Mistral, Groq, DeepSeek, OpenRouter, Together, xAI, Cerebras, Ollama, Fireworks, Moonshot, GLM, Alibaba, … |
| `google` | Gemini `:streamGenerateContent?alt=sse` | Google AI Studio |
| `anthropic-oauth` | Claude Messages API + Bearer (OAuth) | Claude Pro/Max — *Sign in with Claude* |
| `openai-codex` | ChatGPT Responses API (OAuth) | ChatGPT Plus/Pro/Team — *Sign in with ChatGPT* |
| `github-copilot` | Copilot proxy, OpenAI wire (OAuth) | GitHub Copilot — *Sign in with Copilot* |
| `unsupported` | Needs plugin | Cohere, Bedrock, Vertex (non-Anthropic), Azure |

All four supported families implement **real streaming** end-to-end: `provider.stream()` is the source of truth, `complete()` is `aggregateStream(stream(...))`. Mid-stream aborts preserve any partial assistant text already received. Catalog comes from `models.dev/api.json` — no hardcoded pricing, no hardcoded model names — and is refreshed synchronously on boot so provider resolution, model capabilities, and the TUI picker see fresh data before the app starts. The refresh has a 15-second timeout and falls back to cache with a warning; use `--no-models-refresh` for offline or CI runs.

**Vision MCP adapters**: text-only models work with images via MCP server adapters:
```bash
wstack mcp add zai-vision --enable
wstack mcp add minimax-vision --enable
```
When the active model lacks native vision, WrongStack writes clipboard images to a temp file, invokes the adapter, replaces the image with the returned text, then removes the temp file.

### Session persistence + resume

Every run writes a `<id>.jsonl` append-only event log under `~/.wrongstack/projects/<sha256>/sessions/`. On close, a tiny `<id>.summary.json` manifest is written alongside — now analytics-grade: title, optional user `name`, model, provider, tokenTotal, `endedAt`, `iterationCount`, `toolCallCount`, `toolErrorCount`, `fileChangeCount`, `compactionCount`, a per-tool `toolBreakdown`, and an `outcome` (`completed` / `error` / `timeout` / `aborted`). `wrongstack sessions` lists hundreds of past runs without re-parsing each JSONL (O(N) stats, not O(N) full parses). `session_resumed` marker written on resume. Orphan `tool_result` events (missing matching `tool_use`) emit `session.damaged` event so the session can be flagged for repair. Renames persist through `/sessions rename` and the WebUI sidebar; deletes refuse to remove sessions still referenced by `active.json` or another live surface in the shared `SessionRegistry`. Housekeeping: `/prune` deletes stale sessions (and their summary / plan / todos sidecars) by age, and `/prune --rebuild-index` rebuilds the session index from disk.

### Encrypted secrets

API keys and MCP auth tokens encrypted with **AES-256-GCM** using a 32-byte key kept at `~/.wrongstack/.key` (mode `0600` on POSIX). Format: `enc:v1:<iv>:<tag>:<ciphertext>`. Random IV per encryption — same plaintext yields different ciphertexts. The CLI auto-migrates plaintext keys it finds in `config.json` on every boot. Field detection is regex-based (`/apikey|authtoken|bearer|secret|password|refreshtoken|sessionkey|access[_-]?token|private[_-]?key/i`); `publicKey` is on a hard-coded override list.

### Mode system (8 personas)

Agents can operate in different modes that inject role-specific system prompts: `default`, `code-reviewer`, `code-auditor`, `architect`, `debugger`, `tester`, `devops`, `refactorer`. Modes live in `~/.wrongstack/modes/` and can be extended with custom prompts.

```ts
import { DefaultModeStore } from '@wrongstack/core';
import { createModeTool } from '@wrongstack/tools';

const modeStore = new DefaultModeStore({ directory: '~/.wrongstack/modes' });
const modeTool = createModeTool(modeStore);
await modeTool.execute({ action: 'set', mode: 'code-reviewer' });
```

### Context window policies

Switch how aggressively the session trims history: `balanced` (default), `frugal` (most token-friendly), `deep` (preserves more recent turns), `archival` (steady decision-preserving compaction). Use `/context mode` to list policies and switch at runtime. `repair` to fix damaged tool-call adjacency.

### Observability — 97 typed events

`EventBus` carries events across Brain, Session, Agent, Iteration, Provider, Tool, Storage, Delegation, Context, Token/budget, Compaction, Subagent, Fleet Supervisor, SDD, MCP, Worktree, Memory, and Client categories. Subscribe with `events.on(name, fn)` or `events.once(name, fn)`; listeners that throw are caught and logged, never re-thrown.

Five-layer observability:
- **Human view (TUI)**: LiveActivityStrip (top-4), FleetPanel, lifecycle chips on failures
- **Host EventBus** (always-on): lifecycle + per-tool bridge
- **FleetBus** (director-only): full per-subagent event stream — `tool.*`, `iteration.*`, `provider.{text,thinking}_*`, `compaction.*`, `token.*`
- **HQ bridge** (optional): session, transcript, fleet, Brain, worktree, tool, and cost telemetry over `/ws/client`
- **Per-subagent JSONL on disk**: `/fleet log <id>` summarises, `/fleet log <id> raw` dumps full transcript

### Security

- **Permission policy** (`trust.json`): per-tool allow/deny, persisted to disk, applies to subagents
- **YOLO mode** (`--yolo` or `/yolo`): auto-approves normal project work; clearly destructive calls still require explicit confirmation
- **Bash tool env allowlist**: `WRONGSTACK_BASH_ENV_PASSTHROUGH=1` disables the allowlist (legacy unsafe mode — see `SECURITY.md`)
- **`WRONGSTACK_FETCH_ALLOW_PRIVATE=1`**: enables localhost/private IPs in the `fetch` tool
- **AES-256-GCM** encryption for all secrets at rest
- **SSRF guard everywhere**: the `fetch` tool and the builtin `search` tool resolve + re-validate every redirect hop against private/IMDS ranges; MCP transport URL validation blocks IPv4 **and** IPv6 IMDS (`fd00:ec2::254`, link-local `fe80::/10`)
- **Fail-closed subagent guard**: the non-interactive `AutoApprovePermissionPolicy` is **allowlist-by-default** — it approves only an explicit set of safe tools, so newly-added mutating tools (and all `mcp__*` tools) are denied to prompt-injected delegates by default instead of slipping through a denylist gap
- **Session-log scrubbing**: user- and model-turn text is scrubbed before it hits the `0o600` JSONL (and before it rides along in cloud sync), not just tool output
- **WebUI broadcast redaction**: `tool.started` and `tool.executed` payloads are scrubbed before WebSocket broadcast, so API keys and bearer tokens don't leak to connected tabs
- **Cloud-sync path containment**: pulled remote entries are rejected if they traverse outside their category root; file-backed categories reject nested paths
- **Symlink containment**: `read`/`edit`/`write` resolve symlinks and re-check the target is inside the project root
- **Plugin trust tiers + capability gating**: only first-party (`official`) plugins may register bare slash-command names; tool `wrap`/`override`/`unregister` is gated on **declared capabilities** in addition to the officiality tier, so a plugin can only mutate tools it is actually authorized for
- Threat model and adversary trust assumptions in [`SECURITY.md`](SECURITY.md); audit findings and verification in [`security-report/`](security-report/)

### Bundled skills (23)

`api-design`, `audit-log`, `bug-hunter`, `chimera`, `docker-deploy`, `git-flow`, `mailbox-bridge`, `multi-agent`, `node-modern`, `observability`, `output-standards`, `plugin-author`, `prompt-engineering`, `react-modern`, `refactor-planner`, `research-web`, `sdd`, `security-scanner`, `skill-creator`, `tech-stack`, `testing`, `typescript-strict`, `wrongstack-mailbox` — all following one structure (Overview → Rules → Patterns → Skills in scope). Discovered in order: project → user → bundled, with first-seen winning on name collisions.

### Token-saving mode (`--token-saving-mode`)

A lean operating mode that shrinks the per-request prompt without going fully
offline. Three levers compound:

- **Tier-1 tool belt** — the 90+ built-in tools collapse to **10 essentials**
  (`read`, `write`, `edit`, `bash`, `grep`, `glob`, `diff`, `patch`, `json`,
  `search`), trimming ~4000–6000 tokens of tool-definition overhead.
- **Compact skills** — each in-scope skill renders only its *Overview + Rules*
  sections (or a dedicated `SKILL.save.md` variant when the skill ships one).
- **Lazy MCP** — MCP server tools are no longer expanded into the tool list at
  startup; the model reaches any of them on demand through the `mcp_use({ server,
  tool, input })` meta-tool, so the registered surface stays bounded no matter
  how many MCP servers are connected.

Toggle it at launch with `--token-saving-mode` (or `features.tokenSavingMode` in
config), or live from the TUI settings panel — the status bar shows a token-
saving indicator and the current registered-tool count.

### `--no-features` minimal kernel

Flips off MCP, plugins, memory tools, models.dev fetch, and skill discovery. What's left: kernel (`Container` + `Pipeline` + `EventBus` + `RunController`, ~1670 lines incl. events) + agent (525 lines) + 36 tools + permission policy + curated system prompt. The minimal-viable WrongStack runs offline with no network calls at startup. Provider family must be declared explicitly in config when using this mode.

---

## Recent changes

**Current package line: 0.282.0.** Highlights include fleet supervision and
peer awareness, the cross-machine HQ command center with token-scoped control
and persisted telemetry, the Electron Desktop surface (`wrongstack --desktop`,
`wstack desktop`, `wrongstack-desktop`), the interactive in-session `/auth`
panel, skill registry search/install authoring improvements, the 36-plugin
official suite, and package coverage for ACP, bench, WebUI HQ, and Desktop
alongside the CLI/TUI/WebUI stack.

See **[CHANGELOG.md](CHANGELOG.md)** for the full, versioned history.

## Quick start

```bash
# First run — interactive auth/setup
wrongstack auth

# Sign in with ChatGPT/Codex subscription OAuth
wstack auth login chatgpt

# No config? Interactive picker launches automatically:
wrongstack          # provider list → model list → save prompt → REPL
wrongstack --tui    # same, then enters TUI
wrongstack --webui --open  # serve browser UI and open it

# TUI + YOLO (auto-approve normal project work)
wrongstack --tui --yolo

# Desktop shell
wrongstack --desktop
wstack desktop

# Specific provider/model — skip the picker
wrongstack --provider groq --model llama-3.3-70b-versatile

# Director fleet orchestration
wrongstack --director "audit src/ for security issues"

# Single-shot query
wrongstack "refactor src/auth.ts to async/await"

# Resume a saved session
wrongstack --resume <session-id>
wrongstack resume <session-id>       # same
```

### First-run setup

Three ways to configure:

1. **`wrongstack auth`** — interactive credential manager, saves encrypted credentials to `~/.wrongstack/config.json`
   - Shortcut: **`wstack auth login chatgpt`** starts the ChatGPT/Codex OAuth flow directly.
2. **Automatic picker** — just run `wrongstack` with no config; saves after selection
3. **CLI flags** — `wrongstack --provider <id> --model <id>` — skips all interactivity

Add a key later: `wrongstack auth groq` (prompts, encrypts, stores).

### Switching providers at runtime

In the **TUI**, `/model` opens a two-step provider → model picker with **type-to-search filtering** in step 2 — no restart needed. After picking a provider, type printable characters to filter models live, use Backspace to edit the filter, and navigate long lists through a centered 10-row window with `▲ N above` / `▼ N below` indicators. In the plain REPL, relaunch with `--provider` / `--model`:

```bash
wrongstack --provider openai --model gpt-5.5
wrongstack --provider deepseek --model deepseek-v4-pro
wrongstack --provider openrouter --model anthropic/claude-opus-4-7
```

## CLI flags

```
--provider <id>      Override provider (e.g. anthropic, openai, groq)
--model <id>         Override model
--cwd <path>         Project root (default: process.cwd())
--resume <id>        Resume a saved session
--record             Record provider request/response to a replay log
--replay <id>        Replay a recorded session deterministically (no API calls)
--tui                Use the Ink TUI instead of readline REPL
--no-tui             Force-disable the TUI (overrides --tui)
--mouse              Full mouse mode in the TUI (in-app scroll + clickable UI)
--webui              Serve the browser UI + WS bridge for this project
--desktop            Open WrongStack Desktop (requires @wrongstack/desktop)
--hq                 Start the project-independent HQ command center
--host <addr>        HQ bind host (default 127.0.0.1; use 0.0.0.0 for LAN)
--port <n>           HQ bind port (default 3499)
--strict-port        HQ: fail if the requested port is busy
--data-dir <path>    HQ data directory (auth.json, events, snapshot, trends)
--hq-allow-exec      Allow HQ run-command requests to route to the leader as steer
--open               Open the browser for --webui / --hq
--no-interactive     Skip interactive provider/model setup; require saved config
--no-banner          Suppress the startup banner
--no-features        Minimal kernel — no MCP, plugins, memory, models.dev, skills
--no-models-refresh  Skip the boot-time models.dev catalog refresh (offline/CI)
--skip-index         Skip codebase indexing and large-codebase prompt
--token-saving-mode  Lean prompt: 10 Tier-1 tools, compact skills, lazy MCP (mcp_use)
--yolo               Auto-approve normal project work; destructive calls still prompt
--director           Enable Director-based fleet orchestration (LLM-driven subagent planning)
--goal "<task>"      Boot directly into goal mode — GOAL preamble injected, TUI auto-enabled
--eternal "<task>"   Start an eternal-autonomy loop against a goal
--ask "<text>"       Submit one turn verbatim on TUI boot (no preamble)
--verbose / -v       Log level → debug
--trace              Log level → trace
--log-level <lvl>    Explicit log level
--help / --version   Standard
```

## Slash commands

**Core** (both the plain REPL and the TUI): `/init` `/help` `/clear` `/compact` `/context` `/codebase-reindex` `/dev` `/diag` `/doctor` `/stats` `/tools` `/tool` `/plugin` `/mcp` `/auth` `/hq` `/memory` `/todos` `/tasks` `/mode` `/mouse` `/yolo` `/autonomy` `/interrupt` `/btw` `/next` `/enhance` `/fix` `/autophase` `/worktree` `/settings` `/sdd` `/save` `/load` `/prune` `/exit`

Every built-in command is tagged with a category (`Run` · `Session` · `Inspect` · `Agent` · `Config` · `App`); the TUI slash picker groups matches under category headers, and the WebUI surfaces 55 commands in its slash list.

**Multi-agent:** `/spawn` `/fleet` `/agents` `/shadow` `/supervisor` `/goal` `/director` `/collab` `/setmodel` `/models` `/fallback`

**TUI-only** (need `--tui`): `/model` (provider → model picker) · `/steer` (mid-flight redirect — the plain REPL uses **Esc** instead) · `/queue`

**Built-in plugins** (enabled by default): `/prompts` `/prompt` `/prompt-gen` `/sync` `/commit` `/gitcheck` `/push` `/security` `/chimera` `/skill` `/skill-gen` `/skill-search` `/skill-install` `/skill-import` `/skill-update` `/skill-uninstall` `/plan` `/metrics` `/health`

`/telegram` becomes available once the Telegram plugin is enabled — `wstack plugin install telegram`.

| Command | Effect |
|---|---|
| `/init` | Create `.wrongstack/AGENTS.md` — auto-detects build system (package.json / pyproject.toml / go.mod / Cargo.toml / Makefile) and pre-fills build/test/lint/run commands |
| `/dev <shell command>` | Run a shell command from the chat input and see the output. The LLM does NOT see the result — this is a developer convenience shortcut. Timeout: 60 s. Max output: 500 lines |
| `/spawn [--provider --model --name --tools] <task>` | Launch a single subagent with optional overrides. No implicit budget cap |
| `/director` | Promote session to Director mode at runtime (must be before any subagent spawns) |
| `/fleet status\|usage\|kill\|manifest\|retry\|log\|stream on\|off\|journal\|spawn\|terminate` | Inspect and control the subagent fleet. `log <id>` summarises; `log <id> raw` dumps full JSONL |
| `/agents` | Print fleet roster (running, idle, completed) with kind chips for failures |
| `/supervisor [status\|on\|off\|log [n]]` | Inspect or toggle the Brain-gated fleet supervisor. It starts with the Director fleet when a Brain is available and can rebalance pending tasks, spawn helpers, steer workers, or notify the leader |
| `/steer <text>` | _(TUI; in the plain REPL use **Esc**)_ Mid-flight redirect — aborts iteration, terminates fleet, drops queue, prepends STEERING preamble |
| `/goal <text>` | Lock in a goal — auto-refines it into deliverables, persists to `~/.wrongstack/projects/<hash>/goal.json`, tracks progress/trends, and injects the full-autonomy preamble. Subcommands: `/goal` (status + journal), `/goal refine`, `/goal clear`, `/goal pause`, `/goal resume`, `/goal journal [N]` |
| `/tasks add\|start\|done\|fail\|status\|depends\|assign\|promote\|clear` | Structured task management between `/plan` and `/todos`: dependencies, types, priorities, estimates, agent assignment, and promote-to-todos flow |
| `/queue` | _(TUI)_ Show, clear, or delete entries from the in-flight message queue. `/queue picker on\|off` toggles the mid-run send-mode picker (Queue / By the way / Steer) that pops when you submit a plain message while the agent is busy |
| `/plan show\|add\|start\|done\|remove\|clear` | Per-session plan JSON. Mirrored to disk; surfaces `📋 ⌛N ☐N ✓N` chip in TUI status bar |
| `/autonomy off\|suggest\|on\|eternal\|parallel\|stop\|toggle` | Self-driving mode. `suggest` shows next steps without executing; `on` auto-continues; `eternal` runs goal-driven loop; `parallel` fans out 4-8 subagents per tick. TUI shows `∞ AUTO` / `∞ SUGGEST` / `ETERNAL` / `⟳ PARALLEL` chip |
| `/yolo on\|off\|toggle` | Flip YOLO mode (auto-approve normal project work; destructive calls still prompt). `/yolo` alone shows status. TUI shows `⚠ YOLO` chip |
| `/interrupt` (aliases `/stop`, `/int`) | Stop the in-flight leader run **and** terminate the whole fleet — for when `Esc` is eaten by tmux or you're driving from the WebUI. REPL `Ctrl+C` now also stops subagents |
| `/mode` | Switch persona: `default`, `code-reviewer`, `code-auditor`, `architect`, `debugger`, `tester`, `devops`, `refactorer`. Custom modes in `~/.wrongstack/modes/` |
| `/model` | _(TUI)_ Two-step provider → model picker. In the plain REPL, relaunch with `--provider` / `--model` |
| `/setmodel <key> <provider/model>` | Set per-role or per-phase model in the model matrix (e.g. `/setmodel security-scanner openai/gpt-4o`). Also supports `resolve <role>` and `doctor` for matrix diagnostics |
| `/fallback` | View or edit the rate-limit fallback chain. On a `429`/`529`/`5xx` after retries, the agent rotates to the next model in the chain instead of failing; each hop prints `↻ switched to <provider/model>` |
| `/auth [login\|status <provider>\|open\|help]` | In-session credential manager. In TUI, opens the interactive key/OAuth panel (`/auth login` jumps to OAuth); in REPL, shows a non-blocking provider/key dashboard and points to `wstack auth` for edits |
| `/hq [status\|set <url> [token]\|token <token>\|on\|off\|clear]` | Configure this client’s HQ telemetry connection. Local `wstack --hq` is auto-discovered through `~/.wrongstack/hq/runtime.json`; remote HQs use URL + client token |
| `/image` or `/paste-image` | Attach clipboard PNG. TUI also `Alt+V` |
| `/context mode <policy>` | Switch context-window mode: `balanced`, `frugal`, `deep`, `archival`. `repair` fixes damaged tool-call adjacency |
| `/plugin install\|disable\|enable\|remove\|official [name]` | Manage plugins. `install` adds bundled package to config (no npm). Restart to load/unload |
| `/telegram send\|read\|chat\|attach` | Telegram plugin (enable with `wstack plugin install telegram`): `send <chatId> <message>`, `read <chatId> [limit]`, `chat` list recent, `attach <file>` send file |
| `/sdd new\|approve\|spec\|tasks\|graph\|critical\|parallel\|stop\|retry-failed\|split\|clean\|rollback\|destroy` | Spec-Driven Development workflow: interactive interview → spec → plan → task graph → execute. `parallel [slots]` fans out a real subagent fleet onto the live board; `clean`/`rollback`/`destroy` manage worktrees and run history. Built on `SpecParser`, `TaskTracker`, `TaskGenerator`, `TaskFlow`, `SddParallelRun` |
| `/tool <name> desc\|result simple\|extend` | Two independent axes: `desc simple\|extend` sets the LLM-side description detail (trims prompt overhead), `result simple\|extend` sets the on-screen result preview (never changes what the model sees). Legacy `/tool <name> simple\|extend` still sets both. Shown in `/tools` output |
| `/shadow start\|stop\|status\|hoop\|model\|interval` | Manage the event-driven Shadow Agent fleet monitor: runs one-shot fleet checks, detects loops/spike tasks, and can `hoop <agent-id>` to stop a runaway agent and notify |
| `/settings` | View or change settings (non-blocking, works in REPL + TUI): `/settings` (show), `/settings delay <seconds>`, `/settings mode <off\|suggest\|auto>`, `/settings defaults`; persists to `~/.wrongstack/config.json` |
| `/prune [days] [--dry-run] [--rebuild-index]` | Delete sessions older than N days (default 30, clamped 1–365). `--dry-run` previews; `--rebuild-index` rebuilds the session index from disk. Sessions referenced by `active.json` are never pruned |
| `/compact`, `/tools`, `/skill`, `/save`, `/resume`, `/help`, `/clear`, `/stats`, `/diag`, `/exit` | Compact context, list tools/skills, save/resume session, help, clear, token+cost stats, diagnostics, exit |

### Mid-flight controls

| Key / Command | What it does |
|---|---|
| **Esc** (while busy) | Soft interrupt — abort agent, terminate fleet, drop queue, set "steering pending". Next message carries a STEERING preamble |
| `/steer <text>` | Same as Esc + typing, in one shot. Works when Esc is eaten by tmux |
| `/goal <text>` | "No force stops this" — full autonomy contract. Only Esc / Ctrl+C interrupt |
| **Ctrl+C** × 1 | Cancel current iteration + terminate fleet (1.5s cap) |
| **Ctrl+C** × 2 | Force-exit Ink loop |
| **Ctrl+C** × 3 | Hard `process.exit(130)` |
| **Ctrl+B** | Toggle the SDD live board overlay — parallel-run task graph, live agents, worktrees, and feed (`c` clean / `z` rollback) |
| **Ctrl+F** | Toggle the fleet monitor — per-subagent status + fleet-wide token gauge |
| **Ctrl+G** | Toggle the agents monitor — live per-agent context (current tool, streaming tail, sparkline) |
| **F9** | Toggle the goal panel — refined mission, deliverables checklist, progress bar, trend, state, and last task |
| **Ctrl+T** | Toggle the worktree monitor — AutoPhase isolation branches |
| **Ctrl+P** | Toggle the phase monitor — active AutoPhase phases and tasks |
| **Ctrl+T** | Close worktree monitor (when open); otherwise delete word before cursor |
| `/fleet kill <id>` | Stop one specific subagent |

## Subcommands

```bash
wrongstack init           # First-run setup wizard
wrongstack auth           # Interactive credential manager
wrongstack auth <prov>    # Store an API key (prompted, encrypted at rest)
wrongstack auth list|status|remove <id>  # Inspect or remove saved credentials
wrongstack webui          # Serve the browser UI (alias: --webui)
wrongstack desktop        # Open WrongStack Desktop (alias: --desktop)
wrongstack hq             # Start HQ command center (alias: --hq)
wrongstack hq token create|list|revoke [--client]  # Manage browser/client HQ tokens
wrongstack sessions       # List saved sessions for this project
wrongstack resume <id>    # Continue a saved session
wrongstack replay <id>    # Inspect a recorded replay log (see --replay)
wrongstack audit <id>     # Verify the SHA-256-chained tool-call audit trail
wrongstack config         # Show / edit config
wrongstack tools          # List registered tools
wrongstack skills         # List discovered skills
wrongstack providers      # ~140 providers grouped by wire family
wrongstack models [prov] [--search <term>] [--page N] [--per-page N]  # searchable, paginated model list
wrongstack models hide|show|hidden|reset <id>  # curate which catalog models appear in pickers + listings
wrongstack mcp            # Inspect connected MCP servers
wrongstack plugin         # Plugin manifest commands
wrongstack diag           # Diagnostics: provider, tokens, paths
wrongstack doctor         # Health checks
wrongstack export <id>    # Render/export a session
wrongstack usage          # Token + cost totals across sessions
wrongstack projects       # List known project hashes → paths
wrongstack help           # Help text
wrongstack version        # Version
```

## Configuration

### Environment variables

| Variable | Description |
|----------|-------------|
| `<PROVIDER>_API_KEY` | API key for the provider (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) |
| `WRONGSTACK_FETCH_ALLOW_PRIVATE` | Set to `1` to allow localhost / private IPs in the `fetch` tool |
| `WRONGSTACK_BASH_ENV_PASSTHROUGH` | Set to `1` to disable the bash-tool env allowlist (legacy unsafe mode — see `SECURITY.md`) |

### Config file (`~/.wrongstack/config.json`)

```jsonc
{
  "version": 1,
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "providers": {
    "anthropic": { "apiKey": "enc:v1:<iv>:<tag>:<ciphertext>" }
  },
  "features": {
    "mcp": true,
    "plugins": true,
    "memory": true,
    "modelsRegistry": true,
    "skills": true
  },
  "plugins": []
}
```

`apiKey`-like fields are auto-encrypted on first contact. Plaintext keys in older config files get migrated transparently on boot.

### Project-level (`<project>/.wrongstack/AGENTS.md`)

Commit this file to share project conventions with the agent across all developers:

```
// Conventions for this repo
- Always run tests after editing
- Use pnpm, not npm
- PR titles follow conventionalcommits.org
```

## Four contracts

**1. Minimal kernel.** `Container`, `Pipeline`, `EventBus`, `RunController`, and the token table total **~1670 lines** (including the full event type catalog). The agent loop adds another **525 lines**. Everything else is replaceable.

**2. Zero non-overridable behavior.** 16 services bound through `Container` (Logger, TokenCounter, SessionStore, MemoryStore, PermissionPolicy, Compactor, PathResolver, ConfigLoader, Renderer, InputReader, ErrorHandler, RetryPolicy, SkillLoader, SystemPromptBuilder, SecretScrubber, ModelsRegistry). 6 pipelines as middleware chains. Tools, providers, MCP servers, and slash commands all live in registries.

**3. Standalone sufficiency.** Works with 36 built-in tools, 4 wire-family transports, permission policy, and a curated system prompt — no plugins required.

**4. Layered, not monolithic.** `--no-features` flips off MCP, plugins, memory tools, models.dev fetch, and skill discovery. The minimal-viable WrongStack runs offline with no network calls at startup.

## Packages

| Package | Purpose |
|---------|---------|
| `@wrongstack/core` | Kernel, agent, types, registries, plugin contract |
| `@wrongstack/runtime` | Default runtime implementations, host composition helpers, extension pack contracts |
| `@wrongstack/providers` | Anthropic/OpenAI/OpenAI-compatible/Google wire adapters + SSE |
| `@wrongstack/tools` | 36 built-in tools (incl. SQLite codebase index) |
| `@wrongstack/mcp` | MCP server registry + reconnection logic |
| `@wrongstack/acp` | Agent Client Protocol client + agent support |
| `@wrongstack/bench` | Model-independent benchmark harness (Aider polyglot + SWE-bench Verified) |
| `@wrongstack/cli` | REPL, subcommands, slash commands, terminal renderer |
| `@wrongstack/tui` | Ink-based TUI (lazy-loaded behind `--tui`) |
| `@wrongstack/plug-lsp` | LSP plugin (`wrongstack-lsp-setup` binary) |
| `@wrongstack/telegram` | Telegram plugin: send/read/notifications, `/telegram:*` slash commands |
| `@wrongstack/webui` | Standalone web UI — `wstackui` binary, also via `wrongstack --webui` |
| `@wrongstack/webui-hq` | React HQ Command Center dashboard for `wrongstack --hq` |
| `@wrongstack/desktop` | Electron desktop shell — `wrongstack --desktop`, `wstack desktop`, `wrongstack-desktop` |
| `@wrongstack/plugins` | Official plugin collection — 36 plugins via subpath exports |

## Architecture

```
CLI       → REPL, renderer, slash commands, subcommands
TUI       → Ink frontend (lazy-loaded behind --tui)
WebUI     → Browser UI + WS bridge (standalone wstackui or --webui)
Desktop   → Electron shell hosting token-required local WebUI runtimes (--desktop)
HQ        → Cross-machine command center (--hq)
Steering  → Esc / /steer / /goal — mid-flight redirect + autonomous lock-in
Director  → Fleet orchestration (LLM-driven, opt-in via --director)
Agent     → loop, context, system prompt, permission, compaction, autoExtendLimit
Tools     → ToolExecutor (parallel/sequential/smart strategies, abort-safe)
Runtime   → Default host assembly + WrongStackPack extension composition
Kernel    → Container · Pipeline · EventBus · RunController (the 4 primitives)
Provider  → 4 wire families, factories built from ModelsRegistry, real SSE
Models    → models.dev/api.json fetched + cached + classified
```

For the full walk-through — including the L1-A reactive `ConversationState`, how the six pipelines fire per turn, and how plugins / MCP / observability plug in — see [`docs/architecture.md`](docs/architecture.md).

## Status

- **9300+ tests passing** across 500+ test files in the release gate
- Coverage thresholds: ≥85 % lines / ≥85 % functions / ≥70 % branches / ≥82 % statements
- All workspace packages build clean with TypeScript strict + `noUncheckedIndexedAccess`
- Node 22.19+ only, ESM-only, no CommonJS bundles
- Release gate verified locally: `pnpm audit --audit-level=moderate` + `pnpm typecheck` + `pnpm test` + `pnpm build`
- Threat model: [`SECURITY.md`](SECURITY.md)

## Contributor docs

| Doc | What it covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Package layout, kernel primitives, agent lifecycle, L1-A reactive split |
| [`docs/slash/`](docs/slash/) | Full reference for every built-in slash command |
| [`docs/subcommands/`](docs/subcommands/) | Full reference for every `wstack <subcommand>` |
| [`docs/director-architecture.md`](docs/director-architecture.md) | Director: FleetBus, prompt layering, safety caps, per-subagent JSONL, shared scratchpad |
| [`docs/plugin-author-guide.md`](docs/plugin-author-guide.md) | Building a plugin: capabilities, dependencies, configSchema, teardown, testing |
| [`docs/plugin-management.md`](docs/plugin-management.md) | User-facing plugin workflows: list/add/remove/enable/disable, config layout |
| [`docs/provider-author-guide.md`](docs/provider-author-guide.md) | Adding an LLM provider via `WireFormatConfig`, stream-state design, vendor quirks |
| [`docs/tool-author-guide.md`](docs/tool-author-guide.md) | Writing a tool: streaming `executeStream`, permission semantics, `cleanup` vs `registerAbortHook` |
| [`docs/yolo-mode.md`](docs/yolo-mode.md) | YOLO mode: permission pipeline, runtime toggle, trust file, subagent policy |
| [`docs/skills.md`](docs/skills.md) | Writing skills: frontmatter format, discovery layers, description quality, token budget |
| [`docs/oauth-signin.md`](docs/oauth-signin.md) | Sign in with a ChatGPT/Codex, Claude, or GitHub Copilot subscription (OAuth); flows, models, token storage, ToS caveat |
| [`docs/configuration.md`](docs/configuration.md) | Full config reference: every field with type, default, and example |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Common issues, diagnosis steps, `wstack diag`, exit codes, reset commands |

## Benchmarks

`pnpm bench` runs all `*.bench.ts` files via a separate vitest config and writes results to `bench-results.json` (gitignored). Current suite covers compactor hot paths, token estimation, JSON-schema validation, and the system prompt builder. See [`vitest.bench.config.ts`](vitest.bench.config.ts).

## Examples

See [`examples/`](examples/) for 6 categories of working examples:

| # | Example | What it demonstrates |
|---|---------|----------------------|
| 01 | [Basic usage](examples/01-basic/) | Single-shot, REPL, session resume, YOLO |
| 02 | [Tool usage](examples/02-tools/) | File editing, code search, git, tests |
| 03 | [Multi-provider](examples/03-providers/) | Switching providers, custom endpoints |
| 04 | [MCP integration](examples/04-mcp/) | Connecting MCP servers, using MCP tools |
| 05 | [Multi-agent](examples/05-multi-agent/) | Director fleet, delegation, subagents |
| 06 | [Real-world workflows](examples/06-real-world/) | Refactoring, testing, debugging, audits |

## License

MIT © 2026 ECOSTACK TECHNOLOGY OÜ — see [LICENSE](LICENSE).
