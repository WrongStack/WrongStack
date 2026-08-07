---
name: auto-review
description: |
  Use this skill to configure and understand the built-in auto-review plugin
  (wstack-auto-review) that fires automated code review subagents on every
  code change during a session.
  Triggers: user says "auto review", "otomatik review", "auto code review",
  "her değişiklikte review", "/auto-review".
version: 2.0.0
required-capabilities: [version-control.manage]
required-tools: [git]
optional-capabilities: [fleet.delegate, verification.run]
---

# Auto Review — Built-in Plugin

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
                                    stop; wait for explicit user action
```

## Status

**This is a built-in plugin** (`packages/core/src/plugins/auto-review-plugin.ts`),
NOT a skill-based watcher. It is loaded automatically but **disabled by default**.
Enable it in your config:

```json
{
  "extensions": {
    "wstack-auto-review": {
      "enabled": true,
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
| `enabled` | boolean | false | Master switch |
| `provider` | string | session provider | LLM provider for review agents |
| `model` | string | session model | LLM model for review agents |
| `fallbackProfile` | string | effective fallback profile | Named profile from `fallbackProfiles`; its first valid entry supplies the primary provider/model when those are omitted, and its entries form the reviewer selection and retry pool |
| `modelSelection` | `round-robin` \| `random` | `round-robin` | Choose each review's starting model in profile order or randomly; remaining entries stay available as fallbacks |
| `debounceMs` | number | 15000 | Required file-quiet period before a mid-session review starts |
| `maxFilesPerBatch` | number | 15 | Files per review call |
| `maxConcurrentReviews` | number | 2 | Parallel review subagent cap |

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

## Passive completion boundary

Every completed review is persisted and announced through
`chimera.report_available`. It does not become a normal assistant response,
wake the leader, spawn a fix agent, or trigger a re-review. Legacy `cascadeOn`
and `maxCascadeDepth` config values are compatibility-only and resolve to the
passive policy. The user can inspect the mailbox and explicitly ask the leader
to act later.

## Skills in scope

- `chimera` — for the review output format and severity rules
- `shadow-agent` — for cron-based background monitoring pattern
- `node-modern` — for understanding the TypeScript plugin code
- `git-flow` — for git diff detection patterns
- `multi-agent` — for subagent delegation and fleet management
- `security-scanner` — for security vulnerability patterns
- `bug-hunter` — for systematic bug detection
