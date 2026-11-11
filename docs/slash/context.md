# /context — Context Window Inspector

Alias: `/ctx`.

## What it does

Shows a live snapshot of the current context window. In TUI, bare `/context` opens the interactive Ink monitor and leaves only a two-line context/memory summary in chat history; it never prints the removed Markdown dashboard. The panel includes the measured token breakdown and exact SAGE `ctx`/`pending`/`left` state. CLI/REPL keeps the text report and configuration subcommands below.

## CLI/REPL subcommands

| Usage | Output |
|---|---|
| `/context` | Summary + breakdown (system / tools / history / volatile est. tokens and % of limit) + the 3 heaviest static system sections |
| `/context detail` | Above + full per-section static audit, model, cwd, projectRoot, file mtimes, file list |
| `/context repair` | Scan for orphan tool_use/tool_result blocks, remove them |
| `/context limit` | Show the effective context window used by auto-compaction |
| `/context limit <tokens>` | Set the effective context window for this session, e.g. `220k` or `220000` |
| `/context limit <tokens> --persist` | Set the effective context window and persist it to config |
| `/context thresholds <warn> <soft> <hard>` | Set compaction thresholds for this session, e.g. `50% 70% 85%` |
| `/context thresholds <warn> <soft> <hard> --persist` | Set thresholds and persist them to config |
| `/context mode` | List available context-window modes |
| `/context mode <id>` | Switch to a named mode: `balanced`, `frugal`, `deep`, or `archival` |
| `/context cache` | Prompt-cache report: last-request and session hit ratio, tokens read/written, USD saved, per-provider split, and the active provider's cache mechanism |
| `/context residency` | What the last request held on the wire: each segment's cached / written / uncached lanes, the provider-reported read/write split, the cache verdict and what broke it, and what the next compaction keeps |
| `/context cliff` | Long-context **price cliff** report for the active model: the published boundary and multiplier from the model catalog, the compaction trigger it forces — `min(threshold × window, cliff × 0.95)` — where the next compaction lands, the headroom left, and whether the cap is actually binding. Distinguishes the four honest states: no cliff published, a cliff that the window-relative ladder already beats, a cliff that can't apply because the session has no known window, and a cliff in force. Toggle: `context.priceCliff` |

## What "repair" does

During manual editing of the conversation history, it's possible to leave `tool_use` blocks that don't have a matching `tool_result`, or vice versa. `/context repair` runs `repairToolUseAdjacency()` to detect and remove these orphan pairs, then reports how many were removed.

## Context window modes

WrongStack ships with configurable context-window policies that control when compaction fires:

| Mode | Behavior |
|---|---|
| `balanced` | Default rolling compaction; recent work stays verbatim, old tool output is trimmed |
| `frugal` | Token-saver mode; compacts early and keeps a tighter verbatim tail |
| `deep` | Long-reasoning mode; delays compaction and keeps more recent turns intact |
| `archival` | Decision-preserving mode; compacts steadily while keeping summaries prominent |

Mode is stored in `ctx.meta['contextWindowMode']` and `ctx.meta['contextWindowPolicy']` as a resolved policy object.

## Effective limit and custom endpoints

`/context limit <tokens>` is session-local and updates the live auto-compaction denominator. Use it when a custom `baseUrl`, proxy, or account-gated endpoint has a smaller real context window than the catalog reports.

Example for an endpoint that starts rejecting requests around 256K tokens:

```text
/context limit 220k
/context thresholds 50% 70% 85%

# Persist for future sessions:
/context limit 220k --persist
/context thresholds 50% 70% 85% --persist
```

For a persistent config-level setting, set `context.effectiveMaxContext` and optionally `context.warnThreshold`, `context.softThreshold`, and `context.hardThreshold` in config.

## The breakdown (TUI monitor + CLI)

The token breakdown is computed by `getContextBreakdown(ctx)` (`packages/core/src/core/context-breakdown.ts`). It attributes each system-prompt block to its origin section via a builder-side `SYSTEM_BLOCK_SOURCE` WeakMap, splits tool definitions into builtin vs MCP (by server), and separates conversation text from tool-result output. The interactive TUI `/context` monitor renders the same measured numbers plus exact provider-bound memory presence.

## Code reference

- `packages/cli/src/slash-commands/context.ts`
- `packages/cli/src/slash-commands/context-residency.ts` — `/context residency` report (`getRequestResidency()` / `getHistoryRetention()` from core)
- `packages/core/src/core/context-breakdown.ts` — `getContextBreakdown()`
- `packages/tui/src/context-slash.ts` — panel-only TUI command bridge
- `packages/tui/src/components/context-panel.tsx` — interactive TUI monitor
- `packages/core/src/execution/intelligent-compactor.ts` — `repairToolUseAdjacency()`
- `packages/core/src/models/mode-store.ts` — context window modes
