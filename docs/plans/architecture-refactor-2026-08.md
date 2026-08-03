# Architecture Refactor Plan — 2026-08 (ADR-003 successor cycle)

| Field | Value |
|---|---|
| **Date** | 2026-07-31 |
| **Status** | Draft for review |
| **Evidence baseline** | Fresh `scripts/check-architecture-health.mjs --json` run on 2026-07-31T22:33Z (committed report is stale: 2026-07-23) |
| **Predecessor** | [`adr-003-authority-first-refactor-program.md`](adr-003-authority-first-refactor-program.md) — **substantially complete**; this plan is the next cycle, not a re-run |
| **Active concurrent work** | [`hq-evolution-2026-08.md`](../plans/hq-evolution-2026-08.md) (workstreams A–D; the resume.ts protocol cycle below originated there) |

---

## 1. Executive summary

WrongStack is healthy at the package level (acyclic workspace DAG, 0 package cycles,
full test-type ownership, enforced hotspot ratchets) but **the architecture gate is
currently red** and the system grew ~29% in source files and ~14% in lines in the
eight days since the last committed health report. The ADR-003 program (verification
truth, trust boundaries, protocol/backend authority, metadata registries, behavioral
hotspot decomposition, Core/Runtime ownership) is effectively complete: **all waves
are `done`** in `architecture-refactor-task-graph-2026-07.md` (R5 chose the kill branch;
R7 folded the Runtime facade; R8 retired in-repo compatibility imports, 0 Core-root
imports remain).

The next cycle should therefore be **narrow and defensive**, not another strangler
program:

1. **Fix the red gate** (1 unexcepted type cycle + 1 stale exception).
2. **Resolve, not re-except, the 3 new runtime cycles** (exceptions expire 2026-09-15).
3. **Continue hotspot decomposition** on the ~120 tracked files, prioritizing the
   files that *grew* and the god-file clusters that still mix responsibilities.
4. **Close small hygiene/RAM follow-ups** left open by the 2026-07-31 RAM-leak audit.
5. **Hold the ADR-004 next-major line** (published Core root removal is an external
   release gate, not repository work).

**Verdict: refactor needed — yes, but scoped.** No rewrite, no new authority packages,
no large-scale movement. The codebase's own governance machinery (ratchets, exceptions,
health generator) is working; the plan leans on it.

---

## 2. Fresh baseline (2026-07-31 vs committed 2026-07-23)

| Measure | 2026-07-23 (committed) | 2026-07-31 (fresh) | Δ |
|---|---:|---:|---:|
| Workspace packages | 24 | **28** | +4 (codebase-index-mcp, kanban-mcp, mailbox-mcp, sage-mcp) |
| Production source files | 2,120 | **2,741** | +621 (+29%) |
| Production source lines | 564,516 | **642,694** | +78,178 (+14%) |
| Test files | 1,818 | **2,292** | +474 |
| Workspace edges | 72 | **85** | +13 |
| Relative module edges | 6,304 | **8,134** | +1,830 |
| Package cycles | 0 | **0** | ✅ |
| Runtime module cycles | 0 | **3** | ⚠️ new (excepted 07-30) |
| Type-inclusive cycles | 15 | **17** | +2 (both mirror runtime cycles) |
| Hotspots ≥ 800 lines | ~105 | **120** | +15 |
| Tests w/o typecheck project | 0 | **0** | ✅ |

**Current gate errors** (from the fresh run, `errors` array):

```
1 unexcepted module cycle(s)
ARCH-CYCLE-TYPE-13: exception no longer matches an active cycle
```

⇒ `pnpm check:architecture` exits non-zero today.

---

## 3. Findings (prioritized, with evidence)

### F1 — CRITICAL: architecture gate red — HQ protocol type cycle widened, exception stale

- **Cycle members now:** `packages/core/src/hq/protocol/{client,core,fleet,resume,session}.ts`
- **Exception `ARCH-CYCLE-TYPE-13` lists only** `{client,core,fleet,session}` → stale; the
  cycle **gained `resume.ts`** and is therefore unexcepted → gate red.
- **Verified on disk:** `resume.ts:17` imports `HqEventEnvelope` from `./core.js`;
  `core.ts` imports `HqResumeMessage` from `./resume.js` (and `browser.ts:3` imports
  from `./resume.js`). Type-level mutual dependency.
- **Origin:** HQ Evolution workstream A1 (rehydrate protocol types) — coordinate with
  that workstream; do not fix in a vacuum.
- **Cost of ignoring:** every `release:check` and CI architecture run fails; any new
  work on the HQ protocol is blocked.

### F2 — HIGH: three new runtime module cycles (exceptions expire 2026-09-15)

All three are excepted (`ARCH-CYCLE-RUNTIME-01/02/03`, introduced 2026-07-30, `reviewBy`
2026-09-15). They are **regressions from the long-standing 0-runtime-cycle baseline**
and must be resolved, not re-excepted:

1. `packages/core/src/core/context.ts ↔ conversation-state.ts` — the 07-30 exception
   itself says conversation-state re-exports a Context invariant from context.ts.
   (R1 canonical task.)
2. `packages/kanban/src/manager/_internal.ts ↔ manager/lifecycle.ts ↔ server/remote-storage.ts ↔ storage.ts`
   — bidirectional IPC/storage/lifecycle imports (K1 canonical task).
3. `packages/tools/src/builtin.ts ↔ codebase-index/{dead-code-scan,index}.ts ↔ index.ts ↔ pack.ts ↔ tool-tier.ts`
   — barrel re-export chain (G1 canonical task). **Cheapest of the three:** tool-tier's
   pack dependency can likely be inverted or de-duplicated.

Each also has a mirror type-level cycle (`TYPE-27`, `TYPE-28`; and `TYPE-26` for
kanban types facade), so one structural fix per package clears two exceptions.

### F3 — HIGH: hotspot growth velocity; biggest files grew again

120 tracked files ≥ 800 lines (same threshold as `architecture/hotspots.json`). Top of
the current list (fresh line counts):

| Lines | File | Note |
|---:|---|---|
| 1,356 | `packages/simpleui/src/simple-ui-session.tsx` | ratcheted at 925 on 07-21, **grew +431**; imports ~50 modules; mixes session state, handlers, chrome, prefs |
| 1,247 | `packages/sage/src/middleware/tool-call-memory.ts` | injection middleware + scoring + formatting in one file |
| 1,207 | `packages/tui/src/memory-slash.ts` | slash command with ~1,200 lines of logic |
| 1,185 | `packages/tools/src/codebase-index/writer.ts` | index writer |
| 1,150 | `packages/core/src/storage/file-session-writer.ts` | session writer |
| 1,148 | `packages/webui/src/components/ChatInput.tsx` | composer |
| 1,141 | `packages/tui/src/components/status-bar.tsx` | status bar + chips (recent feature work) |
| 1,129 | `packages/webui/src/lib/ws-client.ts` | WS client |
| 1,114 | `packages/cli/src/hq-server/ws.ts` | HQ WS handler |
| 1,111 | `packages/cli/src/slash-commands/memory.ts` | slash command |
| 1,109 | `packages/cli/src/cli-main.ts` | root is orchestration-only (C3 done) but still 1,109 |
| 1,089 | `packages/webui/src/components/SettingsPanel/index.tsx` | settings panel |

**Good news (verify-before-planning):** the July monsters are gone — `sage/src/store.ts`
(3,793) deleted, `webui/src/types.ts` (3,313) is now a 13-line barrel,
`KanbanView.tsx` (2,549) is 530, TUI `app.tsx` (7,672 → 1,033), CLI embedded-server
tree hit its <1,000-line gate. So decomposition works; the plan extends it.

### F4 — MEDIUM: remaining god-file clusters (behavioral seams, not line counts)

- **CLI slash-commands** (`memory.ts` 1,111, `settings.ts` 1,087, `sdd.ts` 1,015,
  `brain.ts` 957, `kanban.ts` 853): C2 extracted *services*, but these five commands
  still hold large inline behavior. Extract per-command service modules (same pattern
  as C2).
- **TUI status bar** (`status-bar.tsx` 1,141 + `status-bar-chips.tsx`): recent
  feature work (statusline density, version chip) landed here; re-extract chips/rails.
- **WebUI** `ws-client.ts` (1,129) + `session-handlers.ts` (1,044) + `ChatInput.tsx`
  (1,148) + `SettingsPanel/index.tsx` (1,089): four of the six largest WebUI files.
- **Sage** `tool-call-memory.ts` (1,247): split injection pipeline from scoring/format.

### F5 — MEDIUM: open RAM-leak-audit follow-ups (all small, all verified open)

From `docs/archive/reports/dated-reports/ram-leak-audit-2026-07-31.md` "Recommended improvements":
1. Surface the `InMemoryMetricsSink` dropped-observations counter in
   `packages/cli/src/wiring/metrics.ts` (`/metrics` scrape).
2. Add default `maxSeriesPerMetric` (e.g. 1000) to the sink wiring.
3. Add unmount-cancel `useEffect` around `fetchStats` in
   `packages/webui/src/components/AnalyticsDashboard.tsx`.
4. Resolve `TS2454` in `packages/core/src/coordination/remote-mailbox.ts`
   (mailbox snapshot coalescing; peer-modified file).
Plus documented-not-fixed Low items (worktree handles, mcp registry retention,
background-indexer listeners, browser managers) — revisit only with a concrete
growth profile.

### F6 — LOW: SAGE config/docs drift

`packages/core/src/types/config/mcp-features.ts` `SageConfig.inject.triggers` still
lists `bash` (and comments say read/tree/grep/bash/edit), but
`packages/sage/src/middleware/tool-call-memory.ts` `extractTrigger` excludes `bash`
and `exec` by design (tests assert this). Update the config type/docs to remove
`bash` or mark it legacy/no-op. (Known memory `01KYJMWG1CTPQ4XEZG7DT4ATBS`.)

### F7 — LOW: governance residue

- **Director long-term target:** D3 reduced `director.ts` 2,178 → 1,705 scanner lines
  (21.7%) but the <1,200-line target and persistence/admission extraction remain
  explicit ratchets (historical item 004 `partial`).
- **Package-boundary visualization:** historical item 017 `pending`; G1's generator
  could emit a dependency graph view (mermaid) at `pnpm report:architecture`.
- **ADR-004 next-major:** published `@wrongstack/core` root removal is an external
  release gate; needs a maintainer decision, not code.

---

## 4. Prioritized plan

Execution rules inherited from ADR-003: verification precedes movement; every task has
an owner, exit gate, and rollback; update `architecture/exceptions.json` and
`architecture/hotspots.json` **only** with reviewed evidence in the same PR; parallel
agents coordinate file ownership on shared composition roots.

### Wave 0 — Unblock the gate (P0, ~1–2 days) → task `A1`

| Task | Action | Exit gate |
|---|---|---|
| A1.1 | Break or review-except the HQ protocol type cycle. **Preferred structural fix:** move `HqEventEnvelope` (and the shared envelope primitives) to a dependency-leaf module (e.g. `hq/protocol/envelope.ts`) that `core.ts`, `resume.ts`, `browser.ts` all import from; or make `resume.ts` define/import the envelope from a leaf. **Fallback:** widen `ARCH-CYCLE-TYPE-13` with `resume.ts` + updated reason, in the same PR as A1.2. | `pnpm check:architecture` exits 0; no new runtime cycle; HQ rehydrate tests still pass |
| A1.2 | Remove/replace the stale exception `ARCH-CYCLE-TYPE-13` (either retired by A1.1's structural fix or re-scoped with the new member set). | `errors` array empty |

**Owner:** whoever lands HQ workstream A1 (protocol types) — do not edit
`hq/protocol/*` in parallel with A1's active workstream.

### Wave 1 — Resolve the three runtime cycles (P1, ~2–3 weeks) → tasks `A2`, `A3`, `A4`

Ordered cheapest-first so each PR also clears its mirror type exception:

1. **A2 — tools barrel cycle** (`builtin ↔ codebase-index ↔ index ↔ pack ↔ tool-tier`):
   invert `tool-tier`'s dependency on `pack.ts` (register pack tools via injection or a
   leaf contract), then make `codebase-index/index.ts` stop re-exporting through the
   root barrel. Remove `ARCH-CYCLE-RUNTIME-03` + `ARCH-CYCLE-TYPE-28`.
   **Gate:** 0 runtime cycles in `packages/tools`; tools suite green (245 files / 3,575 tests).
2. **A3 — kanban storage/lifecycle cycle** (`_internal ↔ lifecycle ↔ remote-storage ↔ storage`):
   extract the shared persisted-domain contracts (the TYPE-26 `types.ts` facade points
   at the same move) to a dependency-leaf module both facades consume. Remove
   `ARCH-CYCLE-RUNTIME-02` + `ARCH-CYCLE-TYPE-27` (+ `TYPE-26` if the facade collapses).
   **Gate:** 0 runtime cycles in `packages/kanban`; kanban suite green.
3. **A4 — core context/conversation-state cycle**: stop `conversation-state.ts` from
   re-exporting the Context invariant; import it from the leaf it already lives in.
   Remove `ARCH-CYCLE-RUNTIME-01` (and re-check `TYPE-12` member set).
   **Gate:** 0 runtime cycles in `packages/core`; core suite green (658 files / ~10k tests).

**Rollback for all three:** re-add the exception with a fresh review date — never
silently widen.

### Wave 2 — Hotspot decomposition by behavioral seam (P1, ~4–6 weeks) → tasks `B1..B6`

Rules: decompose by tested behavioral seam (ADR-003 Decision 5); every slice must
reduce LOC **or** relative-import fan-out on its file without creating a new ≥800-line
module; each slice ships with its behavior tests. Update `hotspots.json` in the same PR.

| Task | Target | Approach (first slice) | Gate |
|---|---|---|---|
| B1 | `simple-ui-session.tsx` 1,356 | Split chrome/layout regions from session state+handlers (P6 already extracted the shell; the session composition absorbed feature growth — split it the same way) | file < 1,000 lines; SimpleUI suite green |
| B2 | `sage/middleware/tool-call-memory.ts` 1,247 | Extract scoring (relevance) + formatting (formatMemoryHints) into existing `../retrieval/*` modules; keep middleware thin | file < 900; sage suite green (28 files / 636 tests) |
| B3 | CLI slash-commands `memory.ts` / `settings.ts` / `sdd.ts` | Per-command service module under `packages/cli/src/services/` (C2 pattern); command file becomes thin adapter | each < 700; CLI suite green (250 files / 3,204 tests) |
| B4 | TUI `status-bar.tsx` 1,141 | Re-extract chips/rail components (recent feature work grew it back) | < 900; TUI suite green |
| B5 | WebUI `ws-client.ts` 1,129 + `session-handlers.ts` 1,044 | Split transport vs projection concerns; handlers are already domain-split (session handlers file exists) | each < 900; WebUI suite green |
| B6 | WebUI `ChatInput.tsx` 1,148 + `SettingsPanel/index.tsx` 1,089 | Extract composer sub-components; split settings panel sections (they already exist as files — index should compose) | each < 900 |

Sequencing note: B1 is independent; B3 depends on nothing but follows C2's pattern;
B4–B6 are independent UI slices. Up to 3 parallel agents with disjoint file ownership.

### Wave 3 — Hygiene + RAM-leak follow-ups (P2, ~1 week) → tasks `C1..C4`

- C1: metrics dropped-observations wiring + default `maxSeriesPerMetric` (F5.1–2).
- C2: AnalyticsDashboard unmount-cancel (F5.3).
- C3: resolve `TS2454` in `remote-mailbox.ts` (F5.4).
- C4: SAGE config docs drift — remove `bash` from `SageConfig.inject.triggers` docs/
  types or mark legacy (F6).

### Wave 4 — Release-gated & governance (P2, no fixed date) → tasks `D1..D3`

- D1: **ADR-004 next-major**: publish the compatibility window, then physically remove
  the published `@wrongstack/core` root. Needs a maintainer release decision first.
- D2: **Director long-term target**: extract persistence/admission slices behind the
  D2 ports until `director.ts` < 1,200 scanner lines (ratchet, not a sprint).
- D3: **Package-boundary visualization**: emit a generated dependency graph
  (mermaid/JSON) from G1's registry into `docs/reports/` (closes historical 017).

---

## 5. Explicit non-goals

- No new authority packages, no new protocol packages, no package moves.
- No rewrite of `packages/sage`, `packages/core`, or the UI surfaces.
- No line-count-driven splitting of cohesive modules with no behavioral seam.
- No changes to the workspace DAG shape (28 packages, acyclic — keep it).
- No widening of existing exceptions without a reviewed reason and expiry.

## 6. Verification strategy

Every wave is gated by the existing machinery, run on the current tree:

```text
pnpm check:architecture          # registry, DAG, cycles, hotspots, exceptions, API snapshot
pnpm check:test-types            # test-inclusive TS ratchet (3,905-diagnostic baseline)
pnpm check:test-inventory        # exact test collection (zero unexpected skips)
pnpm typecheck                   # production typechecks (per-package, workspace-concurrency=1)
pnpm test:coverage               # coverage lock
```

Wave 0 additionally: `pnpm check:architecture` must exit 0 (currently it does not).
Wave 1 additionally: `grep`-verified 0 runtime cycles per package after removal of the
corresponding exception — the report must show the cycle gone, not the exception gone.

## 7. Risks

| Risk | Mitigation |
|---|---|
| HQ Evolution workstream A1 edits `hq/protocol/*` concurrently with Wave 0 | File-ownership rule: Wave 0 owns the envelope leaf; A1 owns rehydrate payloads; land A1.1 through the A1 owner |
| Runtime-cycle "fix" widens a different exception by accident | Exception changes are explicit diffs reviewed in the same PR; CI rejects widening |
| Hotspot splits create new ≥800-line files (decomposition by line movement) | G2 ratchet catches new hotspots; slices must show behavioral seams + tests |
| Feature work outpaces decomposition (29%-file-growth week) | Ratchets hold the line; Wave 2 is small, reviewable slices; do not batch |
| `remote-mailbox.ts` TS2454 is in a peer-modified file | Coordinate via mailbox before editing; treat as shared-ownership file |

## 8. References

- Fresh health run: `node scripts/check-architecture-health.mjs --json --report-only` (2026-07-31T22:33Z)
- `docs/archive/reports/dated-reports/ram-leak-audit-2026-07-31.md`
- `docs/plans/adr-003-authority-first-refactor-program.md`, `docs/plans/architecture-refactor-task-graph-2026-07.md`
- `docs/plans/hq-evolution-2026-08.md` (concurrent)
- `architecture/exceptions.json`, `architecture/hotspots.json`, `architecture/registry.json`
