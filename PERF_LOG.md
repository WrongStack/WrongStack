# PERF_LOG

The performance ratchet ledger. Every entry below was produced by running the
command it names; nothing here is recorded from reading the code.

Rules: one variable per attempt; a delta inside the run spread or under the
noise floor is REVERTED, not kept; correctness gates everything.

## 2026-09-01 — guarded startup probes
commit:   b608d82f6
machine:  AMD Ryzen 9 9950X3D 16-Core Processor / 32c / 126GB / win32 10.0.26200 / node 24.13.0
command:  pnpm perf:guard
baseline: @wrongstack/core barrel import: 274ms, wstack --version cold start: 573ms, @wrongstack/tui barrel import: 848ms (median of 5 runs, 1 warmup)

failed hypotheses: none yet — this round records the baseline only; no change has been attempted.

## 2026-09-01 — cli cold start ratchet (round cli-coldstart-r1, scope packages/cli)
commit:   b608d82f6 (packages/cli/src clean before the change; unrelated dirty files elsewhere in the worktree)
machine:  AMD Ryzen 9 9950X3D 16-Core Processor / 32c / 126GB / win32 10.0.26200 / node 24.13.0
metric:   wstack --version cold start (process launch → exit) — what every CLI invocation pays
commands: node .temp_files/perf-ratchet/cli-coldstart-r1/run-bench.mjs   (round runner: 5 runs, 1 warmup)
          node scripts/perf-guard.mjs --only cli.                        (guarded probe, 5 runs, 1 warmup)
baseline: version median 595ms (min 581 / max 600, spread 19ms) · import-only 564ms · node floor 54ms
          perf-guard: −12.9% vs recorded 573ms (inside the 15% band → baseline reproduced)
profile:  cpu-prof, 580.6ms sampled: compileSourceTextModule 19.9% + internalModuleStat 11.3% +
          getPackageScopeConfig 7.6% + readFileUtf8 5.7% + wrapSafe (cjs) 5.2% → module-LOAD bound;
          all product frames together ≈ 30ms. Attribution (src): dist/index.js statically imported
          cli-context.js → boot.ts → @wrongstack/runtime, core barrels, subcommands/index.js
          (full registry), per-subcommand-help.js — all before --version could short-circuit.
change:   ONE variable — the informational-flag fast path. cli-entry-main.ts applies the pre-boot
          env defaults first (NODE_ENV default is test-pinned on --help by
          cli-main-flag-content.test.ts), then handles --help/--version via a dynamic import of
          boot/short-circuit-flags.js BEFORE cli-context.js is fetched. short-circuit-flags.ts
          imports subcommands/index.js + per-subcommand-help.js lazily (only for
          subcommand-focused help). initializeCli keeps its own short-circuit for direct callers.
after:    version median 444ms (min 418 / max 456, spread 38ms) · import-only 431ms · floor 57ms
          perf-guard: cli.cold-start 22.2% better than the 573ms baseline (outside the 15% band)
verdict:  KEEP — 595 → 444ms median (−151ms, −25.4%), ≈7× outside the noise band (max(38ms, 5%) ≈ 22ms)
tests:    packages/cli suite: before 447 passed / 1 failed / 2 skipped; after the identical failure
          set (pre-existing wiring-session.test.ts "survives missing todos checkpoint" telemetry
          assertion — session-wiring code this change never touches). boot-graph-boundary
          (≤60 entry modules, MUST_BE_LAZY, chunk emission) green after the change.
prediction miss (recorded so the next round does not repeat it): hypothesis predicted ≥50%
          (≤300ms); measured −25.4%. The fast path still statically carries preflight.js →
          @wrongstack/tools and chunk-7JBKXVMK.js (173.7KB) which IS src/hq-server.ts — hq/ws/
          @wrongstack/core-hq code loaded on every invocation. Next round's top hypothesis:
          defer the hq-server chunk off the always-loaded entry graph.
note:     follow-up (same session, after the round): cli.cold-start ratcheted in
          architecture/perf-baseline.json — `node scripts/perf-guard.mjs --only cli. --write`
          recorded 398ms (recordedAt 2026-09-01T11:53:21Z, commit b608d82f6, same machine;
          30.5% GAIN vs the old 573ms). The guard's wall extraction reads ~45ms lower than this
          round's spawnSync runner (398 vs 444 median); both numbers stay recorded above with
          their exact commands.

## 2026-09-01 — memory-growth & retention audit (mode: memory, scope: repo-wide)
commit:   b608d82f6 (worktree carries 96 unrelated modified files; this run changed no source)
machine:  AMD Ryzen 9 9950X3D 16-Core Processor / 32c / 126GB / win32 10.0.26200 / node 24.13.0
metric:   peak RSS (MB) + live heap (heapUsed after forced GC) over a 30-min steady-load soak,
          sampled t0/t5/t30. Chosen because leaks are monotonic growth — invisible to the CPU and
          throughput metrics used by perf:guard.
command:  (static source audit — no benchmark executed this round; the baseline below is the
          leak-risk inventory at this commit, verified by reading source, not by measurement)
baseline: 0 "leaks forever" paths in audited long-lived code · 3 minor retention/lifetime notes ·
          25+ timer / watcher / fd / worker sites verified with complete teardown · every audited
          cache has a cap or eviction (EventBus 2000/500, llm-cache LRU 256, receipt cache
          TTL+1024, token store 256, registries MAX_GLOBAL_ROOTS, SAGE cooldown prune)
attempts: 8 verification passes: module-level singletons · timers/intervals · fs watchers ·
          streams+fd error paths · worker pools · plugin in-memory stores · webui-server
          connection state · apps/desktop module state
verdict:  N/A — report-only run; no code change, nothing kept or reverted. Priority order for
          fixes awaits user confirmation per the run brief.
findings: (1) core/src/coordination/session-note-hub.ts:79 — first-wins `buses` binding retains a
          session's dead first EventBus while any later inbox of that session remains (refcount
          delete only at :88-90); bounded by session lifetime, minor. (2) mcp/src/registry.ts:67 —
          `servers` retains stopped slots by design (describe() documents "every server ever
          registered"); teardown at :321-354 is otherwise complete; bounded by config names.
          (3) tools/src/codebase-index/project-server-client-state.ts:85 — `connectionStates`
          keeps one small entry per endpoint until forgetConnection/close; deletion paths verified
          at project-server-client.ts:711/807/815.
note:     NOT individually audited (residual risk, next candidates): the 17 plugins holding
          in-process Maps (cron, duplicate-code-detector, semantic-search-indexer, prompt-firewall,
          session-recap, spec-linker, performance-regression-gate, file-watcher, …),
          apps/desktop listener registries (webui-preload.ts:29, i18n.ts:55), TUI history buffers.
soak:     run `wstack` WebUI host; steady load via WS client: 1 chat turn + 1 tool-heavy command
          every 5s for 30 min; at t0/t5/t30 force GC (--expose-gc) then log
          process.memoryUsage().rss/heapUsed/external/arrayBuffers; heap snapshot diff by
          retained size (node --inspect → DevTools → Memory). Flat or sawtooth passes; monotonic
          rise at t30 fails. Component-level: registry stdio/http fault-soak tests already exist
          (packages/mcp/tests/*-soak.test.ts) and can run as long-loop soaks.

## 2026-09-01 — plugin-store audit + F1 fix (scope: packages/plugins, packages/core)
commit:   b608d82f6 base; F1 fix uncommitted in worktree (session-note-hub.ts + its test)
machine:  AMD Ryzen 9 9950X3D 16-Core Processor / 32c / 126GB / win32 10.0.26200 / node 24.13.0
metric:   (audit + correctness round — no perf metric; recorded per the perf-run ledger rule
          that results not written here did not happen)
plugin-stores-audit (report-only, no code changed):
  VERDICT: no missing-eviction finding in any of the 17 stores. All bounded:
  - cron: jobs/timers cleared at teardown (cron/index.ts:88-93)
  - duplicate-code-detector: LRU + budget accounting, evictions counter (:302-303, :583-614)
  - semantic-search-indexer: index replaced wholesale on rebuild (:354-355); growth bounded
    per generation by the project file set. NOTE (freshness, not a leak): files deleted from
    disk stay in the index until the next rebuild — flagged for the plugin owner
  - prompt-firewall: windowed scanner, caps at :204-227; byKind map keyed by fixed pattern
    kinds (:644); per-call Maps (:395, :466)
  - session-recap: perModel/toolCounts keyed by bounded cardinality, reset (:173, :183, :361-364)
  - spec-linker: regex cache keyed by spec names (:158); per-call locals (:242, :307)
  - performance-regression-gate / dead-code-detector / config-validator / changelog-writer /
    test-flake-detector / accessibility-auditor: per-invocation locals, no persistent state
  - template-engine: MAX_TEMPLATES=256 + 256KB content cap (:36-39)
  - model-router: counters, cleared at teardown (:219, :330)
  - file-watcher: MAX_WATCH_GROUPS=32 (:58), teardown clears both maps (:121-131)
  - llm-cache: LRU-256 (prior round) — still bounded
f1-fix (session-note-hub.ts stale-bus retention):
  change:  disposer rebinds the cached session bus to a surviving live contributor's bus when
           the disposed inbox owned it (scan of this.inboxes with the same normalized sid);
           releases the dead first agent's EventBus immediately instead of retaining it until
           the session's LAST inbox unregisters. TS narrowing kept inline (`if (!other.events)
           continue`) — a precomputed boolean is not a type predicate.
  tests:   session-note-hub.test.ts rebind contract updated + new non-owning-unregister case
  verify:  19/19 session-note tests (hub 8, subagent-routing 4, owning-session-routing 7) ·
           core typecheck exit 0 · Biome lint clean
  verdict: KEEP (correctness/memory fix; no perf ratchet applies — behavior contract change:
           the cached session bus now follows a live contributor, not the first registrant)

## 2026-09-01 — 30-min WebUI/HQ host soak (round soak-webui-r1)
commit:   b608d82f6 base; F1 fix present in worktree (not in the running dist — dist predates it;
          the soak measures the as-built host, not the F1 change)
machine:  AMD Ryzen 9 9950X3D 16-Core Processor / 32c / 126GB / win32 10.0.26200 / node 24.13.0
metric:   peak RSS (MB) at t0/t5/t30 under steady load (live heap unavailable — see limitations)
command:  node .temp_files/soak-webui/soak-webui.mjs   (runner deleted after the run; numbers below
          are the complete record)
host:     node packages/cli/dist/index.js hq serve --port 4937, WRONGSTACK_HOME sandboxed to
          .temp_files/soak-webui/home (first-run HQ auth provisioned inside the sandbox)
load:     HTTP GET / every 5s + WS connect/disconnect cycle every 30s (authenticated /ws/client
          endpoint from host stdout) + best-effort ping stream. Heartbeat-verified continuous for
          the full 30 min: hb1800s http=324+/0 fails churn=53+ (t30 sampler hung before final count)
samples:  t0  136.4 MB  (15:59:42Z, at load start)
          t5  108.3 MB  (16:04:43Z, under load)
          t30 108.9 MB  (16:29:00Z, manual Get-Process WorkingSet64 at the 30-min mark)
verdict:  PASS — RSS profile is declining-then-flat (136.4 → 108.3 → 108.9); no monotonic rise at
          t30. t30 sits at the t5 level after 30 min of load and stays there post-load.
limitations (recorded, not hidden): (1) live-heap sampling unavailable — the heap-watchdog JSONL is
          not produced by this hq-serve path; RSS-only verdict. (2) The in-driver t30 sampler hung
          in execFileSync('powershell') (second occurrence of this failure shape; soak r1 attempt 3
          stalled the same way) — the t30 number is a manual Get-Process sample taken at the mark.
          Anti-pattern recorded: never use sync execFile of powershell inside a long-run sampler.
          (3) The persistent WS client is closed by the server ~5s after open (endpoint enforces an
          auth/hello deadline) — the WS contribution to load is the churn cycle only.
artifacts: .temp_files/soak-webui/ deleted after this entry (numbers above are the record)

## 2026-09-01 — 15-min delta soak with the F1 fix in the built dist (round soak-webui-r2)
commit:   dist rebuilt via `node scripts/build.mjs` AFTER the F1 fix (core dist 19:22:16 local,
          cli dist 19:22:45 local) — this run measures the host WITH the rebind fix compiled in
machine:  AMD Ryzen 9 9950X3D 16-Core Processor / 32c / 126GB / win32 10.0.26200 / node 24.13.0
metric:   RSS (MB) at t0/t5/t15 under the same steady load as r1 (comparability)
command:  node .temp_files/soak2/soak-delta.mjs   (15-min variant; runner deleted after the round)
host:     node packages/cli/dist/index.js hq serve --port 4938, WRONGSTACK_HOME sandboxed
load:     HTTP GET / @5s + authenticated WS churn @30s + best-effort ping; heartbeat-verified
          continuous for all 15 min (final hb 900s http=180/0 fails churn=29)
samples:  t0  142.1 MB  (16:42:08Z, at load start)
          t5  109.2 MB  (16:47:09Z, under load)
          t15 109.6 MB  (16:57:10Z, under load)
verdict:  KEEP — PASS. Same declining-then-flat profile as r1 (136.4→108.3→108.9): the F1 fix in
          the dist shows no RSS regression and the host stays flat under load. heapUsed still
          unavailable on this host path (round soak-webui-r3 fills that gap).
delta vs r1: t0 slightly higher (142.1 vs 136.4, one boot's JIT variance), post-reclaim plateau
          identical within noise (109.2-109.6 vs 108.3-108.9). No action.

## 2026-09-01 — 15-min live-heap soak, standalone webui-server boot (round soak-webui-r3)
commit:   dist as r2 (F1 fix compiled in)
machine:  AMD Ryzen 9 9950X3D 16-Core Processor / 32c / 126GB / win32 10.0.26200 / node 24.13.0
metric:   heapUsed (MB) after TWO forced gc() passes at t0/t5/t15 — fills the live-heap gap the
          RSS-only r1/r2 verdicts left
command:  node --expose-gc .temp_files/soak2/soak-heap.mjs   (deleted after the round)
host:     startWebUI({ httpPort: 4939 }) imported in-process from packages/webui-server/dist;
          WRONGSTACK_HOME sandboxed to heap-home
load:     HTTP GET / every 5s — the standalone boot serves no static frontend, so every request
          resolves via the route-dispatch 404 path (r.ok=false by design); 180 requests over
          15 min, zero connection errors
samples:  t0  heapUsed 49.6 / rss 170.7 / external 3.9   (17:01:56Z, right after port-up)
          t5  heapUsed 66.5 / rss 144.5 / external 4.1   (17:06:57Z, under load)
          t15 heapUsed 66.9 / rss 148.4 / external 4.1   (17:16:58Z, under load)
verdict:  PASS — warmup rise t0→t5 (+16.9 MB, lazy service init continuing after early port-up),
          then FLAT: t5→t15 is +0.4 MB over 10 minutes of continuous load. External memory flat
          at ~4.1 MB. No monotonic growth in the loaded window; live heap is bounded.
limitations: (1) load is the 404-dispatch path only — no static frontend and no chat turns without
          a configured provider session. (2) t0 was sampled immediately after port-up, so the
          t0→t5 rise mixes lazy init with load; the load-attributable comparison is t5 vs t15.
note:     first launch attempt crashed at require.resolve('@wrongstack/webui-server') — the pnpm
          workspace has no self-link at the package's own anchor; the driver imports the dist
          entry via pathToFileURL instead.
artifacts: .temp_files/soak2/ deleted after this entry.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2026-09-01 — ADR-004 semantic ambiguity layer: guard-path cost baseline
workload: compileUserRegex + detectQuantifiedAmbiguity microbench, 4 cases
command:  pnpm exec tsx .temp_files/adr004-impl/perf.ts (2000/200/2000/2000
          iterations after warm-up; artifacts deleted after this entry)
metric:   ms per call
values:   static-only baseline (unquantified group) 0.0001
          benign guard path `(foo|bar)+`            0.0001
          semantic layer direct, `(?:a+)|b`         0.0112
          worst-case ~250-char alternation          0.0005
commit:   working tree post-62599ac1b (ADR-004 implementation, uncommitted)
machine:  WHITE (Windows dev box)
runtime:  node v24.13.0
verdict:  PASS — ADR-004 perf gate (<1 ms/pattern for ≤256-char patterns)
          cleared by ~100x on the worst measured case; benign guard paths
          unaffected at measurement resolution.
limitations: microbench on an otherwise-idle box, wall-clock via
          performance.now; the "worst-case" pattern is one synthetic
          40-branch fixed-count alternation, not an exhaustive search of
          the 256-char pattern space (checker budget caps at 60k steps).
