# Modularity Audit & Improvement Plan

**Labels**  
`refactor` `architecture` `tech-debt` `audit` `roadmap`

## Summary

A read-only audit of the WrongStack monorepo at `main = e0664b55` to assess
modularity, identify spaghetti patterns, and propose concrete module
boundaries and improvement steps. This document is **incremental to the
existing artifacts**:

- [`docs/architecture-rules.md`](../../architecture-rules.md) — 7-layer dependency rules
- [`docs/plans/architecture-refactor-plan.md`](../../plans/architecture-refactor-plan.md) — Phase 0–6 sequencing
- [`docs/backlog/2026-07-architecture-review/`](../2026-07-architecture-review/) — 17 backlog items

It does not duplicate them. It adds: fresh measurements, three new findings
not yet captured in those docs, and concrete file-layout proposals for the
remaining hotspots.

---

## 1. Methodology

Tools used (all read-only; no commits made during the audit):

1. **File-size scan** — `find … | wc -l` style walk over `packages/*` and
   `apps/*` for `*.ts / *.tsx / *.mts`, capped at ≥12 KB.
2. **Relative-import fan-in** — per-file count of `from './…'` and
   `from '../…'` to gauge intra-package coupling.
3. **Cross-package dependency matrix** — count of `from '@wrongstack/<pkg>'`
   occurrences per source/target package.
4. **Public-API surface count** — `export (async )?(function|const|...)`
   per file, to detect façade modules.
5. **Existing-plan audit** — read `architecture-rules.md`,
   `architecture-refactor-plan.md`, all 17 backlog files, and
   `hotspot-guardrails.test.ts` to verify which findings are already
   tracked and which are new.

All measurements were taken on the working tree as of this audit session.
The shared tree is currently clean per `leader@df2cfe72` (PR #238 merged).

---

## 2. State of the System — Measurements

### 2.1 Top files by line count (`.ts / .tsx / .mts`, ≥1000 lines)

| Lines | File | Notes |
|------:|------|-------|
| 7386 | `packages/tui/src/app.tsx` | TUI shell — **god component**, imports **52 components + 16 hooks** |
| 3208 | `packages/cli/src/cli-main.ts` | CLI orchestrator (down from 3492 via peer extractions: `cli-context.ts`, `session-event-wiring.ts`, `hq-telemetry.ts`, `dep-watcher.ts`, `director-setup.ts`, `lifecycle-plugins.ts`) |
| 2772 | `packages/core/src/kanban/manager.ts` | **Façade module** — 48 exported functions, 3 imports, 0 external `@wrongstack/*` imports |
| 2342 | `packages/tui/src/app-reducer.ts` | TUI state machine |
| 2202 | `packages/cli/src/hq-dashboard-html.ts` | HQ dashboard SPA (mostly generated HTML + React shell) |
| 2161 | `packages/tui/src/components/history/utils.tsx` | TUI history rendering |
| 2095 | `packages/core/src/coordination/director.ts` | Director engine |
| 2075 | `packages/webui/src/types.ts` | WebUI shared types |
| 1975 | `packages/cli/src/fleet/host.ts` | CLI fleet host bridge |
| 1909 | `packages/cli/src/hq-server.ts` | HQ HTTP/WS server |
| 1752 | `packages/core/src/coordination/director-tools.ts` | Director tool wrappers |
| 1662 | `packages/tui/src/components/status-bar.tsx` | TUI status bar |
| 1538 | `packages/core/src/kernel/events.ts` | Kernel event bus |
| 1534 | `packages/core/src/storage/session-store.ts` | Session store façade |
| 1508 | `packages/webui/src/components/SetupScreen.tsx` | WebUI setup flow |
| 1502 | `packages/tui/src/components/settings-picker.tsx` | TUI settings picker |

### 2.2 Intra-package relative-import fan-in

| File | Relative imports | Diagnosis |
|------|-----------------:|-----------|
| `tui/src/app.tsx` | **81** | Couples every TUI component + hook directly |
| `cli/src/cli-main.ts` | **38** | Multi-domain orchestrator |
| `core/src/coordination/director.ts` | **20** | Sibling-heavy coordination module |
| `tui/src/app-reducer.ts` | **9** | Cross-couples into `components/*` (notable: imports from `history`, `auth-panel-model`, `prompt-picker`, `send-mode-picker`, `settings-picker`) |
| `core/src/kanban/manager.ts` | **2** | Façade, not a tangle (see §3.2) |
| `cli/src/hq-server.ts` | **2** | Mostly external `@wrongstack/core` |

### 2.3 Cross-package dependency matrix (edge counts)

| From → To | core | cli | tui | webui | tools | runtime | providers | acp | mcp | plugins | plug-lsp |
|-----------|-----:|----:|----:|------:|------:|--------:|----------:|----:|----:|--------:|---------:|
| **core**     | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **cli**      | **517** | — | **4** | **10** | 15 | 8 | 14 | 10 | 7 | 0 | 0 |
| **tui**      | 62 | 0 | — | 0 | 7 | 3 | 0 | 0 | 0 | 0 | 0 |
| **webui**    | 132 | 0 | 0 | — | 9 | 3 | 7 | 0 | 4 | 0 | 0 |
| **webui-hq** | 21 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **tools**    | 119 | 0 | 0 | 0 | — | 0 | 0 | 0 | 0 | 0 | 0 |
| **providers**| 68 | 0 | 0 | 0 | 0 | — | 1 | 0 | 0 | 0 | 0 |
| **runtime**  | 20 | 0 | 0 | 0 | 0 | 0 | — | 0 | 0 | 0 | 0 |
| **telegram** | 21 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **acp**      | 12 | 0 | 0 | 0 | 0 | 0 | 0 | — | 0 | 0 | 0 |
| **mcp**      | 16 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — | 0 | 0 |
| **plugins**  | 68 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — | 0 |
| **plug-lsp** | 33 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |

**Key observations**:

- ✅ **No cycles** — the graph is a DAG. All packages depend only on `core`
  plus utility packages (`tools`, `runtime`, `providers`, `acp`, `mcp`,
  `plugins`). The `architecture-rules.md` test suite is doing its job.
- ⚠️ **CLI → TUI** (4 edges) and **CLI → WebUI** (10 edges) are unexpected:
  the CLI is supposed to depend only on `core` and bottom-of-stack utilities.
  See §3.1.
- ⚠️ `providers → providers` self-loop (1 edge) is presumably an internal
  barrel re-export — should be confirmed.

---

## 3. New Findings (beyond existing backlog)

These three issues are **not** explicitly captured in
`architecture-rules.md`, `architecture-refactor-plan.md`, or any of the 17
backlog files.

### 3.1 Cross-surface utility leak — CLI imports TUI/WebUI internals

`grep "from '@wrongstack/(tui|webui)" packages/cli/src` shows **13
violations** of the package-boundary spirit:

| Source | Imported symbol | From | Diagnosis |
|--------|----------------|------|-----------|
| `cli/src/repl.ts:28` | `parseNextSteps` | `@wrongstack/tui` | Generic markdown parser |
| `cli/src/auth-menu/panel-service.ts:31` | `AuthPanelHost` and 3 others | `@wrongstack/tui` | UI model imported by CLI auth menu |
| `cli/src/slash-commands/suggest.ts:6` | `parseNextSteps` | `@wrongstack/tui` | Same parser, second consumer |
| `cli/src/webui-server.ts:93` | 5 symbols | `@wrongstack/webui/server` | WebUI server protocol reused by CLI bridge |
| `cli/src/webui-server/connection-handler.ts:21-22` | `verifyClient` × 2 | `@wrongstack/webui/server` | Auth reused across surfaces |
| `cli/src/webui-server/context-breakdown.ts:44` | context types | `@wrongstack/webui/server` | Token-budget logic |
| `cli/src/webui-server/lifecycle.ts:8` | lifecycle helpers | `@wrongstack/webui/server` | Bridge setup |
| `cli/src/webui-server/message-router.ts:29,74` | message router | `@wrongstack/webui/server` | WS message routing |
| `cli/src/webui-server/setup-events.ts:15` | `createEternalSubscription` | `@wrongstack/webui/server` | Subscription bridge |
| `cli/src/webui-server/static-serve.ts:4` | `createHttpServer` | `@wrongstack/webui/server` | HTTP factory |
| `cli/src/webui-server/ws-handlers/context.ts:8` | `CustomModeStore` (type) | `@wrongstack/webui/server` | Type-only — acceptable |

**Diagnosis**: `parseNextSteps` is a markdown parser that has nothing to do
with TUI rendering. It belongs in `@wrongstack/core` (as a utility) or
`@wrongstack/tools/markdown`. Similarly, `@wrongstack/webui/server` is a
**server-side module** (HTTP, WS, types) that the CLI happens to reuse —
but its home in a "webui" package is misleading; a separate
`@wrongstack/server-protocol` package, or moving it under
`@wrongstack/core/server`, would be more honest.

**Proposed module boundaries**:

- Move `parseNextSteps` from `packages/tui/src/...` to
  `packages/tools/src/next-steps.ts` (a new subpath alongside
  `tool-summary`, `tool-diff`, `tool-icons`). Wire TUI to re-export it
  for backwards compatibility, then delete the re-export after one
  release. **Effort: 1 PR, half-day.**
- Extract `@wrongstack/webui/server` into a new
  `@wrongstack/server-bridge` package (or `@wrongstack/core/server`),
  rename the file to reflect its real role, and update 10 CLI importers
  plus any WebUI consumers. **Effort: 2 PRs, ~2 days.**

### 3.2 Façade module pattern — `core/kanban/manager.ts`

`packages/core/src/kanban/manager.ts` is **2772 lines, 48 exported
functions, 3 import statements**. It is a near-pure façade: every public
function delegates to `storage.ts` helpers (`writeBoard`, `mutateBoard`,
`readBoard`, …) with trivial validation/normalization. There is no
business logic; the file is a giant **typed call-forwarder**.

**Why this matters**:

- New contributors cannot tell which functions belong together.
- Touching `storage.ts` requires editing `manager.ts` in 48 places.
- `architecture-rules.md` would never flag this as a coupling problem
  (it has only 2 relative imports), so the size cap alone doesn't fix
  the discoverability problem.

**Proposed module boundaries**:

Convert `kanban/manager.ts` into a directory `kanban/manager/` with
focused submodules, re-exported from `kanban/manager/index.ts` so the
public API stays stable:

```
packages/core/src/kanban/
├── manager/
│   ├── index.ts              # re-export everything for back-compat
│   ├── boards.ts             # createBoard, listBoards, getBoard, updateBoard,
│   │                         # removeBoard, duplicateBoard (~250 lines)
│   ├── tasks.ts              # addTask, updateTask, moveTask, claimTask,
│   │                         # completeTask, splitTask, mergeTasks (~400 lines)
│   ├── assignment.ts         # assignTask, heartbeat, recoverStale,
│   │                         # releaseClaim, queueHealth (~350 lines)
│   ├── metrics.ts            # addGoalMetric, updateGoalMetric, check status (~250 lines)
│   ├── notes-and-links.ts    # addNote, addLink, updateNote (~200 lines)
│   ├── columns.ts            # addColumn, updateColumn, removeColumn (~200 lines)
│   └── helpers.ts            # normalizeColumns, cloneTaskForBoard, etc.
├── storage.ts                # unchanged
└── types.ts                  # unchanged
```

Acceptance: total line count per file ≤ 500; manager/index.ts ≤ 50 lines
(barrel only); public API of `@wrongstack/core/kanban` unchanged; existing
188 tests stay green.

**Effort**: 1 PR, 1–2 days. The work is mechanical (group by exported
function, move into the right file, fix imports). Lower risk than app.tsx
work because there is no React/Ink coupling.

### 3.3 TUI god-component — `app.tsx` imports 52 components + 16 hooks

`packages/tui/src/app.tsx` (7386 lines) imports **52 components** from
`./components/*` and **16 hooks** from `./hooks/*` directly. It is
simultaneously:

- the React/Ink render root
- the keyboard/event-bridge host
- the controller host
- the feature router
- the panel state machine

Backlog item `001-tui-app-split.md` already tracks this (in progress,
with progress notes showing 8 hook extractions completed). This audit
adds: **the file still has 52 component imports; hook-only extraction
will plateau at ~5500 lines.** To get below the **<1500 lines** acceptance
criterion in item 001, the work must move to **feature-scoped layout
modules**, not just hook extraction.

**Proposed module boundaries** (incremental to item 001):

```
packages/tui/src/
├── app.tsx                   # shell only: <Box>…</Box> with route picker
│                             # target: ≤800 lines
├── app-bootstrap.ts          # createTuiApp(opts) → RootTuiState (~250 lines)
├── app-routes.tsx            # route → <Panel> map (~150 lines)
├── panels/                   # NEW — feature-scoped panel groups
│   ├── session/              # history, status-bar, input, queue, scratchpad
│   │   ├── index.tsx
│   │   ├── history.tsx       # (moved from components/history.tsx)
│   │   └── use-session.ts    # session-scoped hooks consolidated
│   ├── overlay/              # pickers, modals, help overlay, confirm panels
│   │   ├── index.tsx
│   │   └── pickers.tsx
│   ├── fleet/                # fleet-monitor, fleet-panel, agents-monitor, brain-panel
│   ├── settings/             # settings-picker, statusline-picker, mode-picker, autonomy-picker
│   ├── kanban/               # kanban-panel
│   └── director/             # phase-panel, plan-panel, coordinator-panel
├── controllers/              # NEW — controller factories (panel open/close,
│                             # input focus, routing decisions)
│   ├── panel-controller.ts
│   └── route-controller.ts
├── components/               # KEEP only the truly atomic, reusable primitives:
│   ├── input.tsx             # generic text input
│   ├── key-hint-bar.tsx
│   ├── scrollable-history.tsx
│   ├── shell-command-warning.tsx
│   ├── esc-confirm-prompt.tsx
│   └── suggestions.ts
├── hooks/                    # cross-cutting hooks (use-queue-manager, use-paste-handling,
│                             # use-file-search, etc.) — unchanged
└── app-reducer.ts            # tracked by item 002 — split into composed sub-reducers
```

The key idea: **panels/ owns the feature-scoped orchestration**, while
**components/ holds the genuine reusable primitives**. After this split,
`app.tsx` becomes a routing shell, not a feature orchestrator.

**Effort**: 4–6 PRs, 2–3 weeks. Each panel group can be extracted
independently. Hot-reload of the TUI is the fastest feedback mechanism
in the codebase — use it as the regression harness.

---

## 4. Updated Module Boundaries — Worst Hotspots

For each remaining hotspot, the table below gives a **target final state**
(line counts are goals, not hard caps). Where an existing backlog item
already tracks the work, the item ID is noted.

| Hotspot | Current | Target | Backlog | New PR proposal |
|---------|--------:|-------:|:-------:|-----------------|
| `tui/app.tsx` | 7386 | ≤1500 | 001 (in progress) | See §3.3 — feature panels |
| `tui/app-reducer.ts` | 2342 | ≤600 | 002 (pending) | Composed sub-reducers + actions-by-domain |
| `tui/components/history/utils.tsx` | 2161 | ≤800 | (none) | Split: parser / renderer / virtualization |
| `cli/cli-main.ts` | 3208 | ≤800 | 003 (pending) | Continue wiring/* extractions (4 of 8 already landed per peer) |
| `cli/hq-dashboard-html.ts` | 2202 | ≤1200 | (none) | Extract template + browser-source-string constants to `hq-dashboard/template.ts` and `hq-dashboard/browser-src/` |
| `cli/fleet/host.ts` | 1975 | ≤1000 | (none) | Extract supervisor, registry, and broadcast concerns into `fleet/host/*` |
| `cli/hq-server.ts` | 1909 | ≤1200 | (none) | Split HTTP routes from WS handlers from auth middleware (webui-server/ already shows the pattern) |
| `cli/repl.ts` | 1477 | ≤1000 | (none) | Extract history rendering + key handling |
| `core/kanban/manager.ts` | 2772 | split into 8 ≤500-line files | (none) | See §3.2 — façade decomposition |
| `core/coordination/director.ts` | 2095 | ≤1200 | 004 (pending) | Split: construction / session / prompts / tools |
| `core/coordination/director-tools.ts` | 1752 | ≤1000 | (004 indirectly) | Split per tool family (fleet, mailbox, subagent) |
| `core/kernel/events.ts` | 1538 | ≤1000 | (none) | Extract event-type registry, leave core emitter |
| `core/storage/session-store.ts` | 1534 | split into ≤5 ≤500-line files | (none) | Split: reader / writer / analyzer / recovery |
| `webui/types.ts` | 2075 | split per domain | (none) | Split: session.ts / kanban.ts / fleet.ts / settings.ts (already-pattern-following — see `packages/tools/src/tool-summary.ts`) |
| `webui/components/OfficeMapCanvas.tsx` | 1939 | ≤1200 | (none) | Split renderer / hit-test / animation (see `packages/tui/src/hit-test.ts` for precedent) |
| `webui/components/SetupScreen.tsx` | 1508 | ≤900 | (none) | One file per onboarding step |
| `webui/components/SettingsPanel/index.tsx` | 1434 | ≤800 | (none) | One file per settings section |

---

## 5. Architectural Decisions — Proposed

These are **decisions to record as ADRs**, not open-ended proposals.

### Decision A — Adopt "feature-panel" pattern in `@wrongstack/tui`

The TUI's current `components/` directory mixes reusable primitives with
feature panels. As the TUI has grown, the convention has blurred. The
**decision** is to formalize the distinction:

- `components/` — primitives reusable across multiple panels
- `panels/` (NEW) — feature-scoped orchestration

This unblocks the goal in item 001 to get `app.tsx ≤ 1500 lines`.

### Decision B — Move `@wrongstack/webui/server` to a neutral home

The 10 CLI → `@wrongstack/webui/server` edges are evidence that the
current location is wrong. The module is server-side infrastructure
shared between CLI and WebUI surfaces. **Decision**: rename and move to
either `@wrongstack/core/server` (preferred — keeps `core` as the
neutral foundation per `architecture-rules.md`) or a new
`@wrongstack/server-bridge` package.

### Decision C — Promote `parseNextSteps` from `@wrongstack/tui` to `@wrongstack/tools`

`parseNextSteps` is a generic markdown-block parser with no TUI
dependency. It has two CLI consumers. **Decision**: move it to
`packages/tools/src/next-steps.ts`, mirroring the proven
`tool-summary` / `tool-diff` / `tool-icons` extraction pattern that
already shipped in PRs #236/#237/#238.

### Decision D — Convert hotspot guardrails from advisory to ratcheting

Item `007-hotspot-guardrails-ratcheting.md` already proposes this. The
audit confirms it: the current `hotspot-guardrails.test.ts` (206 lines,
2 sections) is **advisory** — caps line counts but does not shrink
them. **Decision**: convert to a ratchet — each PR touching a hotspot
must include a `+N / -M` line delta toward the target in §4, enforced
by the test. Backlog items 012 (architecture health reporting) and 014
(drift detection) become the dashboard surface for this ratchet.

### Decision E — Façade-module size cap (NEW)

The current hotspot caps target single-file line counts only. The
**façade pattern** identified in §3.2 would slip past a per-file cap.
**Decision**: add a rule to `hotspot-guardrails.test.ts` — "a file with
≥30 exported functions must be split into a directory of focused
modules under `<filename>/` with a barrel `index.ts`." This catches
manager.ts-style sprawl automatically.

### Decision F — `@wrongstack/skills` placeholder resolution

Mentioned in `architecture-refactor-plan.md` as PR-B3, not yet
resolved. **Decision**: remove the placeholder package; skills live
entirely in `@wrongstack/core/skills/` and `@wrongstack/tools/` (the
latter already hosts `tool-summary`, `tool-diff`, `tool-icons`,
`tool-icons`, `kanban.ts`, etc.). 1 PR, half-day.

---

## 6. Concrete Improvement Steps — Sequenced

This sequence folds into the existing wave plan in
`architecture-refactor-plan.md` and the backlog dependency map in
`README.md`. Items are ordered by **dependency, not priority** — earlier
items unblock later ones.

### Wave 0 — Safety nets (existing items)

- [ ] **Item 005** — Strengthen TUI integration coverage beyond mount/no-crash
- [ ] **Item 006** — Expand CLI boot/dispatch integration tests
- [ ] **Item 007** — Convert hotspot guardrails to ratcheting (Decision D)
- [ ] **Item 008** — Refresh architecture hotspot docs and line-count references

### Wave 1 — Quick wins from this audit

- [ ] **NEW — PR-018a** — Promote `parseNextSteps` to `@wrongstack/tools/next-steps` (Decision C)
- [ ] **NEW — PR-018b** — Decide and execute `@wrongstack/webui/server` → `@wrongstack/core/server` move (Decision B; opens the door to two CLI files dropping a cross-package dep)
- [ ] **NEW — PR-018c** — Resolve `@wrongstack/skills` placeholder (Decision F; trivial removal)
- [ ] **Item 003** — Continue `cli-main.ts` decomposition (4 of 8 wiring/ modules already extracted)

### Wave 2 — Big hotspot reductions

- [ ] **Item 001** — Split `tui/app.tsx` to ≤1500 lines (in progress; needs the panels/ decision from §3.3)
- [ ] **Item 002** — Split `tui/app-reducer.ts` into composed sub-reducers
- [ ] **Item 004** — Split `core/coordination/director.ts` by responsibility
- [ ] **NEW — PR-018d** — Decompose `core/kanban/manager.ts` into `manager/{boards,tasks,assignment,…}.ts` (§3.2)

### Wave 3 — Boundary cleanup

- [ ] **Item 009** — Move shared logic out of `cli/src/slash-commands/` into service modules (already partly tracked by hotspot-guardrails allowlist)
- [ ] **Item 010** — Make `@wrongstack/runtime` a real package boundary
- [ ] **Item 011** — Reduce `@wrongstack/core` top-level export sprawl

### Wave 4 — Cross-surface consolidation

- [ ] **Item 015** — Unify shared app-service flows across CLI, TUI, and WebUI
- [ ] **NEW — PR-018e** — Add façade-module rule to hotspot-guardrails (Decision E)

### Wave 5 — Visibility & governance

- [ ] **Item 012** — Architecture health reporting (becomes the dashboard for Decision D's ratchet)
- [ ] **Item 014** — Automated drift detection
- [ ] **Item 016** — Temporary architecture exceptions policy
- [ ] **Item 017** — Package-boundary visualization

---

## 7. Coordination Risks

Two coordination issues were surfaced by peer mailbox traffic during
this audit. They are NOT modularity problems per se, but they block
other modularity work.

1. **`packages/cli/src/hq-server.ts` and `packages/cli/tests/hq-server.test.ts`
   have uncommitted leftover hunks** (per `leader@e839d31a`). Until the
   owner reconciles these, `git checkout main` is blocked for everyone.
   Action: ping the owner directly via mailbox, or open a follow-up PR
   to commit their diff verbatim. **Without this resolved, item 003
   (cli-main.ts decomposition) cannot cleanly rebase on top of
   `main`.**

2. **The cli-main.ts extractions in flight** (PR #241 by `leader@31f96da6`)
   already reduced cli-main by 1008 lines and extracted 4 wiring/
   modules. Item 003 in this audit aligns with the remaining 4
   extractions planned. **Coordinate via mailbox before re-extracting
   wiring modules already in their PR.**

---

## 8. Reusability Potential — Quick Wins

Three pieces of "shared logic hiding in one surface" can be extracted
following the proven pattern from PRs #236/#237/#238 (tool-summary,
tool-diff, tool-icons consolidated into `@wrongstack/tools` with parity
tests):

1. **`parseNextSteps`** — extract to `@wrongstack/tools/next-steps`
   (already covered by §3.1, Decision C).
2. **HQ chat-history tool icons + input summary** — already consolidated
   by `leader@df2cfe72` in PR #238. No further action needed.
3. **`session-store.ts` reader/writer split** — `packages/core/src/storage/session-store.ts`
   has both the read API (`readSession`, `listSessions`) and the write
   API (`appendEvent`, `finalizeSession`). Splitting them would let the
   TUI's history loader depend only on the reader (which it already
   does indirectly) and shrink the public surface that `@wrongstack/cli`
   and `@wrongstack/webui` import. 1 PR, ~1 day.

---

## 9. Acceptance Criteria for This Audit Document

This audit is considered successfully **actionable** when:

- [ ] At least 3 of the 5 decisions in §5 have ADRs filed
  (`docs/adr/adr-00N-*.md`).
- [ ] The façade-module rule from Decision E is added to
  `hotspot-guardrails.test.ts` and is green against the current tree
  (no existing files violate it — `kanban/manager.ts` is the only one
  above the threshold, and it is in Wave 2 work).
- [ ] PR-018a (`parseNextSteps` move) is opened and merged.
- [ ] The cli-main.ts decomposition count is updated: **target 5 of 8
  wiring modules extracted by end of Wave 1** (peer leaders have done
  4 already; one more completes Wave 1).
- [ ] Coordination risk #1 (uncommitted hq-server.ts hunks) is resolved
  via mailbox or follow-up PR.

---

## 10. Effort Summary

| Wave | Items | Estimated PR count | Estimated effort |
|------|-------|-------------------:|-----------------:|
| 0 — Safety nets | 4 (existing) | 4 | 1 week |
| 1 — Quick wins | 3 new + 1 existing | 4 | 1 week |
| 2 — Big hotspots | 3 existing + 1 new | 4 | 3 weeks |
| 3 — Boundaries | 3 (existing) | 3 | 2 weeks |
| 4 — Consolidation | 1 existing + 1 new | 2 | 1 week |
| 5 — Governance | 4 (existing) | 4 | 2 weeks |
| **Total** | **18 (3 new, 15 existing)** | **21 PRs** | **~10 weeks** |

This is a 2.5-month program with explicit PR-sized slices. None of the
PRs require behavior change. The peer-leader extraction pattern already
in motion (4 wiring/ modules extracted this session) is the proof of
cadence.

---

## 11. Cross-References

- Architecture rules: [`docs/architecture-rules.md`](../../architecture-rules.md)
- Master plan: [`docs/plans/architecture-refactor-plan.md`](../../plans/architecture-refactor-plan.md)
- Backlog with wave dependency map: [`docs/backlog/2026-07-architecture-review/README.md`](../2026-07-architecture-review/README.md)
- Existing hotspot guardrail: `packages/core/tests/architecture/hotspot-guardrails.test.ts`
- Existing boundary test: `packages/core/tests/architecture/package-boundaries.test.ts`
- ADRs: [`docs/adr/`](../../adr/) — use `adr-template.md` (or `template_use` action)
- Proven extraction pattern: PRs #236, #237, #238 (tool-summary / tool-diff / tool-icons into `@wrongstack/tools`)