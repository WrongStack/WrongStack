---
name: refactor-planner
description: "Plan behavior-preserving refactors and migrations from actual dependencies, callers and tests. Use when decomposing modules, untangling coupling or sequencing a multi-file change; deliver a plan for planning requests and continue into authorized implementation when the user asked for the refactor itself."
version: 2.1.1
required-capabilities: [filesystem.read]
required-tools: []
trigger: "decomposing modules, untangling coupling or sequencing a multi-file change; deliver a plan for planning requests and continue into authorized implementation when the user asked for the refactor itself."
optional-capabilities: [verification.run, web.research, filesystem.write]
metadata:
  routing-group: workflow
---

# Refactor Planner

## Selection card
- Task: Plan behavior-preserving module decomposition.
- Start: Identify the requested artifact, repository owner and acceptance criteria.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Produce a reviewable sequence of changes with preserved contracts, measured
risks and executable checks. Separate behavior-preserving refactoring from
requested behavior changes so their validation is clear.

## Rules

1. Derive dependency and reverse-call edges from source or a current index.
   State arrow direction; include dynamic registration and public consumers.
2. Identify invariants before moving code: identity, error semantics, side
   effects, serialization, lifecycle ownership and module initialization.
3. Estimate risk from evidence: callers, statefulness, concurrency, public API
   and meaningful tests. Missing coverage data is unknown, not an invented score.
4. Characterize unprotected behavior before changing risky paths; raw coverage
   percentages do not prove the important cases are protected.
5. Make each checkpoint buildable and testable. A small refactor can be one
   step; do not force three phases, feature flags or a minimum task duration.
6. Preserve dirty work. Rollback means reversing the owned change or a
   separable commit when authorized, never overwriting a shared checkout.

## Workflow

1. Map scope, closest existing conventions, dependents and tests.
2. Name the problem and observable improvement: reduce coupling, isolate state,
   remove a cycle, clarify an API. Line count alone is not a correctness goal.
3. Analyze cycles as strongly connected components. Break the relevant coupling
   if it blocks the intended change; an unrelated cycle need not halt the work.
4. Sequence the smallest coherent moves. Keep compatibility shims only when
   consumers need them, and give each a removal condition.
5. For each step, record paths, dependencies, preserved contracts, check command,
   exit condition and a rollback that someone else can perform.
6. Return the plan for a planning-only request. When execution is already
   requested, use this plan to implement and verify within the same task.

## Plan shape

| Step | Paths / change | Depends on | Risk evidence | Validation | Rollback |
|---|---|---|---|---|---|
| <step> | <concrete scope> | <real prerequisite> | <callers/state/tests> | <command + assertion> | <owned reversal> |

Mark estimates as ranges with assumptions. Do not invent metrics or require
parallel agents solely because the target contains many files.

## Before returning

- Dependency direction and consumer scope explicit.
- Refactoring and intentional behavior changes distinguished.
- Each checkpoint has a meaningful exit check and rollback.
- Planning-only scope honored; authorized execution not abandoned at the plan.

## Skills in scope

- codebase-navigation — trace dependencies and callers.
- testing — characterization and contract checks.
- code-quality — unused/coupled code assessment.
- git-flow — reviewable commits when requested.
