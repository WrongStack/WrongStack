# /fleet — Subagent Fleet Controller

## What it does

`/fleet` is the runtime control surface for an active fleet. It connects to the `Director` via `opts.onFleet`, `opts.onFleetRetry`, and `opts.onFleetLog`. Director Mode is permanently on — the Director is always available.

## Subcommands

| Usage | Effect |
|---|---|
| `/fleet` | Show fleet status (alias for `/fleet status`) |
| `/fleet status` | Pending + completed task table **and** read-only budget block (concurrency + lifetime spawns) |
| `/fleet list` | List the agent roster grouped by phase (role → capability) |
| `/fleet dispatch <task>` | Route a task to the best agent (heuristic + LLM) and spawn it |
| `/fleet usage` | Per-subagent iterations, tool calls, duration, cost rollup |
| `/fleet kill` | Terminate all running subagents |
| `/fleet terminate <id>` | Terminate a specific running subagent |
| `/fleet spawn <role> [n]` | Spawn N subagents of a given role (default 1) |
| `/fleet journal` | Show recent journal entries from /goal journal |
| `/fleet manifest` | Print the director `fleet.json` manifest |
| `/fleet concurrency` | Show the current concurrent-subagent ceiling |
| `/fleet concurrency N` | Set the concurrent ceiling to N (≥ 1) |
| `/fleet retry` | List interrupted tasks from last run |
| `/fleet retry <taskId>` | Re-spawn matching subagent for one task |
| `/fleet retry all` | Re-assign every interrupted task |
| `/fleet log` | List subagent transcript files on disk |
| `/fleet log <id>` | Compact summary of subagent's JSONL transcript |
| `/fleet log <id> raw` | Dump full JSONL for subagent |
| `/fleet stream on\|off` | Show/hide subagent activity in leader's history (TUI only) |

## Fleet data layout

```
<session-dir>/
  fleet.json              ← director manifest (run metadata, children, usage)
  director-state.json    ← live task graph for crash recovery
  subagents/
    <runId>/
      <subagentId>.jsonl ← per-subagent transcript
  shared/                ← optional shared scratchpad
```

## Agent roster

The built-in roster contains 50 catalog agents across 9 phases (Discovery →
Meta), plus the operational `shadow-agent` role. Five optional ACP runtimes
extend the addressable set from 51 to 56. The phase catalog is defined in
`packages/core/src/coordination/agents/`.
Each agent has a scoped tool allowlist and budget tier. Spawn any of them by
role: `/fleet spawn debugger`, `/fleet spawn e2e 2`, or let the dispatcher pick
with `/fleet dispatch "fix the login crash"`. `spawn_subagent role:<role>` works
too. Run `/fleet list` to see every role and its one-line capability.

## Smart dispatch

`/fleet dispatch <task>` scores the task against each agent's capability
keywords (deterministic, instant). When the heuristic is ambiguous it falls
back to an LLM classifier (`onDispatchClassify`, wired to the session provider).
The chosen agent is spawned automatically when a fleet is active.

## Live status line

On the plain (non-TUI) terminal, a bottom-pinned status line shows running
subagents live (`⟳ fleet ▶2 ✓3 │ Debugger ▶ 1m02s L25 14t bash`) via a reserved
scroll region. The TUI's 4th status-bar line shows the same per-agent detail,
including each agent's current tool.

## Graphical monitor (TUI)

Press **Ctrl+F** in the TUI to toggle a full graphical fleet dashboard
(`packages/tui/src/components/fleet-monitor.tsx`):

```
╭─ FLEET MONITOR │ ▶2 ✓5 · Ctrl+F to close ─╮
│ concurrency [██████░░░░] 3/5   $0.420     │
│                                           │
│ ▶ Debugger     1m02s  ███████░░░ L25 14t ⚡×3 │
│   ▁▂▃▅▇█▇▅ bash                           │
│ ▶ E2E         8s      █░░░░░░░░░ L3  2t    │
│   ▁▂▁▁ read                               │
│ ✓ Security    success ██████████ L40 31t  │
│                                           │
│ timeline                                  │
│  8s ago   ● E2E spawned                   │
│  40s ago  ✓ Security success (31t)        │
╰───────────────────────────────────────────╯
```

Shows a concurrency + cost gauge, a relative-load progress bar and activity
sparkline per agent, and a recent-event timeline. Esc also closes it.

## Never-die timeouts

Subagent budgets auto-extend on a soft-limit. Timeout specifically is
heartbeat-aware: while an agent keeps executing tools it never dies on
wall-clock time (24 h hard ceiling); only an agent making no progress between
grants is denied. Non-director hosts can attach the same policy via
`attachAutoExtend(eventBus)`.

### Extension badge (`⚡×N`)

Every granted extension is broadcast as `subagent.budget_extended` and counted
per subagent. The cumulative count surfaces as a `⚡×N` badge so you can see how
often never-die kept an agent alive:

- TUI status-bar 4th line and the Ctrl+F monitor — `⚡×N` next to each agent
- plain-REPL pinned fleet line — `⚡N` suffix
- `/fleet status` — `⚡×N` column (from `Director.extensionsFor(id)` /
  the enriched `CoordinatorStatus`)
- chat history — `AGENT#k ⚡ extended <kind> → <newLimit> (×N)`

## Budget block (issue #323)

`/fleet status` always prints a read-only **Budget** section so you never need
a probe spawn to learn the live ceilings:

```text
Budget
  maxConcurrent: 8  ·  activeAgents: 3
  maxSpawns: 256  ·  usedSpawns: 103  ·  remainingSpawns: 153  (source: maxConcurrent=profile, maxSpawns=env)
  ⚠ checkpoint maxSpawns was 96; live ceiling is 256
```

| Field | Meaning |
|---|---|
| `maxConcurrent` / `activeAgents` | Parallel subagent ceiling vs currently running/idle agents |
| `maxSpawns` | **Lifetime** spawn cap for this director run (not concurrency) |
| `usedSpawns` | Cumulative spawns already consumed (preserved across resume) |
| `remainingSpawns` | `maxSpawns − usedSpawns` |
| `source` | Winning config source: `cli-flag` \| `env` \| `profile` \| `default` |

### How ceilings are resolved

| Setting | Priority (highest first) |
|---|---|
| Concurrent agents | `--max-concurrent` → `WRONGSTACK_MAX_CONCURRENT` → `maxConcurrent` in profile → default `4` |
| Lifetime spawns | `--max-spawns` → `WRONGSTACK_MAX_SPAWNS` → `fleet.budget.maxSpawns` → default `64` |

On **resume**, `usedSpawns` is restored from `director-state.json` while the
**live** `maxSpawns` ceiling comes from the current profile/flag/env (not the
historical checkpoint value). A mismatch warning is shown when they differ.

The same snapshot is published to the WebUI Agents bar and HQ `fleet.snapshot`
telemetry. Static configured ceilings (not live used counts) also appear in
`system_config_view({ section: "fleet" })`.

## Code reference

- `packages/cli/src/slash-commands/fleet.ts` — `/fleet` incl. `list` / `dispatch`
- `packages/cli/src/fleet-statusline.ts` — plain-REPL live status line
- `packages/tui/src/components/fleet-monitor.tsx` — graphical TUI dashboard (Ctrl+F)
- `packages/core/src/coordination/agents/` — 50-agent catalog (phases 1-9)
- `packages/core/src/coordination/dispatcher.ts` — heuristic + LLM routing
- `packages/core/src/coordination/auto-extend.ts` — heartbeat auto-extend policy
- `packages/core/src/coordination/director.ts` — director-side auto-extend
- `packages/core/src/coordination/fleet.ts` — roster + budgets
- `packages/core/src/coordination/delegate-tool.ts` — `fleet-retry` tool
