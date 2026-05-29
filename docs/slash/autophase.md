# /autophase — Autonomous Phase-Based Workflow

## What it does

Turns a free-text **goal** into a real, LLM-driven build. AutoPhase:

1. **Plans** — a one-shot subagent decomposes the goal into a dependency-ordered
   list of **phases**, where each phase holds **many concrete todos**
   (`AutoPhasePlanner`).
2. **Builds the graph** — the plan is materialized into a `PhaseGraph` with a
   populated `TaskGraph` per phase, persisted as per-project JSON.
3. **Runs autonomously** — the `PhaseOrchestrator` drives the graph in the
   background. Each todo is executed by a **fresh subagent with full tool
   access** (read/edit/write/bash/…). Up to 2 todos run concurrently within a
   phase; phases run in dependency order.

This is "SDD logic but different": phased, persisted task-lists like SDD, but
driven by the autonomous orchestrator + concurrent subagents rather than
single-thread turn injection. Live progress is shown in the TUI PhaseMonitor.

## Usage

```
/autophase                      → Show current status + progress
/autophase start <goal>         → Plan + start an autonomous phase build
/autophase start Build a CSV import wizard with validation
/autophase pause                → Pause (in-flight todos finish; no new ones start)
/autophase resume               → Resume a paused run
/autophase stop                 → Stop and abort in-flight todos (progress saved)
/autophase save                 → Persist the current graph to disk
/autophase load [title]         → Load a persisted graph (display only)
/autophase list                 → List saved projects
```

## State storage

Phase-graphs are persisted **per project** as JSON under:

```
~/.wrongstack/projects/<projectHash>/autophase/<graphId>.json
```

(`wpaths.projectAutophase`). The graph is saved at plan time and re-saved as
phases complete / fail / the graph finishes, so a run survives restarts for
inspection via `/autophase load` and `/autophase list`.

## Architecture

- `packages/core/src/autophase/auto-phase-planner.ts` — `AutoPhasePlanner`: goal → `PhaseTemplate[]` (phases each carrying `taskTemplates`), with robust JSON extraction.
- `packages/core/src/autophase/phase-graph-builder.ts` — `PhaseGraphBuilder`: builds the `PhaseGraph` (one `TaskGraph` per phase) from templates.
- `packages/core/src/autophase/phase-orchestrator.ts` — `PhaseOrchestrator`: runs phases dependency-aware; `executeTask` per todo; retries; emits events.
- `packages/core/src/autophase/phase-store.ts` — `PhaseStore`: per-project JSON persistence.
- `packages/cli/src/autophase-host.ts` — `createAutoPhaseHost`: CLI host wiring — plans via a subagent, executes each todo via a subagent, persists, drives the orchestrator in the background.
- `packages/cli/src/slash-commands/autophase.ts` — `/autophase` slash command.
- `packages/tui/src/components/phase-panel.tsx` / `phase-monitor.tsx` — live views.
- `packages/webui/src/server/autophase-ws-handler.ts` — WebSocket progress broadcast.

## TUI integration

The host runs the orchestrator on the shared `EventBus`. `execution.ts` forwards
those events to the TUI via `subscribeAutoPhase`; the `app.tsx` effect dispatches
reducer actions:

| Event | Action |
|---|---|
| `phase.started` | `autoPhasePhaseUpdate` with `status: 'running'` |
| `phase.completed` | `autoPhasePhaseUpdate` with `status: 'completed'` |
| `phase.failed` | `autoPhasePhaseUpdate` with `status: 'failed'` |
| `phase.statusChange` | `autoPhasePhaseUpdate` with the new status |
| `phase.taskCompleted` | Update todo counts for the phase |
| `autonomous.tick` | Set `runningPhaseIds` + update `elapsedMs` |
| `graph.completed` / `graph.failed` | Re-persist the graph |

- `PhasePanel` — compact inline sidebar, visible while AutoPhase is active.
- `PhaseMonitor` — full-screen overlay (toggled with `Ctrl+P`).

## Task execution prompt

Each todo is run by a subagent with a task-scoped prompt that includes the
overall goal, the current phase, and the todo's title/description/type/priority,
instructing it to make the change real (not just describe it) using its tools.
A todo that ends with a non-`done` status is retried up to `maxRetries` (2)
before the phase is marked failed.
