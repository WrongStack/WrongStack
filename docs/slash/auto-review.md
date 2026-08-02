# `/auto-review` — Continuous auto-review status

`/auto-review` is registered by the opt-in `wstack-auto-review` plugin **only when that plugin's resolved `enabled` option is true**. It reports:

- whether auto-review is enabled;
- the provider and model selected for review subagents;
- the fallback model chain;
- the debounce window, file cap, and parallelism limit;
- the passive follow-up policy; and
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
  → buildReviewContext (diffs, siblings, commits, todos)
  → emit chimera.review_needed
  → Director spawns review subagent (provider/model from config)
  → persist full report + mailbox result
  → emit chimera.review_complete
  → emit chimera.report_available to TUI, WebUI, and SimpleUI
  → stop; wait for explicit user action
```

## Passive completion boundary

A completed report is advisory. The runtime persists the full text, sends a
mailbox result, and shows a compact availability notice in TUI, WebUI, and
SimpleUI. It does not append the report as a normal assistant response, wake the
leader, spawn a mutating agent, or re-review edits. Legacy `cascadeOn` and
`maxCascadeDepth` values are accepted for compatibility but resolve to this
manual policy.

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
      "maxFilesPerBatch": 15
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

- `packages/core/src/plugins/auto-review-plugin.ts` — change detector and review scheduler
- `packages/cli/src/execution-chimera-review.ts` — persistence, mailbox delivery, and passive notification
