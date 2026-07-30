---
name: auto-review
description: |
  Use this skill to configure and understand the built-in auto-review plugin
  (wstack-auto-review) that fires automated code review subagents on every
  code change during a session.
  Triggers: user says "auto review", "otomatik review", "auto code review",
  "her değişiklikte review", "/auto-review".
version: 2.0.0
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
                                    Severity-ranked report → session + mailbox
                                                  ↓
                                    chimera.review_complete event
                                                  ↓
                                    parseReviewSeverity → shouldCascade
                                                  ↓  (if threshold crossed)
                                    chimera.cascade_needed event
                                                  ↓
                                    Director spawns follow-up agents
                                    (security-scanner, bug-hunter)
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
      "debounceMs": 15000,
      "maxFilesPerBatch": 15,
      "cascadeOn": "high",
      "maxCascadeDepth": 2
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
| `fallbackProfile` | string | effective fallback profile | Named profile from `fallbackProfiles`; its first valid entry supplies the primary provider/model when those are omitted |
| `debounceMs` | number | 15000 | Required file-quiet period before a mid-session review starts |
| `maxFilesPerBatch` | number | 15 | Files per review call |
| `maxConcurrentReviews` | number | 2 | Parallel review subagent cap |
| `cascadeOn` | "off"|"critical"|"high" | "off" | Follow-up agent threshold — spawns security-scanner/bug-hunter when findings cross this severity |
| `maxCascadeDepth` | number | 2 | Max fix→re-review cycles (0 = open-loop, no re-review) |

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

## Cascade (self-correcting follow-up agents)

When `cascadeOn` is `"high"` or `"critical"`, a review finding at or above that
threshold triggers follow-up agents that **investigate and apply fixes**
automatically. The cascade chain works as follows:

```
chimera.review_complete (carries report text + original bundle)
         │
         ▼
auto-review plugin: parseReviewSeverity() extracts Critical/High/Medium counts
         │
         ▼  shouldCascade() gates on bundle.cascadeOn
         │
chimera.cascade_needed (carries severities + selected agents)
         │
         ▼
execution.ts: spawns fix subagents via Director
  • security-scanner — when a Critical/High finding mentions a security
    keyword (injection, XSS, secret, shell, deserialization, etc.)
  • bug-hunter — for any High+ finding (correctness concerns)
         │
         ▼  agents apply fixes (edit tool + typecheck/lint)
         │
re-read modified files → re-emit chimera.review_needed (depth N+1)
         │
         ▼  bounded by maxCascadeDepth — stops at limit or when clean
```

Both agents may spawn in parallel when a finding is both severe and
security-related. The follow-up agents receive the review report (capped at
12K chars) and the changed file list, read the flagged files, confirm or refute
each finding, **apply fixes using the edit tool**, and run typecheck/lint to
verify.

### Closed self-correcting loop

After fix agents apply their changes, the system re-reads the modified files
and re-emits `chimera.review_needed` to trigger a fresh review of the post-fix
state. If that review still finds High+ findings, the cycle repeats up to
`maxCascadeDepth` iterations. When the depth limit is reached, a session message
informs the user the loop stopped intentionally.

| `maxCascadeDepth` | Behavior |
|-------------------|----------|
| `0` | Fix agents run once, no re-review (open-loop) |
| `1` | Fix + one re-review to verify |
| `2` (default) | Up to 2 re-review cycles |
| `N` | Up to N re-review cycles |

### Severity thresholds

| `cascadeOn` | Fires when |
|-------------|-----------|
| `"off"` | Never (default) |
| `"high"` | Any High OR Critical finding |
| `"critical"` | Only Critical findings |

### Agent selection

`decideCascadeAgents()` scans only the Critical and High report sections for
security keywords. A Medium-only security finding does **not** trigger the
cascade — it doesn't cross the threshold. The 20 security keywords include:
injection, xss, csrf, ssrf, sql, secret, credential, password, api key,
token, auth, shell injection, command injection, innerhtml, deserialization,
path traversal, hardcoded, privilege, owasp.

## Skills in scope

- `chimera` — for the review output format and severity rules
- `shadow-agent` — for cron-based background monitoring pattern
- `node-modern` — for understanding the TypeScript plugin code
- `git-flow` — for git diff detection patterns
- `multi-agent` — for subagent delegation and fleet management
- `security-scanner` — for security vulnerability patterns
- `bug-hunter` — for systematic bug detection
