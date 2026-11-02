---
name: refactor-planner
description: "Refactor and migration planning: split large files or modules, break circular deps, untangle coupling, rename or move APIs safely. Plans behavior-preserving changes from actual dependencies, callers and tests. Use when decomposing modules, untangling coupling or sequencing a multi-file change; deliver a plan for planning requests and continue into authorized implementation when the user asked for the refactor itself. Not for deleting dead code (use code-quality)."
version: 2.2.0
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
- Start: Map the callers, dependents and covering tests of the code to be restructured.
- Finish: A step-by-step plan where every step keeps build and tests green, with risks, verification and rollback per step.

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
7. Detect and use the repository's actual language and verification toolchain; never introduce compiler/type/lint suppressions (`as any`, `@ts-ignore`, `# type: ignore`, `#[allow(...)]`, `//nolint`) to force a refactoring step green, and finish immediately once the planned or authorized steps are verified.

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

## Move patterns

- **Expand, migrate, contract** — add the new API beside the old, move callers in batches, delete the old one last; every intermediate state compiles and ships.
- **Branch by abstraction** — introduce an interface over the code being replaced, switch callers to the interface, swap the implementation behind it.
- **Strangler** — route one entry point at a time to the new module; the old path keeps serving the rest until it has no callers.
- **Break a cycle** — move the shared type or constant to a lower module, invert the dependency with an injected interface or event, or merge two modules that are really one.
- **Split a large file** — group by reason to change, not by kind; move private helpers with their only caller; keep a re-export only while external consumers still import the old path.
- **Rename across a codebase** — prefer language-server or AST-based renames (WrongStack's codebase-ast-replace tool, IDE refactors) over text replacement; then grep for string uses in configs, docs and reflection.
- **Characterize first** — when behavior is unclear, pin current outputs with characterization or snapshot tests before moving anything.

## Plan shape

| Step | Paths / change | Depends on | Risk evidence | Validation | Rollback |
|---|---|---|---|---|---|
| <step> | <concrete scope> | <real prerequisite> | <callers/state/tests> | <command + assertion> | <owned reversal> |

Mark estimates as ranges with assumptions. Do not invent metrics or require
parallel agents solely because the target contains many files.

## Before returning

- [ ] Dependency and caller graph derived from actual source imports and dynamic registrations
- [ ] Behavior-preserving refactoring steps separated from intentional functional or API changes
- [ ] Unprotected high-risk paths covered by characterization tests before structural moves
- [ ] Every step leaves the repository buildable and testable with an explicit validation command and rollback path
- [ ] Pre-existing uncommitted changes preserved untouched

## Skills in scope

- codebase-navigation — mapping static/dynamic import graphs, circular dependencies (SCCs), and public API consumers.
- testing — authoring characterization and contract regression tests before moving coupled logic.
- code-quality — identifying dead exports, unused dependencies, and barrel-file coupling during decomposition.
- git-flow — structuring atomic, reviewable commits when multi-step commit history is requested.
