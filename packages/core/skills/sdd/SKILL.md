---
name: sdd
description: |
  Use this skill when starting a non-trivial implementation, bug fix, or refactor
  in WrongStack. Triggers: user says "/sdd", "spec", "specification", "task graph",
  "SDD", "acceptance criteria", or starts a new feature.
version: 2.1.0
---

# Spec-Driven Development — WrongStack

## Overview

Every non-trivial change starts with a spec. The spec is the source of truth — it defines what to build, how to verify it, and what counts as done. SDD uses `/sdd` slash commands to create specs, generate task graphs, and track execution.

## Rules

1. Every non-trivial task needs a spec before writing code — you'll rewrite it anyway.
2. Spec must have acceptance criteria — without them, you can't know when it's done.
3. Tasks must have dependencies — everything is a dependency of something.
4. Spec must be specific: "Users authenticate via OAuth2 with PKCE" not "improve auth".
5. Skipping `/sdd` for urgent tasks backfires — the spec is what makes "urgent" possible.
6. When the spec reveals a multi-file refactor, delegate to `refactor-planner` first.

## When to use

- New feature implementation
- Bug fix with complexity
- Refactoring with scope
- Any task requiring more than 1 hour

## The SDD workflow

```
1. /sdd new [title]          → Build spec from questions
2. /sdd tasks <id>           → Generate task graph from spec
3. /sdd graph <id>           → Visualize dependencies
4. /sdd critical <id>        → Find bottlenecks
5. /sdd execute <id>         → Run tasks (or execute manually)
```

## Task lifecycle commands

| Command | What it does |
|---------|--------------|
| `/sdd tasks` | Show task list with progress bar (sorted: in_progress → pending → review → blocked → failed → completed) |
| `/sdd next` | Show next executable task + blockers |
| `/sdd done <N>` | Complete a task (by number or fuzzy title match) |
| `/sdd skip <N>` | Skip a task back to pending |
| `/sdd fail <N>` | Mark a task as failed |
| `/sdd review <N>` | Send a task to review |
| `/sdd edit <N> <text>` | Edit task title (short text) or description (long text) |
| `/sdd undo` | Undo last task completion |
| `/sdd graph` | ASCII task dependency visualization |
| `/sdd critical` | Critical path analysis + bottlenecks |

## Spec templates

| Template | Best for |
|---|---|
| `feature` | New feature development |
| `bugfix` | Bug fix with root cause analysis |
| `refactor` | Code refactoring with goals |
| `infra` | Infrastructure/tooling changes |
| `integration` | External service integration |
| `cli-command` | New CLI commands/slash commands |

## Spec structure

A complete spec has:
1. **Overview** — What problem does this solve?
2. **Requirements** — `[priority] description` format
3. **Architecture** — High-level design (if needed)
4. **API Design** — Endpoints, inputs, outputs (if applicable)
5. **Acceptance Criteria** — How do we know it's done?

### Requirement format

```
[critical] Users can authenticate with OAuth2
[high] Rate limiting: 100 req/min per user  
[medium] Response time < 200ms p95
[low] Support dark mode
```

## Task graph generation

Each requirement generates one or more tasks. Tasks have states:
```
pending → in_progress → review → completed
              ↓
           blocked (waiting on dependencies)
              ↓
           failed
```

## Critical path

The critical path finds:
- **Bottleneck tasks** blocking the most downstream work
- **Parallel groups** that can run concurrently
- **Ready tasks** that can start immediately
- **Execution order** respecting all dependencies

## Goal & Eternal Mode

`/sdd` pairs with `/goal` for autonomous execution:

| Command | What it does |
|---------|--------------|
| `/goal set <text>` | Set an autonomous mission |
| `/goal pause` | Pause at end of current iteration |
| `/goal resume` | Resume a paused goal |
| `/goal journal [N]` | Show recent journal entries |
| `/goal clear` | Clear goal and stop eternal mode |
| `/autonomy eternal` | Run goal loop indefinitely |
| `/autonomy stop` | Stop eternal mode |

**Eternal stage flow:** `decide → execute → reflect → sleep | paused | stopped`
Stage shown in real-time. Pause stops after current iteration completes.

## Anti-patterns

- **Writing code before the spec** — you'll rewrite it anyway
- **Spec that's too vague** — "improve auth" is not a spec, "Users authenticate via OAuth2 with PKCE" is
- **Tasks with no dependencies** — everything is a dependency of something
- **Spec without acceptance criteria** — how do you know when it's done?
- **Skipping /sdd for urgent tasks** — the spec is what makes "urgent" possible

## Skills in scope

- `refactor-planner` — when the spec reveals a multi-file refactor
- `bug-hunter` — when a bugfix spec needs a root cause analysis section
- `multi-agent` — for executing parallel task groups
- `output-standards` — for standardized `<nextsteps>` formatting