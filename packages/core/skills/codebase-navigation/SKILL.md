---
name: codebase-navigation
description: |
  Use this skill when starting work in an unfamiliar codebase or area — finding where something is implemented, how a request flows, what depends on a piece of code, or where a change should go — before reading files one by one.
  Triggers: user says "where is", "how does this work", "find the code that", "explain this codebase", "what calls", "what uses", "architecture", "entry point", "which file handles", "get familiar with".
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [code.inspect]
trigger: "Use this skill when starting work in an unfamiliar codebase or area \u2014 finding where something is implemented, how a request flows, what depends on a piece of code, or where a change should go \u2014 before reading files one by one."
metadata:
  routing-group: workflow
---

# Codebase Navigation

## Selection card
- Task: Locate repository entry points and owning modules.
- Start: Identify the requested artifact, repository owner and acceptance criteria.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Reading files top to bottom is the slowest way to understand code and the
fastest way to fill the context window. Navigate from structure to detail:
orient, locate, trace, then read only the lines that matter. WrongStack's
codebase index turns most of these steps into a single call; without it, the
same moves work with glob, grep, and ranged reads.

## Rules

1. Orient before diving: project manifests, README / AGENTS / CONTRIBUTING, the
   top-level layout, entry points, and where tests live.
2. Search by meaning when you don't know the name, by name when you do, and by
   exact text for strings, config keys, and error messages.
3. Read skeletons before bodies — signatures, types, and exports carry most of a
   module's contract.
4. Once you know the symbol, inspect it with codebase-read-symbol; read line ranges with read only when unindexed or non-declaration content.
5. Trace relationships through the reference graph (callers, callees, imports)
   instead of guessing from file names.
6. Don't conclude absence from one empty search. Retry with another query, a
   wider scope, or exact grep — dynamic registration, string dispatch, and
   generated code are invisible to indexes.
7. Keep a running map of key files, entry points, and traced flows so nothing
   gets read twice.

## Tool ladder

| Need | With the codebase index | Without it |
|---|---|---|
| Architecture at a glance | codebase-repo-map tool (hub files ranked by centrality) | Manifests, top-level directories, entry points |
| Code for a described behaviour | codebase-context tool | grep for domain words; glob for likely file names |
| A symbol by name or kind | codebase-search tool | grep for the declaration |
| A module's contract | codebase-skeleton tool | Read only exports and type definitions |
| Specific declaration / implementation | codebase-read-symbol tool | Ranged read with offset and limit |
| Who calls this, what it calls | codebase-incoming-calls and codebase-outgoing-calls tools | grep the name, read the call sites |
| What breaks if it changes | codebase-impact-analysis tool | Callers plus the tests that import it |
| Whether the index is trustworthy | codebase-stats tool; codebase-index tool to build or refresh | — |
| Exact strings and config keys | grep | grep |

## Workflows

### "Where is this handled?"

1. Describe the behaviour to the codebase-context tool (or grep domain words).
2. Read the relevant declaration range of the top result.
3. Confirm with one hop of callers or callees before answering.

### "How does a request flow?"

1. Find the entry: route table, CLI command registry, event or queue handler.
2. Follow outgoing calls one hop at a time and write the chain down:
   handler → service → repository → query.
3. Note where data is validated, transformed, persisted, and where errors are
   handled.

### "Where should my change go?"

1. Find the closest existing feature that does something similar, and mirror its
   structure and naming.
2. Check the impact of every symbol you plan to touch.
3. Find that neighbour's tests; new tests go beside them.

### Index missing or stale

If search returns nothing for code you can see, check index health with the
codebase-stats tool and rebuild with the codebase-index tool, or fall back to
grep. Vendored, generated, and dynamically registered code may never be indexed.

## Reporting what you found

```text
## How order placement works
Entry: src/routes/orders.ts:24 (POST /orders)
Flow: createOrder → OrderService.place (src/services/order.ts:58) → OrderRepo.insert (src/db/orders.ts:31)
Validation: request schema at src/routes/orders.ts:12
Side effects: emits order.placed (src/services/order.ts:90), consumed by src/workers/email.ts:15
Tests: tests/services/order.test.ts
Not traced: whether the email worker retries on failure
```

## Anti-patterns

- **Reading whole large files** to find one function.
- **"Not used" or "doesn't exist"** from a single empty search.
- **Architecture guessed from directory names.**
- **Re-reading the same files** because no map was kept.
- **Recursive tree dumps** of the entire repository.

## Before returning

- [ ] Claims about location and flow cite file:line
- [ ] Absence claims backed by more than one search method
- [ ] Untraced links in a flow labelled as such

## Resolve source identity

Check workspace exports, aliases, generated modules and build resolution before
assuming the file you read is the code a caller executes. Record source vs.
dist entrypoints and index freshness. Search dynamic registries/config keys when
symbol references are empty; generated public APIs can have external consumers.
Prefer bounded rg searches for exact text when no indexed surface is available.

## Skills in scope

- `refactor-planner` — when the map feeds a multi-file change
- `debugging` — when navigation is in service of a failure
- `code-review` — for checking the blast radius of a change set
- `multi-agent` — for surveying a very large codebase in parallel
