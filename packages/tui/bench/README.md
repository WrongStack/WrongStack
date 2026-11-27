# TUI heap-soak benchmark

This benchmark measures the retained heap of the production Ink `ScrollableHistory` renderer under a deterministic growing transcript at narrow and wide terminal widths.

Run the controlled profile:

```bash
pnpm bench:tui-heap
```

Run a smaller end-to-end smoke profile (it still writes and analyzes heap snapshots):

```bash
pnpm bench:tui-heap --quick
```

Artifacts are written to `.reports/tui-heap-soak/`:

- `width-<n>.json` — post-GC checkpoints, plateau slope, render timing, and mounted Ink/text/Yoga counts.
- `width-<n>-mounted.heapsnapshot` — retained heap with the renderer mounted.
- `width-<n>-unmounted.heapsnapshot` — retained heap after renderer teardown.
- `width-<n>-dominators.json` — exact immediate-dominator retained-size reports for both snapshots.
- `report.json` and `report.md` — narrow/wide aggregate comparison.

The command bundles workers into `.temp_files/tui-heap-soak/`, runs each width in a fresh `node --expose-gc` process, analyzes snapshots only after the renderer process exits, and deletes the temporary bundles in `finally`.

Useful overrides:

```bash
pnpm bench:tui-heap --entries 5000 --steps 30 --plateau-samples 12 --widths 64,200
```

Compare post-GC plateau slope and top mounted/unmounted dominators rather than one RSS sample. A healthy bounded renderer should approach a stable post-GC heap after the transcript and viewport reach steady state.

## Input-latency benchmark (keystroke → Ink frame-commit)

`bench/input-latency.tsx` measures how long a printable keystroke takes to reach a committed Ink frame, so composer perf work (e.g. the shared-clock change in `src/second-clock.ts`) can be measured instead of guessed. Run it from `packages/tui`:

```bash
bun run bench:input-latency
# or directly, with overrides:
bun bench/input-latency.tsx --widths 72,160 --samples 96 --warmup 32 --interval-ms 10
```

It prints a JSON summary (p50/p95/max/min/mean/spread per width plus every raw sample); `--output <path>` also writes it to a file. There is no CI gate — run it on demand, on a quiet machine, and compare repeat runs before believing a win (see `PERF_LOG.md` for why).

### What it measures — and what it does NOT

- **Measured:** elapsed ms from each `stdin.write(key)` into the fake TTY until the first captured Ink stdout frame whose text contains the echoed draft. This is **keystroke → Ink frame-commit, in-process**.
- **Not measured:** real terminal paint, PTY/OS transport and scheduling, font rasterization, or the app shell (history, status bar, pickers). The composer is mounted bare.
- **Component:** by default the **real composer `Input`** (`src/components/input.tsx`) with a minimal draft host (`value`/`cursor`/`onKey`, printable keys append at the cursor — the same contract the app's key router drives), idle status and no `workingClock`, so the composer subscribes to no timers while measured. `--component echo` swaps in a clearly-labeled minimal echo component for harness debugging only; the JSON `component` field always names which one ran (`real-composer-input` vs `minimal-echo`).

### How it stays deterministic and low-noise

- Fake TTY streams (same approach as `tests/helpers/real-tty.tsx`), no `node-pty`. Every stdout write is timestamped with `performance.now()` at capture; latencies are attributed offline over the frame log, so no polling sits inside the measured interval.
- Fixed workload: a deterministic 36-char printable cycle, `--run-length` keystrokes per draft cycle (default 32), draft reset between cycles outside the measured window, fixed `--interval-ms` pacing (default 10 ms), `--warmup` discarded keystrokes (default 32) before the `--samples` measured ones (default 96) at each width (default 72 and 160 columns, in-process, sequentially).
- The glyph profile is pinned (`WRONGSTACK_TUI_ICON_STYLE=unicode`) like the test suite, so installed Nerd Fonts cannot change frame text.

### The render throttle dominates — how the bench configures it

Ink's `maxFps` throttle bounds every repaint, a typed character's echo included (`src/run-tui-mount.ts` documents 30 fps production / 15 fps frugal). The bench therefore renders **non-debug interactive** with `maxFps` defaulting to the production `tuiRenderMaxFps()` (override with `--max-fps`, e.g. `--max-fps 10` to reproduce the old ceiling):

- `debug: false` — Ink's debug mode (used by `renderRealTty`) disables the throttle entirely; measuring through it would time a path production never uses.
- `interactive: true` — explicit, so CI env detection cannot silently switch Ink to write-only-at-unmount mode.
- `incrementalRendering: false` — every commit is a whole-frame write, making echo detection a plain substring check (production Windows consoles repaint whole frames anyway).

At the default 10 ms inter-key pacing, keystrokes arrive faster than the ~34 ms throttle window, so echoes ride the throttle's trailing edge and latencies reflect the production burst-typing regime. With `--interval-ms` above `1000/maxFps`, the throttle's leading edge fires immediately and the numbers collapse to the raw React+Ink commit cost — useful as a floor, but not the burst regime. Compare like-for-like settings across runs.

### Smoke test

`tests/input-latency-bench.test.ts` exercises the measurement helper on the minimal echo component and asserts sane finite numbers (no perf thresholds), so the harness cannot rot unnoticed. Run just that file:

```bash
bun --bun run vitest run --config vitest.config.ts tests/input-latency-bench.test.ts
```
