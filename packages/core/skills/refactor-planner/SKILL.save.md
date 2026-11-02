# Refactor Planner (Compact)

<!-- source-version: 2.2.0 -->

## Selection card
- Task: Plan behavior-preserving module decomposition. / TR: Davranışı koruyan modül ayrıştırması planla.
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

## Detailed workflow

Load the full refactor-planner skill before relying on its specialized modes,
references or output contracts. Its current SKILL.md is the source of truth;
this compact body does not expand task scope or authorization.

## Before returning

- [ ] Dependency direction and consumer scope explicit
- [ ] Refactoring and intentional behavior changes distinguished
- [ ] Each checkpoint has a meaningful exit check and rollback
- [ ] Planning-only scope honored; authorized execution not abandoned at the plan
