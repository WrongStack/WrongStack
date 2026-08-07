---
name: mnemosyne
description: |
  Use when curating WrongStack SAGE memory: run deterministic hygiene and
  anchor verification first, then review contradictions, drift, and noise;
  file destructive outcomes as review proposals instead of deleting directly.
version: 1.1.0
required-capabilities: [memory.manage, memory.curate]
required-tools: [cron_cancel, cron_schedule, mail_send, mailbox, memory_candidates, memory_delete, memory_hygiene, memory_search, memory_update, memory_verify, skill]
---

# Mnemosyne — SAGE Memory Custodian

## Overview

Mnemosyne is the repeatable memory-curation workflow for any project using
WrongStack SAGE memory. It is not a separate storage engine and does not make
an LLM the source of truth. The runtime tools perform deterministic cleanup and
verification; semantic analysis is a bounded second pass over their results.

WrongStack discovers this bundled skill at boot. Every prompt mode receives its
name and trigger. Eager mode may inject this body directly; progressive mode
loads it through the `skill` tool. The detailed execution prompt is bundled as
`instructions/agent-prompt.md` and should be loaded before a deep review.

## Runtime Contract

Use only surfaces that are actually registered in the current session:

| Surface | Purpose |
|---|---|
| `memory_hygiene` | Deterministic deduplication, anchor verification, stale marking, superseding, and review-candidate creation |
| `memory_verify` | Targeted or full anchor verification |
| `memory_search` | Retrieve related memories for contradiction and duplication checks |
| `memory_update` | Apply non-terminal corrections: text, classification, confidence, relationships, or `stale` status |
| `memory_candidates` | File and inspect non-destructive review proposals; explicit resolution is a separate user-authorized action |
| `skill` | Load this body and `instructions/agent-prompt.md` in progressive mode |
| `cron_schedule` / `cron_cancel` | Optional in-session recurrence when the cron plugin is available |
| `mail_send` / `mailbox` | Optional report delivery when mailbox tools are available |

There is currently no standalone `/mnemosyne` slash command, implicit startup
hook, or `mnemosyne_*` config namespace. Do not claim that one exists. Users can
ask for a “Mnemosyne review”, load it explicitly with `/skill mnemosyne`, or use
the existing `/memory hygiene`, `/memory verify`, and `/memory candidates`
surfaces.

## Workflow

### 1. Deterministic hygiene

Start every cycle with:

```text
memory_hygiene({ verify: true })
```

Capture the returned counts. This phase may deduplicate, mark stale anchors,
supersede obsolete versions, and create review candidates. It must not delete
or archive memories. Treat non-zero `deleted` or `archived` counters as a bug.

Run `memory_verify` separately only when you need a targeted re-check or when
hygiene could not complete verification.

### 2. Bounded semantic review

Search for related active/stale memories and review them in bounded batches.
For the detailed review workflow, load:

```text
skill({ name: "mnemosyne", resource: "instructions/agent-prompt.md" })
```

Evaluate:

1. Contradictions between memories.
2. Duplicate or mergeable facts missed by exact matching.
3. Vague, transient, or low-value entries.
4. Incorrect kind, scope, importance, or confidence.
5. Drift between anchored code and the memory claim.

Do not infer that a missing search result means a memory does not exist. Keep
batch sizes and LLM calls bounded, and leave unchanged memories untouched.

### 3. Apply safe corrections

Direct updates are allowed only for non-terminal corrections:

- Fix inaccurate text when current project evidence is clear.
- Correct kind, scope, importance, or confidence.
- Mark a contradicted or invalid entry `stale`.
- Link superseding/contradicting memories or mark a duplicate `superseded`.

For deletion or archival recommendations, file a proposal:

```text
memory_candidates({
  action: "propose",
  text: "Concise review finding",
  memory_id: "mem_target",
  reason: "Why this memory needs user review",
  suggested_action: "delete" | "archive" | "investigate"
})
```

Never call `memory_delete`, never set `status: "deleted"`, and never set
`status: "archived"` as part of an autonomous Mnemosyne cycle. The user owns
the later `memory_candidates({ action: "resolve", ... })` decision.

### 4. Report

Return a concise report containing:

- Trigger (`on_demand` or `cron`).
- Examined, deduplicated, verified, staled, and superseded counts.
- Semantic findings and safe corrections applied.
- Review proposals filed, grouped by suggested action.
- Errors or skipped checks.

Broadcast the report only when a mailbox tool is registered and coordination is
active. Never invent a successful broadcast or scheduled cycle.

## Optional Recurrence

Recurring curation is explicitly opt-in and session-scoped. When
`cron_schedule` is registered, schedule a plain-language action that causes a
future agent turn to run this workflow, for example:

```text
cron_schedule({
  name: "mnemosyne-review",
  intervalMs: 21600000,
  action: "Run the bundled mnemosyne workflow: deterministic hygiene first, then bounded semantic review, propose-only for delete/archive."
})
```

Do not describe this as a persistent daemon: cron jobs belong to the live
runtime and must be inspected or cancelled through the cron tools. If those
tools are absent, run on demand instead.

## Guardrails

- Deterministic checks always precede LLM analysis.
- Destructive and terminal outcomes are proposal-only.
- Permanent and high-importance memories receive extra scrutiny; never bypass
  store protections with `force`.
- A memory that passes review is not rewritten merely to bump timestamps.
- Record evidence for each mutation in the report; every proposal includes its supported `reason`.
- A failed batch does not invalidate successful deterministic results.
- Never advertise commands, config keys, background services, or tools that
  are not present in the live runtime.

## Skills in Scope

- `auto-review` — bounded background-review and reporting patterns.
- `multi-agent` — delegated semantic review when a separate context is useful.
- `observability` — structured cycle reporting without leaking memory content.
- `security-scanner` — identify secrets or sensitive data accidentally stored
  in memory; remediation remains proposal-first.
