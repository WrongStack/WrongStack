# Performance ratchet

One-click performance work, built on two rules that are enforced rather than
requested:

1. **Nothing counts unless it was measured.**
2. **Anything not measurably better gets reverted.**

The bug hunter proves a defect with a failing reproduction. The ratchet proves a
speed-up with a number, and reverts everything that cannot produce one.

---

## Surfaces

| Surface | Entry point |
|---|---|
| WebUI | Welcome screen → **Start Performance Ratchet** (scope, mode, metric) |
| CLI / TUI | `/perf [mode] [target] [--metric=<id>]` |
| CI / local gate | `pnpm perf:guard` |

### `/perf`

```
/perf                              Ratchet round across the project
/perf packages/sage                Ratchet round, restricted to a target
/perf audit packages/tui           Read-only audit of a target
/perf cpu --metric=p99-latency-ms  Name the metric that matters
/perf log                          Print the PERF_LOG.md ledger (no model call)
/perf help                         Modes, flags, and the rules
```

Modes: `ratchet` (default), `audit`, `triage`, `memory`, `io`, `cpu`, `guard`,
`contract`. Each maps to a builtin prompt in the `performance` category.

`ratchet`, `cpu`, and `guard` may change production code, so they force a solo
session first — a round that attributes one measured delta to one change cannot
be fanned out across subagents. The read-only modes leave the subagent policy
alone.

Every round is handed the profiling commands for the stacks actually detected in
the working directory (Go, Rust, Python, PHP, .NET, JVM, Ruby, Node, or the
generic `perf` / `hyperfine` / `time -v` fallback), so "profile it first" is a
command the user can paste rather than an instruction to go looking.

---

## `PERF_LOG.md` — the ledger

Append-only, markdown, parsed. One round per workload per sitting:

```
## 2026-09-01 — parser throughput
commit:   a1b2c3d
machine:  M2 Pro / 16GB / macOS 15.2 / node24.13
command:  pnpm bench --filter parser
baseline: 412ms median, 84k allocs/op

- [KEPT]     preallocate token slice    → 388ms, 61k allocs/op (-27% allocs)
- [REVERTED] map → sorted slice lookup  → 409ms, within noise

current:  301ms median (-27% wall vs baseline)
failed hypotheses: map lookup was not the bottleneck; cost is bufio growth.
```

Reverted attempts stay in the record on purpose. The list of hypotheses that did
*not* work is the part that stops the next round from retrying them.

Re-running the same workload on the same day merges into the existing round
rather than forking a duplicate, and never overwrites the original `baseline` —
the distance travelled from it is the point.

---

## The keep/revert gate

`decide()` in `@wrongstack/core/performance` is the whole judgment, and it is a
pure function:

```
noise band  = max(run spread of the two measurements, 5% floor)
improvement > band  → KEEP
regression  > band  → REGRESSED
anything else       → REVERT (it is noise)
```

Both halves matter. A 3% win on a very quiet machine clears the spread but not
the floor, and is not worth the readability. An 8% win with 30% run-to-run
variance clears the floor but not the spread, and is a coin flip wearing a
percentage sign.

`measure()` refuses to report a measurement built from fewer than three usable
runs, discards runs whose extractor found no number (rather than averaging in a
zero), caps captured output so a chatty benchmark cannot become a memory
incident, and tears down a hung run by process tree.

---

## `pnpm perf:guard` — the pawl

Probes live in `architecture/perf-baseline.json`. Each names a command, a
metric, and an extractor; the guard runs them, compares against the recorded
baseline, and:

- **fails** on a regression past the threshold, or on a baselined metric that
  produced no measurement at all — a benchmark that silently stopped running is
  the most common way a green guard stops meaning anything;
- **ratchets** the baseline down for improvements, but only with `--write`;
- **changes nothing** inside the band, including the baseline. Quietly
  re-recording a slightly worse number every run is how a "guarded" project
  drifts 40% slower without a single red check.

```bash
pnpm perf:guard                                  # measure, report, gate
pnpm perf:guard:write                            # …and tighten improvements
node scripts/perf-guard.mjs --write --adopt      # …and adopt new probes
node scripts/perf-guard.mjs --only cli.          # id prefix filter
node scripts/perf-guard.mjs --from results.json  # take id→value from a harness
node scripts/perf-guard.mjs --any-machine        # compare across machines anyway
node scripts/perf-guard.mjs --json               # machine-readable report
```

### The machine is part of the comparison

Each entry records the machine it was measured on, and a probe whose baseline
came from a different one is reported as `DRIFT` and **not compared** — in
either direction. Comparing across machines is the most common way a ratchet
lies:

- a slower box invents regressions nobody wrote;
- a faster box is worse — `--write` would ratchet the baseline down to a number
  the original machine can never reach again, and every run there afterwards
  fails for a slowdown that never happened.

So the baseline is per-machine, which is also why this guard is a **local and
per-runner gate rather than a shared CI gate**: numbers recorded on a developer
workstation are not evidence on a GitHub runner. To gate in CI, record the
baseline on the runner itself (`--write` on a first green run) and keep it
alongside the runner, or hand the guard numbers from a harness that already
normalises for hardware via `--from`.

`--any-machine` opts out when the hardware genuinely is equivalent.

The guard measures `dist/`, which is what users actually run — build first.

A probe with `"value": null` is declared but not yet recorded; the first
`--write` fills it in, in either direction, and every run after that only
tightens.

Adding a probe: append an entry with `id`, `label`, `metric`, `command`,
`extract` (`wall`, `re:<pattern>`, `json:<dotted.path>`, `gnu-time-rss`,
`hyperfine`), `"value": null`, then run `pnpm perf:guard:write`.

**Telling a real regression from noise**: re-run on an idle machine. The guard's
default threshold is 15% precisely because CI machines are noisier than a
developer's, and a guard that cries wolf gets disabled — which is strictly worse
than one that only catches the big ones.

---

## Layout

| Path | What it owns |
|---|---|
| `packages/core/src/performance/perf-stats.ts` | median/p95/spread, the keep/revert gate |
| `packages/core/src/performance/perf-runner.ts` | repeat runs, warmup, timeout, tree-kill |
| `packages/core/src/performance/perf-extractors.ts` | output → one number |
| `packages/core/src/performance/perf-log.ts` | `PERF_LOG.md` parse / render / atomic append |
| `packages/core/src/performance/perf-guard.ts` | baseline comparison and ratchet |
| `packages/core/src/performance/perf-stack.ts` | stack detection → profiling commands |
| `packages/core/src/performance/perf-modes.ts` | mode → builtin prompt slug |
| `packages/core/src/plugins/perf-command.ts` | `/perf` |
| `packages/core/data/prompts/prompts/performance/` | the eight builtin prompts |
| `packages/webui/src/lib/perf-run-message.ts` | transcript card metadata |
| `scripts/perf-guard.mjs` | `pnpm perf:guard` |
| `architecture/perf-baseline.json` | the probes and their recorded numbers |
| `PERF_LOG.md` | the ledger |

Prompt sources live in `packages/core/data/prompts/_seed/performance.jsonl`;
edit those and run `node packages/core/scripts/build-prompts.mjs` to regenerate
the dataset and its checksums.
