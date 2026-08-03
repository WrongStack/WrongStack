# Workspace Test Coverage Report — 2026-07-25

> **Generated:** 2026-07-25 · **Tool:** Vitest v8 coverage (per-package, sharded)
> · **Scope:** 13 of 14 workspace packages measured, **`webui` included**.
>
> This report was produced by sharded per-package coverage runs (the full
> workspace exceeds a single run's time budget on this machine). See
> **Methodology & caveats** before drawing hard conclusions.
>
> **Related reports:**
> - `docs/coverage-report.md` — whole-workspace summary (2026-07-17).
> - `docs/reports/test-coverage-gaps-2026-07-24.md` — detailed non-WebUI gap
>   report with 273 per-file sections (2026-07-24). More granular for
>   backend/core packages; **excludes** `webui`/`simpleui`.
> - **This report** adds a `webui`-inclusive lowest-15 ranking and 13-package
>   rollup, complementing the 07-24 gap report which excluded the UI packages.

## Headline

The low-coverage problem is concentrated in the **UI / server surface**:
`webui` (41.5%), `webui-server` (47.8%), and `cli` (55.7%). The single largest
cluster of completely-untested code is **large `webui` React components** —
`AgentRosterView`, `SetupScreen`, `OfficeMapCanvas`, `ChatView`, `App.tsx` —
which have **no unit tests at all**. (Note: the 2026-07-24 gap report excluded
`webui` by request, so this UI concentration is newly surfaced here.)

- **1,296** source files measured
- **1,208** rankable (files with executable lines)
- **145** files at **0%** line coverage

## 15 lowest-coverage files (by line coverage)

| # | Line cov | Uncovered / Total | File |
|---|----------|-------------------|------|
| 1 | 0% | 397 / 397 | `packages/webui/src/components/AgentRosterView.tsx` |
| 2 | 0% | 327 / 327 | `packages/webui/src/components/SetupScreen.tsx` |
| 3 | 0% | 311 / 311 | `packages/webui/src/components/OfficeMapCanvas.tsx` |
| 4 | 0% | 256 / 256 | `packages/webui/src/components/SkillDetailView.tsx` |
| 5 | 0% | 220 / 220 | `packages/webui/src/components/SidePanel/SkillsList.tsx` |
| 6 | 0% | 219 / 219 | `packages/webui/src/components/AgentOfficeView.tsx` |
| 7 | 0% | 218 / 218 | `packages/cli/src/wiring/fleet-command-handlers.ts` |
| 8 | 0% | 217 / 217 | `packages/webui-server/src/server/memory-handlers.ts` |
| 9 | 0% | 215 / 215 | `packages/webui/src/components/ChatView/index.tsx` |
| 10 | 0% | 213 / 213 | `packages/webui-server/src/server/start-webui.ts` |
| 11 | 0% | 185 / 185 | `packages/webui/src/components/TechStackView/index.tsx` |
| 12 | 0% | 172 / 172 | `packages/webui/src/hooks/useDesktopBridge.ts` |
| 13 | 0% | 172 / 172 | `packages/webui/src/hooks/useGlobalKeyboardShortcuts.ts` |
| 14 | 0% | 168 / 168 | `packages/webui/src/components/TerminalPanel.tsx` |
| 15 | 0% | 163 / 163 | `packages/webui/src/App.tsx` |

All 15 are **0% covered**; 10 of 15 are `webui` UI components.

## Per-package line coverage (13 packages)

| Package | Files | Line cov | Lines |
|---------|-------|----------|-------|
| webui | 327 | **41.54%** | 18,988 |
| webui-server | 143 | **47.76%** | 9,206 |
| cli | 315 | **55.73%** | 24,233 |
| tui | 217 | **64.36%** | 14,990 |
| techstack | 45 | 84.51% | 2,344 |
| plugins | 77 | 92.75% | 8,639 |
| acp | 29 | 95.70% | 2,231 |
| sage | 23 | 99.52% | 2,290 |
| telegram | 18 | 99.65% | 862 |
| mcp | 22 | 99.96% | 2,407 |
| plug-lsp | 39 | 100% | 1,076 |
| sdd | 27 | 100% | 2,202 |
| security-scanner | 14 | 100% | 795 |

## Methodology & caveats

- **Sharded measurement.** The four heavy packages could not be
  coverage-instrumented in a single run within the tool time budget
  (`cli` 262 test files, `tui` 239, `webui` 225, plus heavy `mcp` soak tests).
  Each was split into test-file batches; each batch ran v8 coverage
  independently; results were merged by **max-coverage-per-file** across
  batches.
- **Implication for aggregates.** A file's merged coverage is the best any
  single batch achieved. Because no single batch runs *all* of a package's
  tests together, coverage that would come from tests in different batches is
  not combined — so **package aggregates may slightly _understate_ true
  coverage** vs. a single all-tests-at-once run. **The 0%-coverage findings
  are definitive** (a 0% file is untouched by every batch).
- **`webui-server` measured 47.76% here** vs. 30.87% in an earlier run that
  used the root Vitest config; this run used broader test discovery. Treat
  47.76% as the better figure, but note the measurement path differed.
- **13 packages, not 14.** `mcp`'s two soak suites
  (`http-fault-soak`, `stdio-fault-soak`) were excluded — they are
  load/fault-injection tests that add no source coverage (`mcp` is already
  99.96%). No package is entirely absent from the report.

## How to reproduce authoritative numbers

For a single, non-sharded, authoritative pass (run in a real terminal where
Node is on PATH — this exceeds the agent tool timeout):

```
pnpm test:coverage
```

This runs `scripts/test-coverage.mjs` (Node packages + LSP per-file gate +
WebUI) and writes coverage output that can be re-ranked with the same
max-per-file logic used here.
