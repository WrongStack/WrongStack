---
name: multi-agent
description: "Multi-agent work: delegate subtasks, run parallel agents or a fleet, brief workers, partition file ownership and merge results. Use when delegation, a fleet, parallel agent work or result synthesis is requested or appropriate under host instructions; keep sequential or small work in one agent."
version: 2.1.2
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [verification.run, web.research, filesystem.write, fleet.delegate]
trigger: "delegation, a fleet, parallel agent work or result synthesis is requested or appropriate under host instructions; keep sequential or small work in one agent."
metadata:
  routing-group: workflow
---

# Multi-Agent Coordination

## Selection card
- Task: Plan coordinated work when delegation is authorized.
- Start: Split the work into independent subtasks with explicit file ownership and acceptance criteria before spawning any agent.
- Finish: Every delegated result was checked against its criteria and integrated, conflicts resolved, and no agents are left running.

## Overview

Parallel agents improve independent attention and elapsed time, at the cost of
handoff and synthesis. Use the host's actual limits and context-sharing rules.
Separate contexts may still share files, build outputs, ports and databases.

## Rules

1. Follow the session's delegation authorization and available tools. A large
   task or this skill's availability alone does not authorize spawning agents.
2. Delegate independent work with exact boundaries and a definition of done.
   Keep decisions requiring the complete context with the coordinator.
3. Assign file/resource ownership before writes. Prefer parallel reading and
   separate edit scopes; serialize shared build, coverage, release and database
   writers unless their isolation is demonstrated.
4. Treat task brief and supplied artifacts as the worker's reliable context;
   inspect what the host actually inherits instead of assuming total amnesia
   or unlimited shared memory.
5. Validate every worker's completion status and evidence. Partial, cancelled
   and budget-exhausted outputs are coverage gaps, not successful checks.
6. Synthesize one outcome with deduplicated findings and material cross-scope
   effects; do not concatenate reports or fabricate unanimity.

## Workflow

1. Decide whether the work is independent enough to repay briefing and merge
   costs. Use one agent when a subtask depends on exploratory results.
2. Brief each worker: task, exact paths, raw inputs, constraints, write ownership,
   checks, return format, budget and stopping conditions.
3. Dispatch within host concurrency/resource limits. Keep useful coordinator
   work running while workers execute.
4. Handle dependency handoffs explicitly with versioned artifacts or paths.
   A worker should reread a shared file before editing when another writer changed it.
5. Check actual statuses, commands and changed files. Read relevant code for
   consequential findings and inspect integration conflicts.
6. Retry a failed worker only when a changed scope/input addresses the cause.
   Bound retries; respect cancellation and report remaining gaps.
7. Run the integration checks against the combined final state with one owner.

## Brief template

~~~
Task: <one concrete objective>
Scope and ownership: <paths; read-only or permitted writes>
Inputs and constraints: <artifacts; relevant host rules>
Done when: <observable result>
Verify with: <commands and expected behavior>
Return: <outcome, files/lines, commands/results, limitations>
Stop/escalate when: <dependency or scope decision>
~~~

## Review workflow

For the host's collab_debug path, load
[the complete instructions](references/collab-debug.md) before dispatch.
That workflow's actual tool contract governs roles and result handling.

## Before returning

- [ ] Delegation authorization and host concurrency limits were verified and respected.
- [ ] File and shared-resource write ownership was partitioned or serialized before dispatch.
- [ ] Every worker completion status (including partial, cancelled, or timed-out runs) and evidence was reconciled.
- [ ] Combined final state passed integration checks under a single owner, with any coverage gaps or conflicting observations reported.

## Skills in scope

- `code-review` — independent review of worker-produced diffs and cross-module contract changes
- `evidence-audit` — scoped proof-driven verification rounds across isolated subsystems
- `refactor-planner` — dependency graph ordering and file-ownership partitioning before parallel execution
- `audit-log` — inspection of worker session trajectories, tool calls, and failure traces
- `output-standards` — deduplicated synthesis of multi-worker results into a unified report
