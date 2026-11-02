# Multi-Agent Coordination (Compact)

<!-- source-version: 2.1.2 -->

## Selection card
- Task: Plan coordinated work when delegation is authorized. / TR: Delegasyon yetkiliyse koordineli çalışma planla.
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

## Detailed workflow

Load the full multi-agent skill before relying on its specialized modes,
references or output contracts. Its current SKILL.md is the source of truth;
this compact body does not expand task scope or authorization.

## Before returning

- [ ] Delegation permitted and concurrency limits respected
- [ ] Shared writers isolated or serialized before dispatch
- [ ] Every worker status reconciled and evidence checked
- [ ] Combined result validated; gaps and conflicting observations visible
