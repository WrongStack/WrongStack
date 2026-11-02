# Spec-Driven Development — WrongStack (Compact)

<!-- source-version: 2.2.2 -->

## Selection card
- Task: Define acceptance criteria and dependent tasks. / TR: Kabul kriteri ve bağımlı görevler tanımla.
- Start: Read the request and the code it touches, then write acceptance criteria before any task list.
- Finish: The spec and task graph exist, each task has a verifiable done condition, and execution status is tracked through /sdd.

## Overview

For an SDD task, start with a spec proportionate to its scope. The spec is the source of truth — it defines what to build, how to verify it, and what counts as done. SDD uses `/sdd` slash commands to create specs, generate task graphs, and track execution.

## Rules

1. Use SDD for requested specifications or tasks that benefit from explicit acceptance and dependency tracking.
2. Spec must have acceptance criteria — without them, you can't know when it's done.
3. Record real dependencies between tasks, and only real ones — unchained tasks are the ones that can run in parallel.
4. Spec must be specific: "Users authenticate via OAuth2 with PKCE" not "improve auth".
5. For urgent work, keep acceptance and recovery explicit without forcing unnecessary ceremony.
6. When the spec reveals a refactor, apply the refactor-planner skill to sequence it.

## Detailed workflow

Load the full sdd skill before relying on its specialized modes,
references or output contracts. Its current SKILL.md is the source of truth;
this compact body does not expand task scope or authorization.

## Before returning

- [ ] Spec has observable acceptance criteria with commands or user-journey checks
- [ ] Every requirement is specific enough to be tested, not "improve X"
- [ ] Real dependencies recorded; independent tasks left unchained so they can run in parallel
- [ ] Spec template matches the work type (feature/bugfix/refactor/infra/integration/cli-command)
- [ ] Multi-file refactors use refactor-planner sequencing while preserving task scope
- [ ] Critical path called out; bottlenecks named; parallel groups identified
