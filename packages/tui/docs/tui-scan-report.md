# TUI Scan Report — Improvement & Performance Risks

**Date:** 2026-08-07
**Scope:** `packages/tui` (Ink/React renderer, ~595 files, 19 files over the repo's 800-line hotspot threshold)
**Method:** Static analysis of source read during the scan; every finding below is verified against the code. No runtime profiling was performed (see [Assumptions](#assumptions--unverified)). Timers and polling paths that checked out clean are listed in [Verified clean](#verified-clean-no-action) so the negative space is explicit.

> **Status as of 2026-08-13 — most of this report is closed. Re-verify before acting on it.**
>
> | Finding | State |
> |---|---|
> | P1 goal read per tick | **Fixed** — mtime/size gate in `use-tui-activity.ts` |
> | P2 git child processes | **Fixed** — `gitHidden` visibility gate in `use-git-session-status.ts` |
> | P3 plan/task `fs.stat` polls | **Fixed** — `planHidden`/`taskHidden` gates in `use-statusbar-view-model.ts` |
> | P4 1s root animation tick | **Open, but the premise below is wrong** — see the note in P4 |
> | P5 `@`-search debounce | **Fixed** — `FILE_SEARCH_DEBOUNCE_MS` in `use-file-search.ts` |
> | I1 history archive stub | **Fixed** — `use-history-archive.ts` wires it; covered by `tests/use-history-archive.test.tsx` |
> | I2 hotspot files | Open; the line counts below are stale (21 files over threshold, `theme.ts` at 1447 is the largest and is missing from the table) |
> | I3 duplicated polling | **Not a real finding** — see the correction in I3 |
>
> This report has twice been re-derived by tools that read it, restated its
> closed findings as current, and ranked the already-fixed P2/P3 as the
> highest-value work. Check the code before trusting a row above.

---

## Performance risks

### P1. Whole-app re-render every 10s for the entire session lifetime + a disk read per tick

**Location:** `src/hooks/use-tui-activity.ts:114-118, 185-204, 291-293` (called at App scope, `src/app.tsx:284`)

`useTuiActivity`'s `nowTick` state setter fires every 10 seconds, unconditionally, from mount to exit. Every tick:

1. Re-renders the root App → `app-view.tsx` → `app-status-region` + `agents-monitor` (whose `selectLiveAgents` memo is keyed on `nowTick`).
2. Recomputes a heap sample (`takeHeapSample()`) and `process.cpuUsage()`.
3. Runs `refreshGoalSummary()`, which **reads the goal file from disk every 10s** even when nothing changed — the fingerprint check only gates the dispatch, not the `loadGoal` file read.

**Fix direction:** gate the goal read on file mtime or on the goal chip being visible; raise cadence to 30s; move the always-on heap/CPU sampling to the watchdog's own cadence.

---

### P2. Three `git` child processes spawned every 10s, unconditionally

**Location:** `src/hooks/use-git-session-status.ts:33-75` + `src/git-info.ts:31-43`

`readGitInfo` runs `git branch --show-current`, `git diff HEAD --numstat`, and `git status --porcelain` in parallel every 10 seconds for the whole session — even when the git statusline chip is hidden via `statuslineHiddenItems` (no visibility gate). The result is diffed with `sameGitInfo` so *re-render* is gated, but the *process spawns* are not.

**Fix direction:** gate on chip visibility; watch `.git/HEAD` mtime instead of polling for branch changes.

---

### P3. Two unconditional 3s `fs.stat` polls on plan/task files

**Location:** `src/hooks/use-statusbar-view-model.ts:236-333`

When SDD `plan.path` / `task.path` metadata exist, both effects `fs.stat` their file every 3 seconds forever (no visibility gate), and on mtime change perform a full `readFile` + `JSON.parse`. The fingerprint guard avoids re-parses but not the stat itself.

**Fix direction:** `fs.watch` or a 10s cadence, gated on the chip being visible.

---

### P4. 1s root animation tick during any activity

**Location:** `src/hooks/use-tui-activity.ts:166-180`

While `thinkingWorking || fleetRunningCount > 0 || enhanceBusy`, Ink's `useAnimation` at App scope re-renders the whole tree once per second. `workingTimeMs` / `fleetWorkingTimeMs` / `enhanceDots` are consumed by the status bar and the status region, so the elapsed-timer chip forces a full-tree render. This is the largest per-second cost during active work.

**Fix direction:** localize the elapsed-timer 1s tick inside the status bar (a leaf component) rather than the root — the elapsed chip is the only consumer that truly needs per-second updates.

**Correction (2026-08-13):** "re-renders the whole tree" and "largest per-second
cost" are both wrong. `ScrollableHistory`, `Input`, and `Entry` are all
`React.memo`-wrapped, so the expensive history subtree is already skipped;
`deriveAppViewState` is 96 lines with no loop over entries. What actually
re-renders per second is the App body, the `app-view` JSX, and the two
components that display the timer — `status-bar.tsx` (unmemoized) and `Input`
(memo, but `workingTime` changes by design). Those two must repaint every
second either way, so localizing only saves the App + app-view pass.

It is also not a free win: `useAnimation` is re-exported straight from Ink and
owns a per-component timer, so giving `status-bar` and `Input` one tick each
produces two out-of-phase commits per second — *two* terminal repaints where
there is now one. Doing this correctly needs a shared subscriber clock (one
interval, both setStates in the same callback so React batches them), which is
a deliberate design change rather than a drive-by fix. Left open on purpose.

---

### P5. Per-keystroke file-index scan + dispatch in `@`-search, no debounce

**Location:** `src/hooks/use-file-search.ts:75-96` + `src/file-search.ts:85-95`

The effect runs on every buffer/cursor change; with an active `@` token it calls `searchFiles` per keystroke, which performs an O(N) fuzzy-score loop over up to **5,000** indexed paths and dispatches `pickerSetMatches` → picker re-render. All of this is synchronous per keystroke. The 30s-TTL index walk is cached (good); the scoring and dispatch churn are not.

**Fix direction:** 150–250ms debounce + abort-in-flight.

---

## Improvement opportunities

### I1. Dead code with a functional stub behind it: "load older history" loads nothing

**Location:** `src/history-archive.ts` (entire 236-line module) + `src/app.tsx:177-185`

`HistoryArchive` (a JSONL disk archive with a byte-offset index and token-bucket writes) is **imported by no `src` file** — only tests reference it. The only call path that would use it, `onRequestOlderEntries`, is an explicit stub: it dispatches `startArchiveLoad`, then `setTimeout(() => dispatch({ type: 'archiveLoaded', entries: [] }), 0)` — scrolling past the 150-entry in-memory window (the reducer caps at `MAX_MEMORY_ENTRIES = 150`) silently returns nothing.

**Fix direction:** either wire the archive (it is the documented RAM-retention solution for long sessions) or delete the module and the stub affordance.

---

### I2. 19 TUI files exceed the repo's own 800-line hotspot threshold

**Verified in:** `architecture/hotspots.json`

| File | Lines |
|---|---|
| `src/components/sidebar-panels.tsx` | 1309 |
| `src/components/status-bar.tsx` | 1233 |
| `src/memory-slash.ts` | 1207 |
| `src/components/history/entry.tsx` | 1124 |
| `src/app.tsx` | 1081 |
| `src/components/scrollable-history.tsx` | 1030 |
| `src/components/agents-monitor.tsx` | 997 |
| `src/components/settings-picker-model.ts` | 992 |
| `src/hooks/use-picker-keys.ts` | 987 |
| `src/app-key-handler.ts` | 958 |
| `src/components/history/utils.tsx` | 950 |
| `src/app-view.tsx` | 947 |
| `src/input-validation.ts` | 952 |
| `src/kanban-slash.ts` | 930 |
| `src/components/kanban-panel.tsx` | 888 |
| `src/components/context-panel.tsx` | 859 |
| `src/app-state.ts` | 854 |
| `src/components/history/code-block.tsx` | 835 |
| `src/submit-controller.ts` | 801 |

`TUI_TASKS.md` shows de-monolithization is already an active effort — this list is the queue.

---

### I3. Duplicated polling implementations for the same data sources

**Location:** `src/hooks/use-sidebar-panel-data.ts` vs the panel components

| Data source | Sidebar twin | Panel |
|---|---|---|
| Process list | `useSidebarProcessList` (2s) | `process-list.tsx` (1s) |
| Connections health | `useSidebarConnections` (8s) | `connections-panel.tsx` (8s) |
| Kanban board | `useSidebarKanban` (10s) | `kanban-panel.tsx` |

Same sources, two code paths each, drifting cadences.

**Fix direction:** one data hook per source with a shared refresh signal; panels subscribe instead of re-implementing.

**Correction (2026-08-13):** this does not hold up. `process-list.tsx:41` is not
a second fetch chain — it is a 1s re-render tick so elapsed times stay live,
and the list itself is read synchronously from the in-memory
`getProcessRegistry()` on each render (`:46`). Connections poll at 8s on both
sides (`use-sidebar-panel-data.ts:117`, `connections-panel.tsx:11`), so there is
no cadence drift either. No action.

---

### I4. Unreferenced exports

| Export | Location | Status |
|---|---|---|
| `invalidateFileCache` | `src/file-search.ts:97` | Referenced only by a test |
| `computeWindow` | `height-cache.ts` | Test-only |
| `newToolAgg` / `addTool` | `fleet-chat-coalescer.ts` | Appear only as definitions |

Small cleanup — but `invalidateFileCache` also signals a real gap: nothing invalidates the 30s file index in production, so files created mid-session are invisible to `@`-search until the TTL expires.

---

### I5. Verified-clean markers (positive findings)

- **Zero** TODO/FIXME/HACK/XXX comments (all 23 grep matches are identifiers like `TODOS_CLEAR_DELAY_MS`, not markers).
- **Zero** `@ts-ignore` / `@ts-expect-error`.
- **Zero** stray `console.log` (6 hits, all in the intentional `terminal-silence.ts`).
- **13** `eslint-disable-next-line` comments, all with explanatory comments.
- **Zero** actual `any` types (only 2 comment-word matches).

---

## Verified clean (no action)

| Path | Why it's fine |
|---|---|
| `src/terminal-title.ts` | `unref()`'d timer, deduplicated OSC writes, full cleanup on stop |
| `src/hooks/use-mouse-tracking.ts` | Writes tracking sequences only on change; restores on unmount |
| `src/components/connections-panel.tsx` | 8s fetch only while panel is open; `cancelledRef` guarded; cleanup on unmount |
| `src/components/process-list.tsx` | 1s tick only while the F8 panel is open; cleaned up |
| `src/components/continue-confirm-panel.tsx` | Countdown runs off a ref (no re-render); interval cleared |
| `src/hooks/use-tui-environment-state.ts` | Breaker 1s interval only while armed; cleaned up |
| `src/hooks/use-sidebar-panel-data.ts` | All three polls gated by `enabled` (visibility); cleaned up |
| `src/hooks/use-token-counter-refresh.ts` | Event-driven (`token.accounted`), no polling |
| `src/highlight.ts` | Module-scope regexes (compiled once); per-line carry state |
| `src/components/scrollable-history.tsx` | Memoized; measured-window virtual scroll with underfill loop guard (`MAX_UNDERFILL_BUMPS`) |
| `src/hooks/use-chip-staleness-guard.ts` | Bounded recoveries (`maxRecoveries: 5`), lightweight fingerprint checks |
| `src/components/status-bar-chips.tsx` (`ThinkingChip`) | ~120ms color tick is isolated to the leaf and only mounted while thinking — the design comment is truthful |

---

## Assumptions / unverified

- Timings (git poll cost, per-keystroke scoring cost, re-render cost) are qualitative — no runtime profiling was run. `bench/` and `tests/heap-soak` exist if measured numbers are wanted.
- The statusbar `fs.stat` polls are documented as intentional tradeoffs in source comments; the visibility-gating suggestion changes behavior only when the corresponding chips are hidden.
- The 10s `nowTick` heap/CPU sampling is a deliberate diagnostic feature; this report questions its *cadence and scope*, not its existence.

---

## Suggested priority

| Priority | Item | Rationale |
|---|---|---|
| 1 | P2 + P3 — gate unconditional polling on visibility | Cheapest change, real process/disk I/O saved per session |
| 2 | I1 — wire or delete the history archive + stub | Dead code + a user-visible feature that silently does nothing |
| 3 | P1 — 10s tick scope/cadence | Persistent full-tree re-render + disk read every 10s |
| 4 | P5 — debounce `@`-search | Per-keystroke O(N) scan + dispatch churn |
| 5 | P4 — localize the 1s activity tick | Largest per-second render cost while working |
| 6 | I3 / I2 / I4 — dedupe polling, split hotspots, remove dead exports | Maintainability debt, already partially in flight |
