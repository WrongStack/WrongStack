# /tree — Session Tree & Branch Fold-Back

Manages non-destructive, intra-session conversation branches backed by content-addressable workspace checkpoints (`checkpointCas`). Every branch tracks its own message tail, compaction window, and tracked file manifest inside the same `.jsonl` session log.

## Subcommands

| Usage | Effect |
|---|---|
| `/tree` | Open the interactive `<SessionTreeOverlay>` in the TUI, or list branches in headless/REPL surfaces |
| `/tree list [--json]` | Render the ASCII branch DAG (or structured JSON snapshot with `--json`) |
| `/tree branch <name> [--at <N>] [--no-switch] [--from <branch>] [--label "<text>"] [--json]` | Fork a new branch from head or historical user prompt checkpoint `N` |
| `/tree switch <target> [--keep-files] [--json]` | Switch the active conversation branch and materialize its CAS workspace snapshot (`--keep-files` skips restoring tracked files) |
| `/tree fold [source] [--into <target>] [--focus "<text>"] [--archive] [--json]` | Synthesize a secret-scrubbed summary of `source`, switch to `target`, and inject a bounded handoff message |
| `/tree rename <target> <new-name>` | Rename a non-root branch |
| `/tree archive <target>` | Archive an inactive branch and release exclusive CAS blob references for garbage collection |

## TUI `<SessionTreeOverlay>` shortcuts

Running `/tree` with no subcommand inside the TUI opens `<SessionTreeOverlay>`:

- `↑` / `↓` (or `k` / `j`): Move cursor across branches in topological tree order
- `←` / `→` (or `h` / `l`): Jump to parent branch (`←`) or first child / next sibling branch (`→`)
- `Enter`: Switch to the highlighted branch and materialize its CAS workspace snapshot
- `s`: Switch to the highlighted branch while keeping the current working-tree files (`--keep-files`)
- `b`: Create and switch to a new child branch forked from the highlighted branch
- `f`: Fold a secret-scrubbed summary of the highlighted branch into its parent branch
- `d`: Toggle checkpoint & fork metadata details (`forkSeq`, `forkPromptIndex`, parent branch, and CAS manifest hashes)
- `a`: Archive an inactive non-root branch
- `Esc`: Close the overlay

## Secret-scrubbed branch fold-back & SAGE promotion

`/tree fold` collects the branch-exclusive transcript delta, runs `beforeCompact` extension hooks so active plugins can preserve critical structured invariants, synthesizes a concise technical handoff through the host's configured LLM provider (falling back deterministically when offline), passes the summary through `DefaultSecretScrubber` so raw API keys or credentials encountered during an exploratory spike never cross into the target branch, caps the summary to `session.branchFoldMaxTokens` (default `1200`), optionally promotes structured findings to SAGE project memory (`features.sageBranchInsights`, recording `sageMemoryIds` on `branch_folded`), switches to `--into <target>` (defaulting to the parent branch), and appends a bounded handoff message.

Autonomous leader runs can also inspect, fork, switch, or fold branches programmatically via the permission-gated `session_branch` management tool (`packages/tools/src/management/session-branch.ts`).

## Cross-surface support

- **TUI Status Bar:** Displays an accent `⎇ <branch>` status chip whenever a non-main branch is active or multiple branches exist in the session.
- **WebUI:** The chat header displays a branch pill (`⎇ <branch>`) with one-click branch switching, new-branch creation, and parent fold-back, and historical user turns expose a **Branch from here** action.
- **ACP & Headless JSON:** Passing `--json` returns `{ snapshot, activeBranchId, ... }`, and ACP clients receive `session/update` notifications when `/tree` switches or folds branches.
- **Session Picker:** Saved sessions with multiple active branches show `⎇ N branches (<active>)` in `/resume` and the WebUI sidebar.

## Code reference

- `packages/runtime/src/portable-commands/tree.ts` — portable `/tree` command implementation
- `packages/core/src/storage/session-tree-coordinator.ts` — branch lifecycle, replay, CAS materialization, and fold-back
- `packages/tui/src/components/session-tree-overlay.tsx` — interactive TUI tree navigator
- `packages/project-surfaces/src/session-tree/SessionBranchPill.tsx` — shared WebUI/surface branch control
- [Session Management](session.md)
- [Session Logging Events](../session-logging-events.md)
- [Session Tree, Live Plugins & Synchronized Graphics Plan](../plans/session-tree-live-plugins-tui-graphics-2026-11.md)
