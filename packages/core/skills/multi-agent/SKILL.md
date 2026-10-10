---
name: multi-agent
description: "Coordinate authorized independent agent subtasks with explicit scopes, ownership and evidence. Use when delegation, a fleet, parallel agent work or result synthesis is requested or appropriate under host instructions; keep sequential or small work in one agent."
version: 2.1.1
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
- Start: Identify the requested artifact, repository owner and acceptance criteria.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

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

- Delegation permitted and concurrency limits respected.
- Shared writers isolated or serialized.
- Every worker status reconciled; evidence checked.
- Combined result validated; gaps and conflicting observations visible.

## Skills in scope

- code-review — independent change review.
- evidence-audit — scoped evidence-led rounds.
- refactor-planner — dependency sequencing.
- audit-log — worker/session evidence analysis.
- output-standards — final result synthesis.
