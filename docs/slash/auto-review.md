# `/auto-review` — Continuous auto-review status

`/auto-review` is registered by the opt-in `wstack-auto-review` plugin **only when that plugin's resolved `enabled` option is true**. It reports:

- whether auto-review is enabled;
- the provider and model selected for review subagents;
- the fallback model chain;
- the debounce window, file cap, and parallelism limit;
- the cascade follow-up agent threshold; and
- how many reviews are currently in-flight.

Unlike `/chimera` (which fires once at session end) and `/review` (which is manual), auto-review detects changes on every `iteration.completed` event. With a positive `debounceMs`, it starts a review in the background only after the files have remained quiet for the full debounce window; rapid edits within one burst restart that window and are batched into one review. Setting `debounceMs` to `0` disables the quiet window, so every `iteration.completed` event proceeds directly to review emission.

When the session ends, any pending mid-session quiet-window timer is cancelled so it cannot spawn a delayed reviewer after post-session processing begins. The auto-review and Chimera `session.ended` handlers each independently re-read changed files and may emit `chimera.review_needed`; review emission is deduplicated, so this is concurrent final-review detection rather than a transfer of queued files. Auto-review performs this final changed-file check even when no files are pending in its timer queue.

## Subcommands

| Command | Effect |
|---------|--------|
| `/auto-review` | Show current status and config. |
| `/auto-review on` | Enable (via config update). |
| `/auto-review off` | Disable. |

Enable/disable is driven by `config.json` under `extensions["wstack-auto-review"]`.

## How it works

```
iteration.completed
  → git status (detect new file changes since last trigger)
  → if debounceMs > 0, restart trailing debounce timer
  → after debounceMs of file quiet, re-read snapshots
  → if content changed again, restart the quiet window
  → if debounceMs = 0, emit review directly (no quiet window)
  → batch (cap at maxFilesPerBatch)
  → read file contents
  → buildReviewContext (diffs, siblings, commits, todos, cascadeOn)
  → emit chimera.review_needed
  → Director spawns review subagent (provider/model from config)
  → review report → session transcript + mailbox broadcast
  → emit chimera.review_complete
  → plugin parses severity from report
  → if cascadeOn threshold crossed → emit chimera.cascade_needed
  → Director spawns fix agents (security-scanner, bug-hunter)
  → agents APPLY FIXES (edit tool + typecheck/lint)
  → if cascadeDepth < maxCascadeDepth → re-read files, re-emit review_needed
  → ... repeats until clean OR depth limit reached
```

## Cascade (self-correcting follow-up agents)

When `cascadeOn` is set to `"high"` or `"critical"`, a review report containing findings at or above that severity automatically triggers follow-up agents that **investigate and apply fixes** (not just report):

| `cascadeOn` | Fires when | Agents spawned |
|-------------|-----------|----------------|
| `"off"` (default) | Never | None |
| `"high"` | Any High or Critical finding | `bug-hunter` + `security-scanner` (if security keyword present) |
| `"critical"` | Any Critical finding | `bug-hunter` + `security-scanner` (if security keyword present) |

The plugin's `parseReviewSeverity()` extracts Critical/High/Medium counts from the report (matching `### Critical (N)` headers), then `shouldCascade()` gates on the threshold. `decideCascadeAgents()` scans the Critical and High sections for 20 security keywords (injection, xss, secret, shell, deserialization, innerhtml, path traversal, etc.) to decide whether the `security-scanner` agent should join `bug-hunter`.

Follow-up agents receive the review report (capped at 12K chars) and the changed file list. They read the flagged files, confirm or refute each finding, **apply fixes using the edit tool**, and run typecheck/lint to verify. Results are appended to the session transcript.

### Closed self-correcting loop

After fix agents finish, the system re-reads the (now modified) files and re-emits `chimera.review_needed` to trigger a fresh review of the post-fix state. If that review still finds High+ findings, the cycle repeats. The loop is bounded by `maxCascadeDepth`:

```
fix agents apply fixes → re-read files → re-review (depth N+1)
  → if still High+ and depth < maxCascadeDepth → cascade again
  → if clean → loop ends naturally
  → if depth >= maxCascadeDepth → stop with "manual review recommended" message
```

| `maxCascadeDepth` | Behavior |
|-------------------|----------|
| `0` | Fix agents run once, no re-review (open-loop) |
| `1` | Fix agents run, one re-review to verify |
| `2` (default) | Up to 2 re-review cycles |
| `N` | Up to N re-review cycles |

When the depth limit is reached, a session message informs the user the loop stopped intentionally — not because fixes converged.

## Configuration

Configuration is read from `extensions["wstack-auto-review"]`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | false | Master switch |
| `provider` | string | session provider | LLM provider for review agents |
| `model` | string | session model | LLM model for review agents |
| `fallbackProfile` | string | — | Named fallback profile from `config.fallbackProfiles` |
| `debounceMs` | number | 15000 | Required file-quiet period before a mid-session review starts |
| `maxFilesPerBatch` | number | 15 | Max files per review call |
| `maxConcurrentReviews` | number | 2 | Parallel review subagent cap |
| `cascadeOn` | "off" \| "critical" \| "high" | "off" | Follow-up agent threshold — spawns security-scanner/bug-hunter when findings cross this severity |
| `maxCascadeDepth` | number | 2 | Max fix→re-review cycles (0 disables re-review; the self-correcting loop stops at this depth) |

WebUI preference stores created before v12 migrate the former canonical `5000` ms default to `15000` ms once. Values explicitly selected on v12 or later remain unchanged.

Example config:

```json
{
  "extensions": {
    "wstack-auto-review": {
      "enabled": true,
      "provider": "deepseek",
      "model": "deepseek-chat",
      "debounceMs": 15000,
      "maxFilesPerBatch": 15,
      "cascadeOn": "high",
      "maxCascadeDepth": 2
    }
  }
}
```

## What is reviewed

- **Only git-tracked files** that changed since the last review trigger
- **Debounced** — review starts only after `debounceMs` without another detected edit
- **Post-session review** — when the session ends, any pending mid-session quiet-window timer is cancelled and a final changed-file scan runs in the auto-review and Chimera `session.ended` handlers. Each may emit `chimera.review_needed` and emission is deduplicated; this runs even when no files are pending in the timer queue.
- **Capped** at `maxFilesPerBatch` files per call
- **Skipped** — `.wrongstack/` files
- **Deleted files** are silently omitted

## Requirements

- **`--director` flag** (Director mode) — the subagent spawning pipeline (`execution.ts`) requires the Director to be active. Without it, review events are silently skipped.
- **`git`** available in the session working directory.

See also: [`/chimera`](chimera.md) (post-session review), [`/review`](review.md) (manual review trigger).

## Code reference

- `packages/core/src/plugins/auto-review-plugin.ts` — plugin, severity parser, cascade listener
- `packages/cli/src/execution.ts` — `review_complete` emission, `cascade_needed` handler
