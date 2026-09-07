# Performance Ratchet Log — `packages/cli`

## Run 1 — 2026-09-07

**Metric:** `wstack version` cold-start wall time (process start → handler exit)
**Command:** `node packages/cli/dist/index.js version`
**Runs:** 7 warm runs (2 warmup passes first)
**Machine:** Windows, Node 24.13.0, HDD-backed project on SSD

| Run | Wall ms | Status |
|-----|---------|--------|
| 1 | 1196 | OK |
| 2 | 1285 | OK |
| 3 | 1053 | OK |
| 4 | 981 | OK |
| 5 | 1185 | OK |
| 6 | 951 | OK |
| 7 | 901 | OK |

**Result:** STOPPED — spread 384ms (36% of median 1053ms) exceeds noise band.
Wall-time benchmarking is unreliable on this machine; the ratchet cannot proceed.

**Baseline:** median=1053ms, min=901ms, max=1285ms, spread=384ms

**Verdict:** REVERT — no change attempted (noisy benchmark)

---

## Code Analysis (not measured, for next round)

### Hypothesis A — `createDefaultContainer` is unnecessary for subcommand path
**Status:** SPECULATIVE
**Evidence read:** `boot.ts` lines 376–383 — `createDefaultContainer(...)` is called for every subcommand
invocation, but the handler deps (`sessionStore`, `skillLoader`) are the only container services actually
used. `toolRegistryForSubcmd` is created but never passed to the handler.
**Expected win:** Unknown — needs profiling to confirm container construction is a measurable fraction
of the 900–1300ms range.
**Next:** Profile with `--prof` before changing anything.

### Hypothesis B — `DefaultModelsRegistry` instantiation before subcommand dispatch
**Status:** SPECULATIVE
**Evidence read:** `boot.ts` lines 338–351 — `new DefaultModelsRegistry(...)` is instantiated before
the subcommand dispatch check at line 360. It reads `wpaths.modelsCache` synchronously and schedules
a background TTL=0 fetch. The comment on line 353 says subcommands should run "before network I/O" but
the registry is still built.
**Expected win:** Unknown — likely <50ms (synchronous cache read + object construction).
**Next:** Confirm with `--prof`; if confirmed, move instantiation to after the `if (first && subcommandHandler)` block.
