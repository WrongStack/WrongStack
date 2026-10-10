---
name: auto-review
description: |
  Use this skill to configure and understand the built-in auto-review plugin
  (wstack-auto-review) that fires automated code review subagents on every
  code change during a session.
  Triggers: user says "auto review", "otomatik review", "auto code review",
  "her değişiklikte review", "/auto-review".
version: 2.2.1
required-capabilities: [version-control.manage]
required-tools: [git]
optional-capabilities: [fleet.delegate, verification.run]
trigger: "Use this skill to configure and understand the built-in auto-review plugin (wstack-auto-review) that fires automated code review subagents on every code change during a session."
metadata:
  routing-group: quality
---

# Auto Review — Built-in Plugin

## Selection card
- Task: Operate the built-in automatic review plugin.
- Start: Identify the scope and obtain an executable before-proof or review evidence.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

The **`wstack-auto-review`** plugin (built into `@wrongstack/core`) detects
every git-tracked file change during a session and automatically dispatches
a review subagent after a trailing file-quiet window. It extends the Chimera
review pipeline with **mid-session** reviews while leaving any work still
waiting at `session.ended` to the post-session Chimera path.

```
iteration.completed → git diff → trailing quiet window → chimera.review_needed event
                                                   ↓
                                    Director spawns review subagent
                                    (provider/model from config)
                                                  ↓
                                    Severity-ranked report → store + mailbox
                                                  ↓
                                    chimera.review_complete event
                                                  ↓
                                    chimera.report_available notification
                                                  ↓
                                    stop (with cascadeOn set: follow-up fix agents)
```

## Status

**This is a built-in plugin** (`packages/core/src/plugins/auto-review-plugin.ts`),
NOT a skill-based watcher. It is loaded automatically and **enabled by default**.
Optional overrides in your config:

```json
{
  "extensions": {
    "wstack-auto-review": {
      "provider": "deepseek",
      "model": "deepseek-chat",
      "fallbackProfile": "reliable",
      "modelSelection": "round-robin",
      "debounceMs": 15000,
      "maxFilesPerBatch": 15
    }
  }
}
```

## Requirements

- **`--director` flag** (Director mode) — the subagent spawning pipeline
  (execution.ts) requires the Director to be active. Without it, review
  events are silently skipped.
- **`git`** available in the session working directory.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | true | Master switch |
| `provider` | string | session provider | LLM provider for review agents |
| `model` | string | session model | LLM model for review agents |
| `fallbackProfile` | string | effective fallback profile | Named profile from `fallbackProfiles`; its first valid entry supplies the primary provider/model when those are omitted, and its entries form the reviewer selection and retry pool |
| `modelSelection` | `round-robin` \| `random` | `round-robin` | Choose each review's starting model in profile order or randomly; remaining entries stay available as fallbacks |
| `debounceMs` | number | 15000 | Required file-quiet period before a mid-session review starts |
| `maxFilesPerBatch` | number | 15 | Files per review call |
| `maxConcurrentReviews` | number | 2 | Parallel review subagent cap |
| `cascadeOn` | `off` \| `high` \| `critical` | `high` | Follow-up agents (bug-hunter / security-scanner) for verified findings at or above this severity |
| `maxCascadeDepth` | number | 2 | Max fix → re-review cycles when the cascade triggers |

## Slash commands

| Command | Action |
|---------|--------|
| `/auto-review` | Show status + current config |
| `/auto-review on` | Enable (via config update) |
| `/auto-review off` | Disable |

## What is reviewed

- **Only git-tracked files** with staged or unstaged changes; untracked (`??`) files are never read or reviewed
- **Content-aware** — later edits to an already-modified file trigger again when its content fingerprint changes
- **Debounced without loss** — rapid edits restart the quiet window; the latest content is reviewed in the background after the full window elapses
- **Lifecycle-safe** — `session.ended` cancels a pending mid-session timer and hands those files to post-session Chimera
- **Capped** at `maxFilesPerBatch` files per call; overflow stays pending
- **Skipped** — `.wrongstack/` files
- **Deleted files** are silently omitted

## Completion and cascade

Every completed review is persisted and announced through
`chimera.report_available`. A report never becomes a normal assistant response
or wakes the leader. By default (`cascadeOn: "high"`) verified findings at High
or Critical trigger follow-up fix agents (bug-hunter / security-scanner),
bounded by `maxCascadeDepth` fix → re-review cycles; findings below that
threshold leave the user to decide later whether to act. Set `cascadeOn` to
`"critical"` or `"off"` to narrow or disable the cascade.

## Out of scope

- **Don't rely on auto-review without `--director`.** The subagent pipeline requires Director mode; without it, review events silently skip. Verify the director is on before relying on its reviews.
- **Don't start the plugin while a session is mid-flight without a clear contract.** Auto-review dispatches reviewers at trailing-quiet windows; the user has to know it's running.
- **Don't read untracked files.** `??` files are never reviewed. If a reviewer needs a file, the workflow must have it staged or tracked first.
- **Don't manually trigger a fix from a report.** The report goes to the mailbox and notifies UIs. A follow-up fix is a separate user-initiated turn unless the `cascadeOn` threshold (default `high`) triggers the correction cascade.
- **Don't re-route the report to mailbox peers or the leader.** Runtime handles persistence and notification. Manual mailbox traffic from auto-review is double-handling.
- **Don't tune `maxFilesPerBatch` above 15** without measuring cost. Larger batches cut parallelism gains and inflate single-review latency.
- **Don't set the debounce below 5s.** Too-aggressive debounce starts reviews while the user is still mid-edit; they hit a reviewer they didn't ask for.

## Before reporting

- [ ] `--director` mode is on (auto-review requires it)
- [ ] `wstack-auto-review` is enabled (the default — check nothing set `enabled: false`)
- [ ] `git` is available in the session working directory
- [ ] Only git-tracked files are reviewed; untracked files skipped
- [ ] Reports go to the mailbox + `chimera.report_available` notification, not to peer mail
- [ ] Follow-up fix agents only when findings meet the `cascadeOn` threshold (default `high`)
- [ ] Debounce and `maxFilesPerBatch` tuned for the workload, not at default

## Validate the effective configuration

Read effective runtime settings and the current plugin/Director wiring, rather
than assuming the presence of this skill starts a reviewer. Distinguish configured,
queued, running, completed and persisted reviews. Record the reviewed file snapshot
when edits continue during review; stale findings need confirmation on current code.
Keep review completion, runtime cascade decisions and user-authorized changes
separate. Check the stored report and finding state before claiming delivery.

## Acceptance checks

- Verify plugin configuration and a real review event; distinguish a generated report from fixes applied.

## Skills in scope

- `chimera` — for the review output format and severity rules
- `node-modern` — for understanding the TypeScript plugin code
- `git-flow` — for git diff detection patterns
- `multi-agent` — for subagent delegation and fleet management
- `security-scanner` — for security vulnerability patterns
- `bug-hunter` — for systematic bug detection
