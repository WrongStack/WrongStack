# Test Coverage 100% Program — 2026-08

**Goal:** Every measured statement / function / branch in every package is covered by behavioral tests; all coverage gates at 100%; the zero-statement ratchet baseline emptied and flipped to strict mode.

**Author:** Coverage gap analysis, 2026-08-29
**Status:** Proposed — not started
**Estimated effort:** ~5–7 focused weeks (parallelizable per package)

---

## 1. Definition of "100%" (important)

Absolute 100% over every file on disk is neither meaningful nor achievable: Electron entry
points, TTY REPL loops, and barrels cannot execute under vitest. This repo already documents
deliberate root-coverage exclusions in `vitest.config.ts` (barrels, type-only modules,
test-helpers, `grep.ts`/`_env.ts`, CLI TTY entries, `tui/run-tui` + clipboard, `runtime/pack.ts`,
`webui-server/server/index` + entry, `plug-lsp` LSP tools/parsers, `tools` shim + parser-worker-script).

**Done means:** every *counted* file is at 100/100/100/100 in its package gate, the root
aggregate reaches 100, `architecture/coverage-zero-baseline.json` is empty, and the implicit
exclusion list becomes a formal, reviewed registry (`architecture/coverage-exclusions.json`).
Moving code INTO the registry requires a written justification; faking coverage with
assertion-free tests is explicitly forbidden (ratchet philosophy).

## 2. Current state (evidence table)

Percentages from the last available measurement per area; dates noted. 2026-07-27 numbers are
~1 month stale and must be re-verified in Phase 0 (a full `pnpm test:coverage` run was in flight
when this plan was written; it regenerates `coverage/root/coverage-summary.json`).

| Area | Lines | Branches | Est. uncovered stmts | Measured | Confidence |
|---|---|---|---|---|---|
| **webui-protocol** (14/16 src files) | 0% | 0% | whole protocol layer | 2026-08-29 (zero-baseline) | verified — package has NO coverage gate; only 4 of 16 modules have tests (connection-fsm, decoder, registry, replay-payload) |
| **primitives** — `regex-guard.ts`, `time.ts` | 0% | 0% | small | 2026-08-29 (zero-baseline) | verified |
| **cli/src/wiring** — director-announcement, session-establishment, session-runtime, vector-memory-setup | 0% | 0% | wiring glue | 2026-08-29 (zero-baseline) | verified |
| **webui-server** | ~33.4% | — | ~6,509 | 2026-07-27 | assumed (stale) |
| **desktop** (17 files) | 41.6% | 30.7% | ~700+ | 2026-08-14 baseline | assumed; `runtime-manager.ts` ≈432 uncov stmts (stale final.json) |
| **cli** (total) | ~56.8% | — | ~10,789 | 2026-07-27 | assumed (stale) |
| **tui** | ~71.5% | — | ~4,353 | 2026-07-27 | assumed (stale) |
| **tools** | 85.3% | 72.3% | — | 2026-08-15 | assumed |
| **core** | ~88.9% | — | ~4,100 | 2026-07-27 | assumed (stale) |
| **webui** (gate floor) | 55% | 44% | 87 files at 0% | 2026-08-14 | assumed |
| **wrongtrace** | 90.8% | 70.1% | small | one-off focused run | assumed |
| persistence, mcp, sdd, security-scanner, runtime, plug-lsp, bench | 100% | — | 0 | 2026-07-27 | assumed (should re-verify) |

### Gate landscape (live-verified 2026-08-29)

- `scripts/test-coverage.mjs` `COVERAGE_RUNS`: root aggregate → `check:coverage-zero` ratchet →
  plug-lsp per-file gate → webui → coverage-runtime scripts.
- **Regression:** desktop is NOT in `COVERAGE_RUNS` anymore (was added 2026-08-14 per project
  memory). Desktop still has a `test:coverage` script and its own v8 config, but `pnpm
  test:coverage` no longer enforces it. Must be restored or the removal documented.
- Root aggregate thresholds: lines 76 / functions 75 / branches 66 / statements 75
  (`vitest.config.ts`). Per-package convention: 90/90/90/85 with barrels + type-only modules
  excluded as "no runnable code". Packages missing a gate: webui-protocol, primitives,
  wrongtrace (focused one-off only), and any others Phase 0 enumerates.
- `packages/core/tests/architecture/coverage-runtime.test.ts` requires every package/app to
  appear in its `gateLocation` map and define `test:coverage` — new gates must register there.

## 3. Phases (priority = size × risk)

### P0 — Ground truth & harness fixes (~0.5–1 day)
1. Collect the fresh `coverage/root/coverage-summary.json` from the in-flight run; validate with
   `node scripts/check-zero-coverage.mjs`.
2. Refresh scoped packages: webui (two halves: `tests/{stores,lib,server}` then
   `tests/{components,hooks,i18n,integration}`), desktop (`pnpm --filter @wrongstack/desktop
   test:coverage` — never `test -- --coverage`), tools, cli, tui, core, webui-server.
3. Add `scripts/coverage-matrix.mjs` + npm script `coverage:matrix`: aggregate every package
   `coverage-summary.json` into one table (doc artifact in `.reports/`), so progress toward 100%
   is measurable per phase.
4. Restore the desktop stage in `COVERAGE_RUNS` (or document why removed); confirm
   `coverage-runtime.test.ts` gateLocation covers desktop and webui-protocol.
5. Deliverable: `docs/reports/coverage-matrix-<date>.md` with a per-file gap list.

### P1 — Zero-measured code first (~1–2 days) — cheapest wins, removes 16/20 baseline entries
1. webui-protocol: add coverage section to `vitest.config.ts` (include `src/**/*.ts`, thresholds
   90/90/90/85, exclude `src/index.ts` + `src/types.ts`), add `test:coverage` script, register in
   the coverage-runtime gate map.
2. Write behavioral tests for the 12 untested modules: client-conversation, client-integrations,
   client-operations, client-workspace, projections, server-conversation, server-integrations,
   server-operations, server-workspace, version — and deepen the 4 existing suites to 100%.
3. primitives: tests for `regex-guard.ts` (pattern edge cases) and `time.ts` (clock boundaries).

### P2 — webui-server 33% → gate (~1–2 weeks)
- Largest gap by percentage (~6.5k stmts). Route/handler behavioral tests first.
- `chronicle/project-server.ts` (~210 stmts, 0%): blocked on Windows named-pipe hang when
  spawned via tsx in vitest. Fix by injecting the transport (testable seam) or record a formal
  exclusion. No fake tests.
- `server/index` + entry points stay excluded per existing convention.

### P3 — cli 57% → 100% measured (~2 weeks)
- Biggest absolute gap (~10.8k stmts). Start with the 4 wiring files in the zero baseline
  (director-announcement, session-establishment, session-runtime, vector-memory-setup).
- Then slash-commands, HQ server flows (`hq-password-login` style harnesses exist).
- TTY entry points (`cli/main`, `run-cli`) remain excluded.

### P4 — desktop 41.6% → gate (~1 week)
- After P0 restores the pipeline stage. Focus: `runtime-manager.ts` (~432 uncov), IPC handlers.
- Trap (Vitest 4): do NOT set `coverage.include` — it overrides "files imported by tests" and
  drags untestable Electron entries (main/preload/renderer) into the report.

### P5 — tui 71.5% → 100% measured (~1 week)
- Panels, slash commands (see `memory-slash` test pattern: 27 focused cases).
- `run-tui.ts` + clipboard stay excluded.

### P6 — webui 55/53 → 100% (~1–2 weeks)
- 87 files at 0% statement coverage (App, SetupScreen, ChatView, …) as of 2026-08-14.
- jsdom suite; run coverage in halves to fit tool timeouts (threshold errors on halves are
  expected — thresholds are calibrated for the full combined suite).

### P7 — core 88.9→100, tools 85/72→100, wrongtrace branches 70→100 (~1–2 weeks)
- Branch-heavy work: `core/provider-runner.ts`, agent loop paths; `tools` at 72% branches;
  `wrongtrace/hooks.ts` at 63% branches.

### P8 — Gate hardening & lock-in (final, ongoing)
- Per-package thresholds 90/90/90/85 → 100/100/100/100, one package at a time (gate first,
  tests to match — never lower a gate to pass).
- Root aggregate 76/75/66/75 → 100 progressively.
- Empty `architecture/coverage-zero-baseline.json`, then flip `check-zero-coverage` to
  strict-empty mode.
- Formalize `architecture/coverage-exclusions.json` from the implicit `vitest.config.ts`
  exclusion list; each entry carries a justification; removals are free, additions need review.
- plug-lsp per-file gate → 100.

## 4. Working rules (from project experience)

- Behavioral tests only; the ratchet must be satisfied by real coverage, never by baseline or
  exclusion-list expansion.
- A scoped text-only coverage run OVERWRITES the package's full-run `coverage-final.json` with
  partial data — read the text log for authoritative per-file numbers, re-run full package
  before trusting JSON.
- `=== Coverage:` banner lines in pipeline logs are not stage-completion markers (the
  coverage-runtime architecture test re-prints them); use `coverage-summary.json` mtimes.
- Root stage ≈ 2.5–3 h on this Windows host (2,600+ test files) — run overnight / in CI, never
  inside a tool timeout.
- Tests run with `WRONGSTACK_HOME` redirected to a temp dir (vitest.setup.ts) — keep it that way.
- Node ≥ 22.19 required for the coverage toolchain.

## 5. Verification

- Full: `pnpm test:coverage` → then `node scripts/check-zero-coverage.mjs`.
- Per package: `pnpm --filter <pkg> test:coverage` (desktop: package script only).
- Targeted while writing tests: `pnpm exec vitest run <files> --coverage` (scoped).
- Progress: `pnpm coverage:matrix` (P0 deliverable) → diff matrix per phase.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Fake tests written to chase 100% | Behavioral-only rule + review; ratchet stays strict |
| Windows-only code (named pipes, TTY) unreachable in vitest | Injectable-transport refactors or reviewed exclusions — never both-skipped tests |
| Scoped runs corrupting full-run JSON | Text-log discipline (rule above) |
| Gates lowered to make CI green | Policy: gates only ever ratchet up; regressions are bugs |
| Stale 2026-07 numbers misprioritizing work | P0 refreshes everything before P2+ ordering is final |

## 7. Tracking

Phases P0–P8 are registered in the session plan board; execution should fan out one Kanban card
per package workstream (independent, parallelizable). Each phase lands with: tests merged,
package gate raised, matrix regenerated, ratchet re-validated.
