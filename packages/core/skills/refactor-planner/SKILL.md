---
name: refactor-planner
description: |
  Use this skill when planning a multi-file refactor, code modernization, or
  technical debt resolution in WrongStack. Trigger on the explicit vocabulary —
  "refactor", "technical debt", "modernize", "clean up", "restructure",
  "decompose" — and on the task shape, which is how it usually arrives: "this
  file is 2000 lines", "split this up", "extract X into its own module",
  "there's a circular dependency", "migrate from X to Y", "this is getting
  unmaintainable", "everything imports everything". This skill produces a
  phased PLAN with a dependency graph, risk scores, and a rollback strategy —
  it does not perform the refactor. Use it before touching code, and when a
  refactor already in flight has lost its ordering.
version: 2.0.0
---

# Refactor Planner — WrongStack

## Overview

Analyzes code structure and produces a phased refactoring plan with risk
assessment, dependency ordering, and rollback strategy. Use for multi-file
refactors, breaking up large modules, changing public APIs, addressing technical
debt, or migrating to new patterns.

**This skill plans; it does not execute.** The deliverable is the phased plan.
Do not start editing modules while planning — a half-done refactor with no graph
behind it is the exact failure this skill exists to prevent. Hand the finished
plan to the executing agent, phase by phase.

## Rules

1. Always build a dependency graph before planning — assumptions cause wasted work.
2. Always include a rollback strategy — every refactor can fail.
3. Never skip Phase 1 (low-risk quick wins) — momentum matters.
4. Never over-phase — if a task takes <1h, merge it with related tasks.
5. Rate each module by: cyclomatic complexity, test coverage, fan-out, public API surface.
6. Never ignore team constraints — parallelization only works if reviewers exist.

## Workflow

```
1. Analyze:  Build dependency graph, identify coupling
2. Score:    Rate each module by size, complexity, test coverage
3. Plan:     Order tasks by risk, dependency, payoff
4. Document: Phased markdown plan with checkpoints
```

---

## Building the dependency graph

Rule 1 and the anti-pattern list both call this the most important part, so do it
from evidence, not from intuition.

**Derive it from imports.** Grep the actual `import` / `require` / `from`
statements across the target set. Directory layout, file naming, and the mental
model in someone's head all lie; the import statements don't.

**Arrow convention: `A → B` means A depends on B.** B is the leaf. This is the
one thing the graph must be unambiguous about, because it decides the entire
ordering.

**Refactor leaves first, right to left.** Changing a leaf ripples up to its
dependents, so a leaf changed late invalidates everything already done above it.
In this graph:

```text
config.ts → logger.ts → path-resolver.ts
     ↓           ↓
  secret-vault.ts    session-store.ts
     ↓                    ↓
     └────────→  agent.ts  ←←←
```

`path-resolver.ts` is safe to touch first; `config.ts` is the most expensive.

**Also record the reverse edges.** Fan-out (what a module imports) drives its own
risk; the dependents list (who imports it) drives blast radius. Both belong in
the score — a 40-line file imported by twelve modules is riskier to change than a
600-line file nobody imports.

### Cycles come first

A cycle means there is no valid ordering, so every plan built over one is
fictional. Find cycles during the analyze step and list them explicitly. Breaking
them is Phase 1 work even when it looks like Phase 2 work, because nothing
downstream can be sequenced until they're gone.

Typical breaks: extract the shared piece into a new leaf both sides import,
invert one direction with an interface or callback, or move the coupling into a
composition root that wires both.

---

## Risk criteria

| Factor | Low Risk | Medium Risk | High Risk |
|--------|----------|-------------|-----------|
| Cyclomatic complexity | <10 | 10-20 | >20 |
| Test coverage | >80% | 50-80% | <50% |
| Fan-out (imports) | <5 | 5-15 | >15 |
| Public API surface | unchanged | modified | removed |

Score every module in scope; the mix of factors, not any single one, sets the
phase. A high-complexity module with 90% coverage is safer to change than a
simple one with none — the tests are what tell you the refactor preserved
behavior.

### Risk assessment checklist

One record per module in scope:

```json
{
  "module": "src/auth/session.ts",
  "size": 450,
  "cyclomatic": 12,
  "testCoverage": 65,
  "fanOut": 8,
  "publicAPI": true,
  "dependencies": ["core", "providers"],
  "dependents": ["cli", "tui", "webui"]
}
```

### Coverage below 50% changes the first task

A refactor is only safe to the degree that something can tell you behavior didn't
change. When a module scores <50% coverage, its **first Phase 1 task is writing
characterization tests** — tests that pin down what the code does today, bugs
included, before anything moves. This isn't scope creep; without it every later
phase is unverifiable and the rollback strategy is the only safety net left.

---

## Phase structure

Good refactors have 3 phases:

```
Phase 1: Low Risk / High Payoff
  - No behavior change
  - Tests already pass
  - Quick wins

Phase 2: Medium Risk (test heavily)
  - Some behavior may change
  - Significant test coverage needed
  - May need rollback plan

Phase 3: High Risk (full regression)
  - Behavior changes expected
  - Integration tests required
  - Coordinate with team
```

Two notes on using this well:

- **Each phase ends green.** A phase boundary is a checkpoint: tests pass, the
  branch is mergeable, and the work could stop there permanently without leaving
  the codebase worse. If a phase can't end in that state, it's split wrong.
- **Phase 3 is redesign, not refactoring.** Refactoring preserves behavior by
  definition; once behavior changes, the safety argument changes with it. Call
  that out in the plan so reviewers and QA know which parts need behavioral
  review rather than a diff read.

### Estimates

Estimate from fan-out and coverage, not from line count — a small change in a
widely-imported module costs more than a large one in a leaf. Keep the <1h merge
rule (rule 4). Mark anything you're guessing at with a `?` rather than inventing
false precision; an honest range beats a confident wrong number when someone
schedules against it.

---

## Patterns

### Do

```text
// ✅ Good — graph derived from imports, direction stated, cycles named
// A → B means A imports B. Refactor right to left.
// CYCLE: config.ts ↔ logger.ts — break before sequencing anything else.
```

```text
// ✅ Good — phase boundary is a real checkpoint
// End of Phase 1: pnpm test green, no circular deps in src/core, mergeable.
```

### Don't

```json
// ❌ Bad — no dependency graph
// "Refactor the auth layer" — with no graph, order is guessed

// ❌ Bad — no rollback strategy
// "We'll figure it out if something breaks" — plan for failure

// ❌ Bad — unverifiable exit criterion
// "Code is cleaner and easier to maintain" — nothing to check
```

---

## Rollback strategy

Every phase needs one, and it has to match the phase's risk:

- **Phase 1** — reversible commits. One commit per task, nothing squashed until
  the phase is green: `git checkout` if tests fail.
- **Phase 2** — feature flag around the changed path so the old one still exists
  and can be re-enabled without a deploy.
- **Phase 3** — blue-green deployment, or whatever your release process offers
  for reverting behavior in production.

The test of a rollback plan is whether someone who wasn't in the planning session
could execute it under pressure. "Revert the commits" is a plan only if the
commits are actually separable.

## Exit criteria

Make each one mechanically checkable — a command that exits zero, or a number
that can be measured. "Code is cleaner" is not an exit criterion, and a phase
without a checkable exit never formally ends.

✅ `pnpm test` passes; no circular deps in `src/core`; `Context` interface < 20 methods
❌ Code is more maintainable; the module is better factored; complexity reduced

---

## Phased plan output

`````text
## Refactor Plan — <target>

### Phase 1: Low Risk / High Payoff
| # | Task | Module | Risk | Est. Time |
|---|------|--------|------|-----------|
| 1 | Extract `ToolExecutor` interface | core/tool-executor.ts | low | 2h |
| 2 | Decouple `SessionStore` from Agent | core/session-store.ts | low | 4h |

### Phase 2: Medium Risk (test heavily)
| # | Task | Module | Risk | Est. Time |
|---|------|--------|------|-----------|
| 3 | Break circular dep: Config ↔ Logger | core/config.ts | medium | 6h |

### Dependency Graph
```
config.ts → logger.ts → path-resolver.ts
     ↓           ↓
  secret-vault.ts    session-store.ts
     ↓                    ↓
     └────────→  agent.ts  ←←←
```

### Rollback Strategy
- Phase 1: `git checkout` if tests fail
- Phase 2: Feature flag, can disable
- Phase 3: Blue-green deployment

### Exit Criteria
- [ ] All Phase 1 tasks pass `pnpm test`
- [ ] No circular deps in `src/core`
- [ ] `Context` interface < 20 methods

<nextsteps>
1. Extract ToolExecutor interface in core/tool-executor.ts
2. Decouple SessionStore from Agent in core/session-store.ts
3. Break circular dep between Config and Logger in core/config.ts
</nextsteps>
`````

State the arrow convention alongside the graph, and if any cycles exist, list
them directly under it — a reader who assumes the arrows point the other way will
execute the plan backwards.

---

## Anti-patterns

- **Don't plan without analyzing** — assumptions cause wasted work
- **Don't skip rollback strategy** — every refactor can fail
- **Don't over-phase** — if a task takes <1h, merge it
- **Don't ignore team constraints** — parallelization only works if reviewers exist
- **Don't skip the dependency graph** — the most important part
- **Don't start refactoring while planning** — the plan is the deliverable
- **Don't plan around a cycle** — break it first, or the ordering is fiction
- **Don't refactor untested code blind** — characterize it first
- **Don't write exit criteria nobody can check** — they never close

---

## Large targets

Above roughly 15 modules, scoring and graphing serially burns the session before
the plan exists. Hand the analysis to the `multi-agent` fan-out pattern: one
worker per chunk of 5–10 modules, each returning the same risk-assessment JSON
shape, leader merges them into one graph. Read that skill for sizing and
briefing rules first. The *planning* stays with the leader — only the measurement
parallelizes.

---

## Skills in scope

- `bug-hunter` — for finding bugs exposed by the refactor
- `git-flow` — for committing each phase properly
- `multi-agent` — for parallel analysis of multiple modules
- `output-standards` — for standardized `<nextsteps>` formatting

---

## Before delivering the plan

- Graph derived from actual imports, with the arrow convention stated
- Cycles found, listed, and scheduled first
- Every module in scope scored on all four risk factors
- Modules under 50% coverage get characterization tests as their first task
- Tasks ordered leaves-first; nothing depends on work scheduled later
- Nothing under 1h stands alone (rule 4)
- Each phase ends green, mergeable, and abandonable
- Rollback strategy per phase, executable by someone who wasn't here
- Every exit criterion is a command or a number
- No code was modified while producing this plan
