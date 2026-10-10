<div align="center">

# WrongStack

### Ships with a Brain, a Memory, and a full toolbox. Yours to run anywhere.

**A free, open-source AI coding agent that gets better at _your_ codebase over time. It reads code, runs tools, and coordinates specialist agents — with durable memory, visible permission boundaries, and no subscription required.**

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![tests](https://img.shields.io/badge/tests-passing-2f9e44?style=flat-square)](#status)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![open source](https://img.shields.io/badge/open%20source-yes-ff3154?style=flat-square)](https://github.com/WrongStack/WrongStack)

---

macOS / Linux — one self-contained binary, no Node.js needed
```bash
curl -fsSL https://wrongstack.com/install.sh | sh
```

Windows
```powershell
irm https://wrongstack.com/install.ps1 | iex
```

</div>

---

WrongStack is **free, open source, and MIT licensed**. Give its leader a task:
It can work directly or delegate independent parts to specialist agents.
The **Brain** evaluates policy decisions; **SAGE** retains project knowledge
across sessions; **Kanban** tracks work and verification; the **mailbox** links
agents across clients; and **Chimera** reviews their diffs. Autonomous goal loops
and parallel workers use these same systems, rather than a separate agent engine.
Built-in tools, bundled skill playbooks, managed first-party plugins and a live
[models.dev](https://models.dev) provider catalog sit on a compact, swappable kernel.

The coding loop compares completed tool results when detecting repetition.
With the LSP plugin and hooks enabled, successful single and bulk file edits include bounded,
version-bound diagnostics or an explicit unverified notice. Research briefs
preserve API/version evidence and unresolved questions. See [agent feedback](docs/agent-feedback.md).

**Built from scratch, stands on its own.** WrongStack is not a plugin layer or an
orchestration kit bolted onto another coding tool — it's a complete agent written
top to bottom: its own compact kernel, its own provider transports with real SSE,
its own tool executor, permission policy, memory system, and multi-agent runtime.
Nothing here wraps a third-party CLI; everything works standalone.

### The scale of it

Not a thin wrapper — a real engine. The codebase is first-party,
TypeScript-strict source across a full monorepo, guarded by an extensive test
suite. Memory, tools, providers, permissions, and the multi-agent runtime are all
first-party and work together, on your machine, with no upstream agent to phone
home to.

### What's new in 1.0.37

- **Browser setup:** [`/browser`](docs/slash/browser.md) reports Chromium
  readiness, installs its runtime and manages exact project origin allowances.
- **Focused code reading:** `codebase-read-symbol` reads a named declaration
  directly from a file using AST parsing, with exact source-line bounds.
- **Skill guidance:** local intent rules suggest playbooks without an API call;
  the CLI Skill Companion watches active work and recommends missed skills.
  Its sealed, tool-less judge accepts only host-owned tasks, not fleet work.
- **Broader skills:** document, media and workflow playbooks join the bundled
  catalog. See [skills](docs/skills.md) and [suggestions](docs/skills-suggestion.md).
- **Bun-first development:** workspace scripts, tests, CI and SQLite adapters
  support Bun; contributor commands use the pinned Bun toolchain.

Highlights from **1.0.36**, the previous release:

- **Effort that follows the work:** the leader raises or lowers its own
  reasoning effort per phase with `leader_effort_set`, and gives each delegated
  worker an `effort` for its task; unset workers inherit the leader's effort.
  An effort you set always wins.
- **MCP ping and completion:** MCP clients send the spec liveness probe and
  `completion/complete`, validating the results.
- **Hardening from an evidence-led audit:** child processes no longer inherit
  credential variables, every config reader accepts UTF-8 BOMs, and unreadable
  config files fail loudly instead of being overwritten. Path bounds, subprocess
  tree cleanup, watcher storms and tool-output parsing are also fixed.
- **WebUI polish:** unified semantic colors and chips, modal keyboard
  ownership, recoverable panel states and complete translations.
- **Pinned Bun typechecking** for contributors: `bun run setup:bun` provisions the
  checker, and there is no `tsc` fallback.

1.0.35 hardened command guards, secret redaction and dependency audits; 1.0.34
added [project goals](docs/architecture/project-goals.md), [explicit
continuation](docs/slash/nextsteps.md), [YOLO+](docs/slash/yolo.md) and the
[dead-code workflow](docs/tools/dead-code.md).

See the [release history](CHANGELOG.md) for earlier releases.

> **New here?** Jump to [Install](#install) → [Quick start](#quick-start).
> **Already running it?** Keep current with [`wstack update`](#staying-current).

---

## Table of contents

- [Why WrongStack](#why-wrongstack)
- [How WrongStack compares](#how-wrongstack-compares)
- [Requirements](#requirements)
- [Install](#install)
- [Staying current](#staying-current)
- [Quick start](#quick-start)
- [Surfaces](#surfaces)
- [Core capabilities](#core-capabilities)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Packages](#packages)
- [Status](#status)
- [Docs](#docs)
- [License](#license)

---

## Why WrongStack

- **It remembers your project.** **SAGE** keeps long-term memory in
  SQLite/FTS5, anchored to real files, symbols, commands, and commits — and
  re-verified as they change. Decisions, conventions, and root causes survive the
  session that produced them.
- **A fleet, not a lone agent.** A full specialist roster and smart dispatcher
  fan out under a Director, each subagent isolated with its own budget and JSONL
  transcript.
- **The roster gets better here.** Each role turns useful outcomes into
  skill-specific practice, ranks what actually works in *this* repo, and applies
  it on the next matching task.
- **A deep toolbox, no plugins required.** Edits, lint/format/typecheck/test,
  execution, git, web, browser/E2E, and a SQLite codebase index with symbol and
  call-graph navigation.
- **Six surfaces, one brain.** A plain readline REPL, an Ink/React **TUI**
  (`--tui`), the full **WebUI** (`--webui`), lightweight **SimpleUI**,
  **Desktop** (`--desktop`), and the cross-machine **HQ** (`--hq`) — same engine,
  same session, same memory underneath.
- **HQ for the whole room.** Aggregate live sessions, agents, fleets, mailbox
  state, cost, tools, Brain decisions, and worktrees across machines — then
  steer, note, queue, or stop connected clients through their own guardrails.
- **Agents that coordinate instead of collide.** One project-wide mailbox
  links every client, session, branch, and linked worktree, with typed messages
  and live presence.
- **Set a goal, walk away.** `/goal` locks a contract and the eternal /
  parallel engines grind until it is *verifiably* done — with the **Brain**
  deciding risky calls by policy, denying them, or escalating to a human.
- **Work tracking that resists lying.** Durable Kanban boards and typed tasks
  with dependencies, lifecycle stages, and **atomic verification** gates that let
  a card reach Done only when its criteria actually pass.
- **Your diffs get reviewed.** **Chimera** critiques changed files with
  severity-ranked `file:line` findings and a one-line fix each, and fixer agents
  can follow up.
- **Providers without lock-in.** Anthropic, OpenAI, Google, and a broad range
  of OpenAI-compatible endpoints, refreshed from models.dev at boot.
- **Local & custom endpoints.** One-command presets for **Ollama / vLLM / LM
  Studio**, plus any custom `baseUrl` or **OmniRoute**-style gateway; run fully
  on localhost.
- **Sign in with an account.** ChatGPT plan API and legacy Codex, Claude,
  GitHub Copilot, xAI/Grok, Kimi Code, Meta, OpenRouter, and Antigravity auth
  run alongside API keys. Access and billing follow the selected provider's grant.
- **Per-role model routing.** Assign different providers/models per role or
  phase, with automatic **fallback chains** when a model is overloaded.
- **Locked down where it counts.** Encrypted secrets and a permission policy
  on every tool call, both always on. Project-root containment is opt-in
  (`/settings` → Filesystem access); once you enable it, neither YOLO nor a
  repo-committed config can turn it back off.
- **A kernel you can actually read.** `Container · Pipeline · EventBus ·
  RunController` — small enough to read in one sitting. Everything above it is
  swappable.

---

## How WrongStack compares

Most "AI coding" tools fall into one of two buckets: a **single-agent CLI** that
edits files in one terminal, or an **orchestration kit** that shells out to a
third-party agent CLI and coordinates it. WrongStack is neither — it's a complete
agent written from scratch, so the whole stack is first-party and consistent.

| | Wrapper / orchestration-only tools | **WrongStack** |
|---|---|---|
| **Core** | Coordinates an external agent CLI (Claude Code, etc.) | **Own compact kernel** — `Container · Pipeline · EventBus · RunController` |
| **Providers** | Inherits whatever the wrapped tool supports | **Own transports** — multiple wire families + real SSE, catalog from models.dev |
| **Tools** | Whatever the underlying CLI exposes | **First-party built-in tools** — edit, exec, search, browser/E2E, SQLite codebase index |
| **Local-only** | Needs the upstream tool + network | **Runs entirely on localhost** — one-command Ollama / vLLM / LM Studio presets; tools, memory, and fleet stay on your machine |
| **Memory** | Usually none, or bolted-on files | **SAGE** — SQLite/FTS5, code-anchored, auto-injected long-term memory |
| **Multi-agent** | Orchestrates external processes | **Native fleet + Director** — specialist roster, isolated budgets, one mailbox |
| **Surfaces** | One (a terminal) | **Six** — REPL, TUI, WebUI, SimpleUI, Desktop, HQ |
| **Review** | Manual | **Chimera** auto-review + fixer agents on your diffs |
| **Permissions** | Depends on the wrapped tool | **Per-tool policy on every call**, project-root containment YOLO can't override |

The point isn't "more features" — it's that a from-scratch, standalone design lets
memory, tools, providers, permissions, and the multi-agent runtime actually work
*together* instead of being glued across process boundaries.

---

## Requirements

- **Standalone binary:** nothing — the executable carries its own runtime
  (Windows x64/arm64, macOS x64/arm64, Linux x64/arm64 incl. musl)
- **Bun install and development:** Bun ≥ 1.4.3; see the [Bun workflow](docs/bun.md)
- **Node package consumers:** Node.js ≥ 22.19.0 remains supported

---

## Install

### Standalone binary (recommended)

One executable per platform with the runtime, every surface and all bundled
assets inside — no Node.js, npm or `node_modules`:

```bash
# macOS / Linux
curl -fsSL https://wrongstack.com/install.sh | sh
```

```powershell
# Windows
irm https://wrongstack.com/install.ps1 | iex
```

The installers download the build for your OS/CPU (musl is detected on
Linux), verify it against the release `SHA256SUMS`, and install `wstack` plus a
`wrongstack` alias into `~/.wrongstack/bin`. The musl builds need the C++
runtime (`apk add libstdc++ libgcc` on Alpine). Set `WSTACK_VERSION=1.2.3` to pin a
release or `WSTACK_INSTALL_DIR` to install elsewhere. You can also download a
`wstack-<os>-<arch>` file from the
[releases page](https://github.com/WrongStack/WrongStack/releases) and put it on
your `PATH` yourself.

On first run the binary unpacks its assets (prompts, skills, design kits,
grammars, the WebUI/HQ/SimpleUI frontends) once into
`~/.wrongstack/runtime/<version>/`.

Not available in the binary: the WebUI terminal panel (needs the native
`node-pty` addon), the Electron desktop shell, and the browser tool unless
Playwright is installed separately. The HQ systemd installer (`wstack hq
service install`) manages an npm install; run `wstack hq` under your own
service manager instead.

### npm (legacy)

The npm packages (`wrongstack`, `@wrongstack/cli`) are legacy and no longer the
way to install WrongStack — GitHub Releases is the only supported channel. If
you installed through npm, pnpm, yarn or bun before, just run the installer
above: it finds those globals and uninstalls them (asking first on a terminal)
so they cannot shadow the binary.

The TUI is lazy-loaded behind `--tui`, so plain-REPL users pay no React/Ink cost
at startup. The browser UI, HQ, and Desktop shell are available through their
launch flags (see [Surfaces](#surfaces)).

For standalone CLI users, Desktop is a separate Electron application distributed
through GitHub Releases. `wstack --desktop` opens an installed application;
portable/custom locations use `WRONGSTACK_DESKTOP_EXECUTABLE`.
See [Desktop distribution](docs/desktop-distribution.md) for installation and release details.

Then just run:

```bash
wrongstack        # or the short alias: wstack
```

From a source checkout, the same built CLI can run directly on Bun:

```bash
bun run build
bun run start:bun
```

`bun run smoke:bun` verifies Bun's SQLite-backed SAGE path, heap watchdog,
WebUI server module graph, and CLI entry point. Node continues to use
`node:sqlite`; Bun selects `bun:sqlite` automatically.

To run HQ as a boot-persistent, auto-restarting systemd service with password
authentication and an optional IP/CIDR admission list, see
[HQ service](docs/hq-service.md).

---

## Staying current

Update the CLI in place from inside the tool:

```bash
wstack update                 # download + verify the latest release
wstack update --check-only    # is a newer release available?
```

`wstack update` pulls from GitHub Releases and checks the download against the
release `SHA256SUMS` before swapping the executable in place. Re-running the
install one-liner does the same thing.

Full flag reference: [CLI reference → Updating](docs/cli-reference.md#updating).

---

## Quick start

```bash
# First run — interactive auth/setup, then a launch menu on a TTY
wstack

# Sign in with a ChatGPT/Codex or Claude subscription
wstack auth

# Skip the picker and pin a provider/model
wstack --provider anthropic --model claude-sonnet-4

# TUI with an explicit YOLO override
wstack --tui --yolo

# Director fleet orchestration
wstack --director

# Single-shot query (non-interactive)
wstack -p "explain packages/core/src/kernel"

# Resume a saved session
wstack --resume
```

First run walks you through authentication and model selection. No config? The
interactive provider/model picker launches automatically. Switch providers any
time at runtime with `/model`.

Full flag and subcommand reference: [`docs/cli-reference.md`](docs/cli-reference.md).

---

## Surfaces

| Surface | Launch | Best for |
|---------|--------|----------|
| **REPL** | `wstack` | Fast, dependency-light terminal use |
| **TUI** | `wstack --tui` | Rich full-screen terminal with panels |
| **WebUI** | `wstack --webui` | Browser chat + tool/diff/session panels |
| **SimpleUI** | `wstack --simpleui` | Fast, focused standalone browser chat (see below) |
| **Desktop** | `wstack --desktop` | Electron shell over a token-gated local WebUI |
| **HQ** | `wstack --hq` | Cross-machine command center for a whole team |

Plain `wstack` on a TTY opens a launch menu; add `--no-menu` to go straight to the
REPL. See [WebUI](docs/webui.md) for the browser surface details.

WebUI and SimpleUI keep their host terminal compact: repeated warnings share
one row, logs and finished workers disappear after 30 seconds, and live worker
rows fit the terminal. Use `WEBUI_VERBOSE=1` for full console output.

The WebUI's **Story** button opens [Session Story](docs/session-story.md): a visual
timeline of the selected tab and its subagents, with activity charts, team
branches, replay, and recorded file, memory, and mail evidence.
Its dashboard tabs expose measured tool averages/P95 and file read/edit/write
counts, with recorded source and diff line statistics where available.
The Models tab compares provider/model reliability, measured latency and spend,
and recorded work/quality signals across the leader and its subagents.
The secondary sidebar pins Story at the top and switches it to **Back to
session** when open. Chat sidebar sections collapse and reorder by dragging,
with keyboard/touch arrow controls and saved browser layout preferences.

**SimpleUI** is a full, independent chat surface (Vite + React), not a
stripped WebUI. It reuses the same WebSocket backend but ships its own bundle,
with a sticky composer, `@`-file picker, streaming markdown + syntax highlighting,
vision/image attachments, session switching, and a lazy-loaded Tools/Todo/Task/Plan
sidebar — deliberately minimal, fast, and focused.

---

## Core capabilities

WrongStack is standalone-sufficient — the highlights below work with **no plugins
required**. Deep reference lives in [`docs/reference.md`](docs/reference.md).

### Tools & code intelligence

The 72-tool built-in toolbox spans filesystem edits, code quality (`lint`/`format`/
`typecheck`/`test`), execution, web search/fetch, git, packages, browser/E2E
controls, and a project-owned Codebase Index. The index combines SQLite/FTS5
substring search, local semantic ranking, content-hash invalidation, symbol and
call-graph navigation, and bounded parser workers for large repositories. Full map:
[reference → tools](docs/reference.md#built-in-tools).

`dead-code-scan` adds independent TypeScript reachability analysis with finding
ids, confidence and planned diffs. `dead-code-fix` rechecks selected findings,
typechecks affected packages by default and rolls back failed verification.
Backups support undo with conflict reporting. Public API and dynamic entrypoints
can have consumers outside the visible graph; review them before cleanup.
See [dead-code workflows](docs/tools/dead-code.md).

**[WrongStack ToolFlow](docs/toolflow.md)** composes repeated or dependent tool
calls in sandboxed JavaScript and returns the findings needed for the next
decision. Intermediate results stay out of model context; each call keeps its
permission checks and session record. WebUI, TUI, and SimpleUI show the run's
purpose, call count, failure count, and measured output bytes.

In a reproducible 50-read fixture using the real Agent/ToolExecutor and a
scripted provider, batched direct calls send **551,040 bytes in 50 result blocks**;
ToolFlow sends **120 bytes in one result block** (over 99.9% less result text).
Both use **two provider requests**, including the final answer. Sequential direct
calls use 51; discovering ToolFlow first adds a request. These are fixture result
bytes and request counts, not live-model speed, token, or billing measurements.
Use `tools.data(name, input)` for validated structured results from tools with an
output schema, including built-in read, grep and glob. Existing text calls remain
available; file content reads expose `raw_text` with truncation metadata.

Use ToolFlow when you can filter or compute a small answer inside the script;
use direct calls for simple operations and small independent batches. Returning
raw data still relies on the executor's ordinary preview/artifact handling.
See the [comparison and reproduction guide](docs/toolflow.md#measured-contribution)
and the [generated measurement snapshot](website/src/data/toolflow-contribution.json).

Every tool is registered and callable at every setting. How many are *described*
to the model on each request depends on the token-saving tier: the default trims
that to a working set and keeps the rest one `tool_search` away, so a long
session does not pay for every schema on every turn. Set
`features.tokenSavingMode: "off"` to describe them all directly.

### Autonomy & goals

`wstack automation` runs persistent scheduled or signed GitHub jobs in copied
Docker workspaces. WebUI and SimpleUI manage jobs, versioned templates and
portable definitions, and show structured results with usage, known estimated
cost and read-only patches. `present_artifact` presents text, images, diffs and
owned live browsers. See [automation](docs/subcommands/automation.md),
[artifact presentation](docs/present-artifact.md),
[offline quality experiments](docs/subcommands/bench-experiments.md) and
[cloud routing profiles](docs/subcommands/provider-cloud.md).

`/goal` locks a verifiable contract and the eternal / parallel engines — two
run modes that keep looping through plan → act → check — run until it's done,
surfacing a live stage chip (`⟳ DECIDE` / `⚡ EXECUTE` / `◎ REFLECT`).
The **Brain** governs risky decisions with deterministic rules, decision traces,
quality gates, and circuit breaking.
Its optional Jev System One tier handles bounded lower-risk choices; high-risk
questions can reach a multi-model Council. The Council **Judge** still resolves
ties or below-threshold votes. Critical Council failure escalates without a
single-model fallback. CLI/TUI and standalone WebUI share this chain and live
settings; interactive decisions use the existing human-input form. See
[Brain controls and Judge behavior](docs/slash/brain.md).

For executable phase goals, `/goals` and WebUI **My Goals** provide a project
catalog with goal ids, owning sessions, task/phase progress and blockers.
Git-backed terminal goals run in separate checkouts and retain their goal
branches for review before integration. See [project goal tracking](docs/architecture/project-goals.md).

Task progress and final verification are distinct: a completed checklist does
not establish a verified outcome. Another terminal's goal is read-only in My Goals;
send mutations through its owning terminal.

[`/nextsteps required [limit]`](docs/slash/nextsteps.md) closes finished turns
with a concrete next action or completion marker. In `auto` autonomy, open todos
take priority; a configured limit pauses consecutive automatic turns for input.
Defaults are required next steps and unlimited continuation, with repetition
guards still active.

[`/yolo on`, `/yolo plus`, `/yolo off`](docs/slash/yolo.md) choose confirmation
behavior independently from continuation. YOLO+ removes confirmation prompts
for a conversation and its subagents, while user-authored refusal rules and
tool-declared denials remain enforced. WebUI tabs are isolated, and
`--restricted` locks YOLO+ off. [`/solo`](docs/slash/solo.md) controls whether a
TUI session admits workers or only read-only companions; choose it before work starts.

### Multi-agent fleet + Director

A specialist roster and smart dispatcher fan out under a Director (the leader
agent that splits your request into delegated tasks). Each subagent is isolated
with its own budget and a JSONL transcript — an append-only, replayable log of
everything it did — coordinated over a project-wide mailbox. See
[Director architecture](docs/director-architecture.md) and [agents](docs/agents.md).

### Self-improving roster agents

Every roster role has a base definition, but each **project can teach it**. Under
`.wrongstack/agents/<role>/`, the role keeps its identity, a structured learning
buffer, and skill-specific practice at `skills/<skill>.md`. A run can end with a
`## LEARNED [skill: testing]` directive (or let WrongStack route it from the
wording); the next matching spawn receives that project practice immediately below
the bundled skill it refines. `/agent-improve <role> capture`, `optimize`, and
`skills` make the loop visible, while automatic optimization distils safely in the
background. Useful skills gain affinity from usage and outcomes, can be pinned,
and rise into the role's bounded eager-load set — so your bug-hunter, reviewer,
and executor improve where it matters without turning every prompt into a dump of
old notes.

### TypeSafe / Jev decisions

Jev is off by default, even with a saved or environment API key. Enable it with
`/jev on` or **Settings → Jev → Enable Jev**; `/jev off` disables all consumers
and paid calls while preserving the key. HTTP 402 stops further automatic
requests for that account until restart or an account change.

Manage the decision provider, key and feature switches in **Settings → Jev** in
the WebUI, or **`/jev`** in the TUI. The WebUI includes a live activity view
with request timing, usage, answers and safe failure categories; `/jev logs`
exposes the same process history. See
[Jev settings and activity](docs/jev-settings-and-activity.md).

Explicitly enabled, configured accounts also expose the `jev` decision tool: agents can request
yes/no probabilities, choose among alternatives, or score supplied evidence
against a rubric. `jev_status` checks local availability without a network
request. Control this independently with `/jev feature tool on|off` or
**Settings → Jev → Agent decision tool**.

Optional Jev integration suggests a relevant skill before a turn and classifies
ambiguous fleet dispatches; those two consumers remain separately opt-in. The
bounded judgment features are available when an account is ready and can each
be switched off independently. Jev supports a native TypeSafe API key or
OpenRouter's Decisions endpoint through
`wstack typesafe login --route typesafe` or `--route openrouter`;
`wstack typesafe test` checks the selected account. Jev is a typed decision
service, not a chat model.
See [account setup and coverage](docs/typesafe-account.md),
[skill suggestion](docs/skills-suggestion.md), and
[fleet classification](docs/fleet-dispatch-classifier.md).

### Inter-agent mailbox

One project-wide coordination plane connects **every agent, across every client,
process, session, branch, and linked Git worktree** — CLI, TUI, WebUI, SimpleUI,
Desktop, and HQ alike. Agents send typed messages (`ask`, `assign`, `steer`,
`result`, `review`, `status`), hand off work, broadcast milestones, and see who is
online with live presence — so parallel agents cooperate instead of colliding.
HQ can even route mailbox traffic and steer connected clients through their own
guardrails. All production callers use a deterministic local IPC endpoint; one
elected project owner alone opens `_mailbox.sqlite`, serializes mutations, and
publishes health and presence. Clients never open the mailbox database directly.

### SAGE — persistent long-term memory

**SAGE** is WrongStack's project-local, structured long-term memory. It lives at
`.wrongstack/memories/` backed by **SQLite/FTS5** (legacy JSONL auto-migrates on
first open), and it is *indexed by default*. The agent uses `remember`,
`memory_search`, and `pin_add` to persist and recall knowledge across sessions —
and relevant memories are **auto-injected** into context every turn. The same
project-owned service is available to external MCP clients through
`wstack-sage-mcp`; it is read-only by default, while `--writable` enables the
confirm-class mutation tools.

Claude Code, Codex, Cursor and Antigravity connect with one command —
`wstack sage connect <client>` — and get read access plus the ability to
propose memories for review. With HQ enabled, project-level memories sync to
every machine carrying the same committed project identity (`wstack sage sync`
runs that bridge headless).

- **Typed knowledge** — facts, decisions, conventions, preferences, anti-patterns, bug root causes, and file/symbol/command notes, each with importance + confidence.
- **Rich anchors** — a memory can bind to almost anything concrete: a **file**, a **directory**, a **symbol** (function/class/method), a **command**, a **git commit or blob**, a **test**, or a **package**. Anchored memories are re-verified as those targets change (file existence, content hash, git blob, symbol presence) and auto-surface when you touch that location — so knowledge stays pinned to the code it describes instead of drifting.
- **Knowledge graph** — typed edges + BFS traversal relate memories, files, symbols, and commands.
- **Audience-scoped** — memories can target specific roles/modes so role-specific guidance never clutters general recall.
- **Curated, not chaotic** — a review queue and hygiene pipeline keep memory trustworthy; deletions are guarded.
- **Checked, not trusted blindly** — a read-only Memory Companion verifies injected memories against current source, agents record evidence-backed feedback after real use, and a memory can state when it applies.

See the current [SAGE system reference](docs/sage/SYSTEM-REPORT.md).

### Tasks & Kanban — active work tracking

Work is tracked with real, durable structure — not throwaway checklists:

- **`todo`** — session-level step tracking for the task in flight.
- **`plan`** — a persistent strategic roadmap that survives turns; promote items into todos or tasks.
- **`task`** — structured, cross-session work items with types, priorities, and dependencies.
- **`kanban`** — durable project boards with columns, task **chains**, dependencies, and assignment snapshots. One project IPC owner serializes the authoritative `.wrongstack/kanbans/_kanban.sqlite` state and broadcasts daemon events; clients do not open the database directly. The `@wrongstack/kanban` package provides the storage + lifecycle layer (claim, recover stale assignments, verify completion) with **lease fencing** (an old worker's lease cannot overwrite
  a newer assignment) and cost guardrails for safe multi-agent execution.

Managed cards follow an explicit `Backlog → Todo → Running → Review → Done`
lifecycle, and **HQ** exposes a shared, project-scoped board that reconciles live
across every clone carrying the project identity.

**Atomic verification** keeps tasks honest. Cards carry success criteria, goal
metrics, and checks; the board can **assess atomicity** and either *propose* or
*auto* decompose non-atomic work (`atomicityMode: off | assess | enforce`).
Completion isn't a rubber stamp — `verify_completion` gates a card into Done only
when its acceptance criteria and evidence actually pass, so a worker finishing
means the card enters **Review**, not Done.

### Spec-Driven Development (`/sdd`)

Turn a spec into acceptance criteria, decompose into dependency-linked tasks,
implement one at a time, and validate against the spec before closing — spec,
tasks, and verification evidence stay linked in project-scoped SDD stores so
progress is auditable at any point.

### Plugin ecosystem

A collection of managed first-party plugins extends the agent with focused,
single-purpose capabilities, each auditable and individually disableable. See
[plugin management](docs/plugin-management.md) and the
[plugin author guide](docs/plugin-author-guide.md).

### Providers & subscription sign-in

Providers span several API-key wire families, plus OAuth sign-in with ChatGPT
plan API, legacy Codex, Claude, Copilot, xAI/Grok, Kimi Code, Meta, OpenRouter,
and Antigravity. Browse with `wstack models`. See
[OAuth sign-in](docs/oauth-signin.md).

Account model choices come from the provider's live account catalog and an
account-specific cache. Empty or unavailable catalogs never create hardcoded
model choices; generic catalogs only enrich IDs already known to the account.
ChatGPT plan API, Kimi, xAI and Meta discovery renew expiring account tokens
before fetching models and report the cause when discovery fails.

**Bring your own endpoint.** Beyond the catalog, you can point WrongStack at *any*
OpenAI-compatible endpoint: **local models** via one-command presets for
**Ollama** (no key), **vLLM**, and **LM Studio**; **custom providers** with your
own `baseUrl` and env-var keys; and proxy/router gateways like **OmniRoute**. Run
entirely on localhost if you want — the same tools, fleet, and memory work
against a model on your own machine.

### Model routing & fallbacks

Mix providers and models freely, per role and per phase. A **model-routing
matrix** assigns a provider/model — or a named **fallback profile** — to any agent
role, phase, or the fleet-wide default (exact role → phase → `*` → leader). When a
model is overloaded (429/5xx), WrongStack rotates through an ordered **fallback
chain** automatically, and `favoriteModelsOnly` keeps that rotation on models you
trust. So a leader, a reviewer, and a bug-hunter can each run on a different model
in the same session, each with its own safety net.

### HQ — cross-machine command center

`wstack --hq` is the control plane for a whole room. It aggregates **live
sessions, agents, fleets, mailbox state, cost, tools, Brain decisions, and
worktrees across multiple machines and clients** in one dashboard — running many
providers and models simultaneously — and can steer runs, send BTW notes, queue
prompts, route mailbox traffic, or stop connected clients through their own
guardrails. Browser and client tokens are separate and capability-scoped; in
token mode every `/api/*` route and WS upgrade is gated.

### CodeMap & visual views

The WebUI turns the SQLite codebase index into **code intelligence you can see**.
**CodeMap** renders an interactive dependency/symbol graph (server-side cached,
with visible-element virtualization for large graphs) so you can navigate the
project's structure and hotspots at a glance. Alongside it, live **fleet
topology** and an **Office view** visualize your running agents spatially — who is
active, what each is doing, and how the fleet is wired — turning multi-agent runs
into something you can actually watch.

**A file's whole story, traceable.** CodeMap streams live per-file activity —
every read / write / edit / delete / search / index / execute — tagged with the
**session**, **agent**, **tool**, trace id, timestamp, and the actual line
changes (added / removed, before / after). So from the file explorer you can
replay what happened to any file over time: *which task, which session, which
agent, which tool touched it, and what it did* — the full, attributed history of a
change and everything it reached.

### Chimera — automatic code review

**Chimera** is a post-session code guardian. The built-in auto-review plugin
detects every git-tracked file you changed during a session and dispatches a
review subagent that reads the diffs and reports real, severity-ranked findings
(Critical → Low) with `file:line` references and a one-line fix each — surgical
bug-catching, not style nagging. Paired **fixer** agents can act on the findings,
and reviews can fan out in parallel across many changed files. Trigger it
on-demand with `/chimera`.

### WrongTrace guardrails — optional sibling daemon

WrongStack can coordinate with the external **WrongTrace** daemon when it is
running locally (default `http://localhost:3444`) — and silently does nothing
when it is not. Two independent integrations share that origin: the
**observability guardrails** and **provider rerouting**. Every mutating tool
call (`edit`, `write`, `replace`, `patch`, `codebase-ast-replace`) passes a
fail-open lock gate — a file locked by another owner denies the edit with the
owner and TTL in the reason, fragile files get a surgical-edit nudge, and an
offline daemon never blocks anything. The same daemon optionally rewrites
provider base URLs through `/proxy/` when `tools.wrongProxy.enabled` is set.
Full details: [`docs/wrongtrace.md`](docs/wrongtrace.md).

### Security & privacy

Encrypted secrets at rest, a permission policy on every tool call, project-root
containment that YOLO can't weaken, and a typed observability event catalog.
Threat model: [`SECURITY.md`](SECURITY.md).

### Token-saving mode

`--token-saving-mode` trims the tool surface and prompt to cut cost. The tier
resolves once at boot (`off | auto | minimal | light | medium | aggressive`);
set `features.tokenSavingMode: "off"` to describe every tool on every turn.

---

## Configuration

| Scope | Location | Purpose |
|-------|----------|---------|
| Environment | env vars | Overrides and secrets injection |
| User config | `~/.wrongstack/config.json` | Providers, defaults, feature toggles |
| Project conventions | `<project>/.wrongstack/AGENTS.md` | Shared, committed repo conventions |
| Project instructions | `<project>/AGENTS.md` (or `CLAUDE.md`) | Loaded into the system prompt |
| Directory instructions | `<dir>/AGENTS.md` (or `CLAUDE.md`) | Sent once, when the agent first touches a path under `<dir>` |
| Project identity | `<project>/.wrongstack/project.json` | Repository-stable `proj_<ULID>` |

`apiKey`-like fields are auto-encrypted on first contact; plaintext keys in older
configs migrate transparently on boot. Full details:
[`docs/configuration.md`](docs/configuration.md).

---

## Architecture

```
CLI       → REPL, renderer, slash commands, subcommands
TUI       → Ink frontend (lazy-loaded behind --tui)
WebUI     → Browser UI + WS bridge (standalone or --webui)
Desktop   → Electron shell hosting a token-gated local WebUI
Runtime   → Default host assembly + WrongStackPack extension composition
Kernel    → Container · Pipeline · EventBus · RunController (the 4 primitives)
Provider  → Multiple wire families, factories built from ModelsRegistry, real SSE
Models    → models.dev/api.json fetched + cached + classified
Services  → deterministic local IPC → one owner each → SQLite-backed project state
```

**Four contracts** hold the design together:

1. **Minimal kernel** — the four primitives stay small enough to read end to end.
2. **Zero non-overridable behavior** — services bound through `Container`, pipelines as middleware, all extension points in registries.
3. **Standalone sufficiency** — works with the built-in tools and no plugins.
4. **Layered, not monolithic** — every feature composes over the kernel through registries; nothing above it is load-bearing.

Full walk-through: [`docs/architecture.md`](docs/architecture.md).

---

## Packages

| Package | Purpose |
|---------|---------|
| `@wrongstack/core` | Kernel, agent, types, registries, plugin contract |
| `@wrongstack/runtime` | Default runtime implementations + host composition |
| `@wrongstack/providers` | Anthropic/OpenAI/OpenAI-compatible/Google adapters + SSE |
| `@wrongstack/tools` | Built-in tools (incl. browser/E2E + SQLite codebase index) |
| `@wrongstack/mcp` | MCP server registry + reconnection logic |
| `@wrongstack/acp` | Agent Client Protocol client + agent support |
| `@wrongstack/bench` | Benchmark harness (Aider polyglot + SWE-bench Verified) |
| `@wrongstack/kanban` | Task-board primitives: queues, recovery, cost guardrails |
| `@wrongstack/sage` · `@wrongstack/persistence` | Project-local memory/anchors and shared persistence primitives |
| `@wrongstack/codebase-index-mcp` · `@wrongstack/kanban-mcp` · `@wrongstack/mailbox-mcp` · `@wrongstack/sage-mcp` | Project-service MCP servers with explicit capability tiers |
| `@wrongstack/requirement-intake` · `@wrongstack/requirement-intake-mcp` | Source-annotated requirement records and their project-scoped MCP surface |
| `@wrongstack/sdd` | Spec-Driven Development stores, trackers, workflow helpers |
| `@wrongstack/governance` · `@wrongstack/security-scanner` · `@wrongstack/techstack` | Workflow policy, security scanning, and dependency intelligence |
| `@wrongstack/cli` | REPL, subcommands, slash commands, terminal renderer |
| `@wrongstack/tui` | Ink-based TUI (lazy-loaded behind `--tui`) |
| `@wrongstack/webui` · `@wrongstack/webui-server` · `@wrongstack/webui-hq` · `@wrongstack/simpleui` | Browser UIs, shared backend, and HQ dashboard |
| `@wrongstack/desktop` | Electron desktop shell |
| `@wrongstack/plug-lsp` · `@wrongstack/telegram` | LSP and Telegram plugins |
| `@wrongstack/wrongtrace` | Client adapter for the optional WrongTrace daemon (file locks, health, friction, atlas) — HTTP/IPC/MCP, no-op when absent |
| `@wrongstack/plugins` | Official plugin collection via subpath exports |
| `wrongstack` | Published CLI app entry (`wrongstack` / `wstack`) |

---

## Status

- **v1.0.37** — current repository version; semver from 1.0.0 onward
- Full release verification: `bun run release:check` before publishing
- Coverage thresholds (root Vitest): ≥76% lines / ≥75% functions / ≥66% branches / ≥75% statements
- Packages and apps use TypeScript strict + `noUncheckedIndexedAccess`
- CI, dependency audit and Pages deployment are manually dispatched; pushes do not run them
- Node 22.19+ only, ESM-only, no CommonJS bundles
- Threat model: [`SECURITY.md`](SECURITY.md)

---

## Docs

| Doc | What it covers |
|-----|----------------|
| [Getting started](docs/getting-started.md) | First session and everyday workflow |
| [Documentation index](docs/README.md) | Maintained guides and dated archives |
| [CLI reference](docs/cli-reference.md) | Launch flags, subcommands, and `wstack update` |
| [Reference](docs/reference.md) | Tools, providers, slash commands, modes, skills at a glance |
| [Project Kit](docs/project-kit.md) | Reusable project tools with schemas, verification, revisions, and execution history |
| [Slash commands](docs/slash/) | Every built-in slash command |
| [Subcommands](docs/subcommands/) | Every `wstack <subcommand>` |
| [Configuration](docs/configuration.md) | Config files, env vars, project conventions |
| [Architecture](docs/architecture.md) | Kernel primitives, pipelines, agent lifecycle |
| [Project goals](docs/architecture/project-goals.md) | Goal ownership, checkouts, progress and verification |
| [Tool workflows](docs/tools/README.md) | Language tools, dead-code cleanup, codebase context and web evidence |
| [Typed client API](docs/client-api.md) | Integrating with the WebUI protocol and client |
| [SAGE memory](docs/sage/SYSTEM-REPORT.md) | Long-term memory: storage, anchors, knowledge graph, retrieval |
| [SAGE feedback lifecycle](docs/sage-feedback-lifecycle.md) | Memory Companion, validity conditions, evidence-based feedback |
| [OAuth sign-in](docs/oauth-signin.md) | Subscription authentication |
| [HQ service](docs/hq-service.md) | Always-on HQ under systemd |
| [Plugin author guide](docs/plugin-author-guide.md) | Building a plugin |
| [Director architecture](docs/director-architecture.md) | Fleet orchestration internals |
| [WrongTrace integration](docs/wrongtrace.md) | Optional daemon: guardrail hooks, file locks, proxy routing |
| [Troubleshooting](docs/troubleshooting.md) | Common issues |

---

## License

[MIT](LICENSE) © WrongStack contributors.

Contributor setup and migration dry-runs: [Bun workflow](docs/bun.md).
