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

## 2026-09-06 — plugins runtime shim layer: import-cost ceiling (round plugins-runtime-r1, scope packages/plugins/src/runtime)
commit:   7edb58a8d (scope dir clean; 70 unrelated dirty files elsewhere in the worktree)
machine:  AMD Ryzen 9 9950X3D 16-Core Processor / 32c / 126GB / win32 10.0.26200 / node 24.13.0
metric:   cold-import wall time of the runtime entry, fresh process, timed around
          `await import()` inside the child. Picked because the in-scope directory is
          7 pure re-export shims over `@wrongstack/plugin-sdk/runtime` (zero executable
          logic — every file read), imported by 40+ plugin modules and the
          `@wrongstack/plugins/runtime` subpath: import cost is the only thing this
          scope contributes to any workload.
commands: node .temp_files/perf-ratchet/plugins-runtime-r1/run.mjs 10   (25 fresh-process children)
baseline: via in-scope shim `packages/plugins/src/runtime/index.ts`: median 59.41ms
          (min 52.36 / max 86.18, n=10). Direct to the SAME graph,
          `packages/plugin-sdk/dist/runtime.js` by file URL (no shim hop): median 40.87ms
          (min 38.03 / max 46.39, n=10). Ranges fully separated — shim min 52.36 > direct
          max 46.39 — decisive ordering; both arms re-export the identical 32-symbol surface.
guard:    `withReDoSGuard` through the in-scope entry, positive path, fresh process:
          first call median 18.75ms (17.47–21.65, n=5); second call in the SAME process
          16.31–22.94ms — no amortization, one worker thread spawned per call.
hypothesis: WRONG — predicted "shim hop <1.5ms / <5% of chain"; measured 18.54ms median
          (31% of the chain) on the src path. Recorded so the next round does not repeat it.
attribution (measured + read): the delta = bare-specifier resolution (node_modules walk +
          pnpm symlink + plugin-sdk exports-map lookup) + Node type-strip parse of the
          11-line shim + namespace rebind. In a built dist the TS-parse term disappears,
          leaving the resolution term — which no edit inside packages/plugins/src/runtime
          can reduce: plugin-sdk exposes no narrower export entry (verified exports map),
          deleting the shims breaks the documented subpath + 40+ relative importers, and
          named-vs-star re-export loads the identical graph.
change:   none made. The A/B bounds the maximum any in-scope edit could save, and no
          in-scope edit reaches any of the three cost terms.
verdict:  NO CHANGE KEPT (structural ceiling). The chain itself is dominated by the
          plugin-sdk runtime barrel + transitive imports (~41 of ~59ms), all out of scope.
tests:    in-scope surface green at the measured commit: 10 test files, 206 passed /
          1 skipped / 0 failed (`pnpm exec vitest run` on runtime*.test.ts, redos-guard,
          sandbox, secret-scanner, plugin-llm-runtime; 1.30s). Full package suite not run —
          no production change was kept, so there is no before/after to gate.
next round (out of scope today, ranked by expected win):
          (1) `withReDoSGuard` spawns a Worker per call: ~19ms for a µs-scale regex exec;
              a pooled/warm worker or an in-process fast path for patterns the SDK's static
              checker already vetted would cut per-scan cost >99% for secret-scanner /
              prompt-firewall / path-guard. Target: packages/plugin-sdk/src/runtime/redos-guard.ts.
          (2) the runtime barrel loads all 10 modules (~41ms) for consumers that need one
              symbol; granular export entries in plugin-sdk's package.json would enable lazy
              loading. Target: plugin-sdk exports map + shim import specifiers.
limitations: no packages/plugins dist build exists on this machine, so the src-path
          measurement includes the type-strip term a dist consumer would not pay; the
          direct arm does no specifier resolution at all (conservative — inflates the
          shim's apparent cost); arms ran as two sequential blocks, not interleaved.
artifacts: .temp_files/perf-ratchet/plugins-runtime-r1/ deleted after this entry
          (numbers above are the record).

## 2026-09-06 — redos-guard warm worker pool (round sdk-redos-r2, scope packages/plugin-sdk/src/runtime/redos-guard.ts)
commit:   7edb58a8d base; the change is uncommitted in the worktree (redos-guard.ts)
machine:  AMD Ryzen 9 9950X3D 16-Core Processor / 32c / 126GB / win32 10.0.26200 / node 24.13.0
metric:   withReDoSGuard per-call wall time — what prompt-firewall (combined + per-pattern per
          window), path-guard (per glob) and secret-scanner pay for EVERY guarded regex match.
          Two views: fresh-process first call (spawn cost) and a 25-call sequential in-process
          workload (the scanner shape).
commands: node .temp_files/perf-ratchet/sdk-redos-r2/run-guard.mjs 10   (children import the
          BUILT dist/runtime.js; dist rebuilt from HEAD before baseline AND after the change, so
          the only delta is the source edit)
baseline: first call median 19.32ms (18.12–22.38, n=10); warm workload median 18.10ms over 250
          calls; per-child median excl. first 18.02ms — flat, zero amortization (spawn per call).
hypothesis: a single reusable warm worker drops the amortized per-call cost below 2ms (message
          round-trip + µs-scale regex); first call stays ~19ms (one spawn still needed).
change:   ONE variable — worker lifecycle inside withReDoSGuard. Single-slot lazy warm pool:
          message-passing protocol ({id, source, flags, input} → {id, ok, match|error});
          worker ref()'d while in flight, unref()'d when parked idle; parked on success,
          terminated on budget expiry or worker error (a runaway regex still dies with its
          thread; the next call respawns); overlapping callers spawn their own worker. Public
          API, settle semantics, timeout classification: unchanged.
defect found mid-round (introduced by the change, fixed before verdict): per-call
          worker.once('error') listeners accumulated on the pooled worker — first suite run was
          green but emitted MaxListenersExceededWarning at call #11. Fixed by removing pending
          listeners in settle(); warning gone on the re-run.
after:    warm workload median 0.10ms over 250 calls (per-child excl. first: 0.10ms, max 0.14);
          first call median 21.72ms (18.84–28.70) — unchanged within the noise band vs 19.32.
verdict:  KEEP — amortized per-call 18.02 → 0.10ms median (−99.4%), ~90× outside the ~2ms band;
          first-call cost preserved within noise; both suites green (below).
tests:    plugin-sdk typecheck exit 0 · sdk.test.ts 3/3 (from repo root — `pnpm --filter
          @wrongstack/plugin-sdk test` collects nothing under its filtered cwd, use root vitest)
          · full plugins suite 122 files / 2696 passed / 2 skipped, run twice (before + after the
          listener fix; second run warning-free) · redos-guard.test.ts 7/7, path-guard 268,
          path-guard-redos 17, prompt-firewall 43 all green.
note:     singleton-per-bundle caveat (no code splitting in the sdk profile): if one process
          imported BOTH dist/runtime.js and dist/runtime/redos-guard.js, each bundle carries its
          own pool (worst case two idle workers). In-repo consumers import the barrel only.

## 2026-09-06 — plugin-sdk granular runtime export entries (round sdk-granular-r1, scope plugin-sdk package.json + build profile)
commit:   7edb58a8d base; the change is uncommitted in the worktree
machine:  AMD Ryzen 9 9950X3D 16-Core Processor / 32c / 126GB / win32 10.0.26200 / node 24.13.0
metric:   cold-import wall time for a single-symbol consumer through the REAL consumer chain
          (bare specifier resolved from the packages/plugins context → node_modules → pnpm
          symlink → exports map), fresh process, timed around await import() inside the child.
commands: node .temp_files/perf-ratchet/sdk-granular-r1/run-imports.mjs 10 baseline|after
          (children: node --input-type=module --eval <code> spawned via execFile argv with
          cwd=packages/plugins — see method note below)
baseline: barrel @wrongstack/plugin-sdk/runtime: median 38.33ms (36.86–48.47, n=10, 32 symbols)
hypothesis: a granular entry for a standalone leaf module (≤7KB bundle, node builtins only)
          cold-imports in <5ms — >85% below the barrel, far outside the ~12ms band; the barrel
          path itself must not regress (additive map entries).
change:   9 leaf export entries added to plugin-sdk package.json (./runtime/{bounded-map,
          credential-patterns, h1-state, handles, llm, local-bin, redos-guard, safe-json,
          sandbox}) + the same 9 esbuild entries in the sdk profile of scripts/build-package.mjs.
          Entry names map 1:1 onto src module paths, so tsc's per-module .d.ts lands exactly
          where each exports entry points — emitDeclarations skips its shim (natural === target);
          the kanban `manager/lifecycle` overwrite trap does not apply to this shape.
after:    barrel control 38.99ms (37.43–41.78) — +0.66ms vs baseline, unchanged within noise.
          granular /runtime/sandbox 5.22ms (4.95–5.36, 2 symbols);
          granular /runtime/redos-guard 4.83ms (4.47–5.04, 2 symbols).
          Granular max 5.36 sits far below barrel min 36.86 — full range separation.
hypothesis check: predicted <5ms; measured 4.83ms (redos-guard, on target) and 5.22ms
          (sandbox, 4% over) — recorded as a minor miss on one arm.
verdict:  KEEP — single-symbol cold import −86.4% (sandbox) / −87.4% (redos-guard); barrel
          unregressed.
tests:    plugin-sdk typecheck exit 0 · sdk.test.ts 3/3 · full plugins suite 122 files /
          2696 passed / 2 skipped (barrel path through the shims) · dist/runtime/redos-guard.d.ts
          read back as the real 69-line tsc declaration, not a shim.
method note (cost real time; do not repeat): stdin-fed eval children hang under promisified
          execFile `input`; a node_modules JUNCTION in the scratch dir is not honored by Node's
          ESM specifier walk. Working method: `--input-type=module --eval <code>` passed as
          execFile ARGV (no shell → no cmd.exe quoting issue) with cwd set to the consumer
          package.
follow-on (not done this round, out of scope): in-repo consumers still import the barrel —
          rewiring the 7 plugins/src/runtime shims (and hot plugin imports) to granular entries
          is the step that converts this into felt CLI/plugin-load win.
artifacts: .temp_files/perf-ratchet/sdk-redos-r2/ and sdk-granular-r1/ deleted after these
          entries (numbers above are the record).

## 2026-09-06 — plugins runtime shims rewired to granular entries (round plugins-rewire-r1, scope packages/plugins/src/runtime)
commit:   7edb58a8d base; the change is uncommitted in the worktree (6 leaf shims + index.ts doc)
machine:  AMD Ryzen 9 9950X3D 16-Core Processor / 32c / 126GB / win32 10.0.26200 / node 24.13.0
metric:   cold-import of a BUILT plugin entry (dist/prompt-firewall.js, 25KB, external bare
          imports resolved through packages/plugins/node_modules — the production-faithful
          graph), fresh process, timed around await import() inside the child. prompt-firewall is
          the hot provider-wire scanner and its only sdk imports are the two leaf shims.
commands: node .temp_files/perf-ratchet/plugins-rewire-r1/run-plugin.mjs 10   (dist rebuilt
          before each phase; artifact import specifiers READ BACK before any number was trusted)
baseline: prompt-firewall median 44.10ms (39.50–55.16, n=10); path-guard median 43.49ms
          (38.20–59.83, n=10). Noise band ≈ 16–22ms (repeat-run spread).
hypothesis: rewiring the leaf shims swaps prompt-firewall's entire sdk cost — one barrel chain
          (38.33ms standalone) — for two granular bundles (6.9kb + 3.6kb): expect ≤15ms.
change:   ONE variable — the import specifiers of the 6 leaf shims in packages/plugins/src/runtime
          (→ '@wrongstack/plugin-sdk/runtime/{credential-patterns,h1-state,handles,llm,
          redos-guard,sandbox}'). No plugin file edits needed: all 7 production leaf importers
          (prompt-firewall, path-guard/glob, test-generator, migration-planner,
          release-notes-generator, secret-scanner) go through the shims. index.ts deliberately
          STAYS on the barrel, documented in the file: withinProject, collectSourceFiles(Async),
          matchesExtension and the resolveRunnerCommand family are defined in the sdk barrel
          module itself — no granular home exists, and a mixed re-export would still load the
          barrel while instantiating duplicate leaf copies (split registries / symbol identity)
          for zero win.
incident (recorded honestly): the FIRST "after" run was INVALID and is discarded — shim edits
          were lost on disk during a concurrent peer session (3 files back at HEAD content with
          frozen mtimes), so the dist rebuild still imported the barrel; it measured 41.07ms,
          i.e. a baseline repeat inside noise. Fix: re-applied the lost edits, verified all 7
          shims on disk by content, rebuilt, and read back dist/prompt-firewall.js to confirm
          the granular specifiers BEFORE re-measuring. Lesson: verify the artifact reflects the
          change before trusting a number — a stale build makes a real win read as noise.
after (valid): prompt-firewall median 5.57ms (4.95–6.28, n=10) — −87.4%; ranges fully separated
          (after max 6.28 << before min 39.50). path-guard median 45.26ms (43.51–51.97) —
          +1.77ms, inside noise; attribution read from the artifact: dist/path-guard.js imports
          BOTH granular redos-guard AND the barrel (source line 11: `withinProject` from
          ../runtime/index.js — no granular home). Not a regression; structural.
verdict:  KEEP — primary entry −87.4%, ~4× the noise band with full range separation; secondary
          entry unchanged-within-noise for a known structural reason.
tests:    plugins typecheck exit 0 (granular specifiers resolve via exports-map `types`
          conditions) · full plugins suite 122 files / 2696 passed / 2 skipped / 0 failed —
          leaf-shim consumers included (redos-guard 7, path-guard 268 + redos 17,
          prompt-firewall 43, secret-scanner 46 + regression 37, credential-pattern-parity 42,
          h1-state 10, handles 7, sandbox 13, plugin-llm-runtime 7) · sdk.test.ts 3/3.
follow-on: extract the runner module (withinProject, collectSourceFiles*, matchesExtension,
          resolveRunnerCommand family) out of the sdk runtime barrel into its own module with a
          ./runtime/runner granular entry, then rewire index.ts consumers — that is what unlocks
          path-guard and the ~37 barrel-importing plugins.
artifacts: .temp_files/perf-ratchet/plugins-rewire-r1/ deleted after this entry
          (numbers above are the record).

## 2026-09-06 — runner-module extraction: attempted, REGRESSED/UNPROVEN, REVERTED (round sdk-runner-r1, scope plugin-sdk runtime + plugins shims)
commit:   worktree carries the kept rounds above; HEAD detached at 4e66210db (peer stash-aside incident)
machine:  AMD Ryzen 9 9950X3D 16-Core Processor / 32c / 126GB / win32 10.0.26200 / node 24.13.0
metric:   cold-import of dist/path-guard.js (the instruction's target) + dist/branch-guard.js as a
          barrel-consumer control (the shim rewire affects ~37 plugins the path-guard number cannot see).
commands: node .temp_files/perf-ratchet/sdk-runner-r1/run-plugin.mjs <entry> 10
diagnostics (quiet box, n=5): @wrongstack/core/utils standalone median 43.29ms (40.52–56.15, 209
          symbols) · plugin-sdk/runtime/local-bin 7.84ms · barrel control 46.75ms. Census: the ONLY
          production importer of the bare barrel is the plugins runtime/index.ts shim.
baseline (quiet box, 1 agent online): path-guard 42.33ms (40.18–50.82) · branch-guard 42.14ms
          (39.94–45.16), n=10 each. Bands ≈ 10.6 / 5.2ms.
hypothesis: extraction alone cannot win — runRunnerCommand requires `buildChildEnv` from
          @wrongstack/core/utils at module scope, so the runner graph inherits the dominant ~43ms;
          the split adds per-entry resolution on top of the same transitive chains. Run anyway per
          instruction: measurement beats prediction.
change:   extracted ALL runner definitions (types LanguageRuntime/RunOptions/RunResult/CollectOptions…,
          privates, sanitizeRunnerCommand family, withinProject, collectSourceFiles(Async),
          matchesExtension, locateRunnerEntry) from the sdk barrel into runtime/runner.ts (696 lines,
          verbatim); barrel slimmed to pure re-exports + `export * from './runner.js'`; ./runtime/runner
          export + build entries added; plugins runner shim created; path-guard → runner shim;
          plugins index.ts shim made granular-backed (runner + 9 leaves).
mid-round discovery: TS2308 — handles.ts AND h1-state.ts both export a type named `Unregister` with
          DIFFERENT shapes (handles: `(() => void) | null | undefined`; h1-state: `() => void`). The
          barrel resolves this implicitly in favour of handles; star-exporting both modules is a
          declaration-emit error (and silently drops the name in the JS build). Fixed via explicit
          named re-exports before measuring.
after:    path-guard 61.92ms (49.82–74.06) = +46% · branch-guard 52.24ms (50.21–54.93) = +24% — both
          worse, outside their bands.
revert +  everything reverted (sdk barrel restored byte-exact from the round workspace copy; runner.ts
attribution: deleted both sides; package.json/build entries removed; path-guard and the index.ts shim
          restored; dists rebuilt). Restoration verified by CONTENT read-back (barrel import present,
          runner artifacts gone) — and then the environment confessed: restored-state re-measurements
          came back 60.56 and 58.56ms, NOT the 42.33 baseline, on a box now at 60% CPU with 74 node
          processes and 5-6 peers online (vs 1 at baseline). The 42→~60ms shift is therefore largely
          ENVIRONMENTAL DRIFT, and the +46%/+24% attribution to the change is NOT established. What IS
          established: no win was demonstrable (best case under drift-adjustment the change matches
          baseline), and the structural analysis says no win exists to find while core/utils (~43ms)
          sits in the runner graph. Ratchet rule: keep only proven wins → REVERT stands.
verdict:  REVERTED (executed + content-verified). Do not retry the extraction until the blocker is
          fixed: (a) make @wrongstack/core/utils cheap to import (narrow entries / smaller graph in
          @wrongstack/core), or (b) lazy-load buildChildEnv inside runRunnerCommand (esbuild keeps
          dynamic imports of `external:` packages dynamic — verified against the build script's
          workspaceExternalPlugin note). The plugins index.ts shim carries a DO-NOT-RETRY note.
tests (post-revert tree): plugin-sdk typecheck exit 0 · plugins typecheck exit 0 · full plugins suite
          122 files / 2696 passed / 2 skipped / 0 failed · sdk.test.ts 3/3.
measurement lesson (recorded): baseline and after MUST share box load state — snapshot CPU load +
          peer count beside every ledger entry; a mid-round load shift invalidates attribution in
          BOTH directions. Content read-backs are the authoritative revert evidence when timing
          cannot be trusted.
artifacts: .temp_files/perf-ratchet/sdk-runner-r1/ deleted after this entry
          (numbers above are the record).

## 2026-09-06 — core/utils child-env narrow entry (round core-utils-r1, scope @wrongstack/core utils exports + plugin-sdk barrel import)
commit:   worktree carries the kept rounds. MID-ROUND INCIDENT: a peer stash
          ("aside-for-head-verification-2026-09-06", stash@{0}) silently wiped ALL kept perf work
          (pool, granular exports, shims, 5 PERF_LOG entries). Restored surgically via
          `git checkout stash@{0} -- <my 11 paths>` + unstaged — the stash itself left intact for its
          owner; fleet notified by mail. Marker-verified before continuing.
machine:  same box; load snapshots per protocol: snap A 73% CPU / 77 node (13:23) → snap B 7% /
          68 (13:26). Baseline window quiet and bracket-stable; an earlier partial baseline on the
          hot box (barrel 52–77ms) was discarded.
metric:   cold-import of @wrongstack/core/utils (209-symbol barrel) + the FELT arm
          dist/path-guard.js — the chain plugins pay: plugin → sdk barrel → core/utils.
commands: node .temp_files/perf-ratchet/core-utils-r1/run-bench.mjs 10 baseline|after
dominator (read + measured): dist/utils/index.js is only 10.5KB but fans out to ~15 shared root
          chunks (core builds with splitting:true) — that resolution+parse storm IS the ~41ms.
          Existing narrow entries (error 0.1KB, expect-defined 0.1KB) measure ~4.2ms.
baseline: core/utils barrel median 41.04ms (38.06–58.11, n=10) · narrow reference
          @wrongstack/core/utils/error 4.20ms (3.89–4.46) · felt path-guard 42.75ms (39.92–55.87)
          · drift-bracket barrel-end 39.00ms — window stable.
hypothesis: child-env.ts has ZERO imports (fully self-contained); a ./utils/child-env entry plus a
          one-line rewire of the sdk barrel's buildChildEnv import drops the felt arm to ≤12ms —
          the felt number (42.75) ≈ the barrel number (41.04) says core/utils IS the sdk-barrel path.
change:   (1) core package.json: ./utils/child-env export entry; (2) scripts/build-package.mjs
          coreEntries: src/utils/child-env.ts; (3) plugin-sdk/src/runtime/index.ts line 36:
          buildChildEnv import → '@wrongstack/core/utils/child-env' (single-occurrence verified;
          scripted needle swap after the edit tool's external-modification guard objected — the
          git-checkout restoration had invalidated its read state).
artifact anatomy (read back): dist/utils/child-env.js = 284-byte entry re-exporting 4 symbols
          (buildChildEnv, configureChildEnvGitIdentity, getChildEnvGitIdentity, sanitizeNodeOptions)
          from a 5KB shared chunk; sdk dist/runtime.js imports the narrow specifier.
after:    @wrongstack/core/utils/child-env 4.52ms (4.08–5.01, keys=4) · felt path-guard
          12.44ms (11.50–13.82) = −70.9% vs 42.75 baseline, full range separation
          (after max 13.82 << before min 39.92) · barrel control 44.88ms with bracket end
          41.28ms — unchanged within noise: the 209-symbol path is NOT regressed.
verdict:  KEEP — felt win ~30ms ≈ 2× the 16ms band with full range separation; hypothesis
          predicted ≤12ms, measured 12.44ms (on target).
tests:    core + plugin-sdk + plugins typechecks exit 0 · full plugins suite 122 files /
          2696 passed / 2 skipped · sdk.test.ts 3/3.
unlock note: this lands unlock (a) for the sdk-runner-r1 DO-NOT-RETRY — buildChildEnv now imports
          in ~4.5ms. The runner extraction is plausibly viable again but was NOT re-tested this
          round; treat it as a new hypothesis with a fresh round, not a blind retry.
artifacts: .temp_files/perf-ratchet/core-utils-r1/ deleted after this entry
          (numbers above are the record).

## 2026-09-06 — runner extraction re-attempt with narrow child-env import: SETTLED, REVERTED (round sdk-runner-r2)
commit:   base = f3e06512e + the PERF_LOG docs commit (protection commits landed FIRST — see incident)
machine:  same box; baseline window 20% CPU / 1 agent; after window noisier (bracket outliers to ~28ms)
metric:   cold-import of dist/path-guard.js (primary) + dist/branch-guard.js (barrel-consumer control) — identical
          bench shape to sdk-runner-r1 for comparability.
commands: node .temp_files/perf-ratchet/sdk-runner-r2/run-bench.mjs 10 baseline|after
protection commits (landed before the round): after a SECOND peer stash-wipe (new stash@{0}
          "WIP on main: 354b57b5b" captured all 13 kept files mid-session), recovered via
          `git checkout stash@{0} -- <paths>` + unstaged, fleet notified, then committed:
          f3e06512e perf(runtime) — 12 code files, forced into ONE commit by the core-public-api
          snapshot guard (all-or-nothing staging of API-surface inputs; peer webui-hq edits set
          aside surgically for the window and restored byte-identical after) — plus the PERF_LOG
          docs commit. Commit-first reordering is why this round's revert was a byte-exact
          `git checkout HEAD`.
baseline: path-guard 12.33ms (11.00–16.35, n=10) · branch-guard 10.87ms (9.85–24.92) ·
          bracket path-guard-end 12.56ms — window stable. Band ≈ 5.4ms.
change:   identical extraction shape to sdk-runner-r1 (runner.ts, 697 lines, verbatim barrel
          definitions) with ONE delta per the instruction: `buildChildEnv` imported from the
          NARROW '@wrongstack/core/utils/child-env' (4.52ms) instead of the core/utils barrel
          (41.04ms). Round-4 lessons applied from the start: explicit named re-exports in the
          plugins index shim (Unregister TS2308 seam), build-before-typecheck sequencing.
after:    path-guard 11.46ms (10.08–17.61) = −0.87ms — INSIDE the 5.4ms band.
          branch-guard 16.95ms (14.78–31.64) = +6.1ms — regression signal for multi-symbol
          consumers: ten granular specifier resolutions cost more than parsing one 35.6KB
          bundle. (Window noisier than baseline — bracket outliers ~28ms — but the control's
          distribution shift is directionally consistent with the sdk-runner-r1 result.)
verdict:  REVERT (executed byte-exact from HEAD; runner artifacts deleted both sides). The
          hypothesis is now SETTLED WITH DATA FROM BOTH DIRECTIONS: sdk-runner-r1 showed the
          extraction cannot win while buildChildEnv drags the 41ms core/utils barrel; this round
          shows that once that blocker is removed the win was ALREADY BANKED for every consumer
          by the narrow entry (sdk barrel ~8–10ms) and the extraction's residual upside (inline
          leaf parse, <1ms median) is inside the noise band while its 10-resolution shim
          regresses barrel consumers. The runner module stays in the barrel — by measurement,
          not by blocker.
mid-revert defect found & fixed: my earlier scripted note-edit had truncated the plugins
          runtime index.ts comment (Substring replacement cut the closing */ and the export
          statement) and that broken file rode into f3e06512e — advisory lint warnings do not
          block commits. Repaired to the intended content; a fix commit follows this entry.
restoration sanity: path-guard 10.55ms (9.79–11.75) · branch-guard 10.79ms (8.55–19.42) —
          baseline tier restored, bracket stable.
tests (final tree): core + plugin-sdk + plugins typechecks exit 0 · full plugins suite 122
          files / 2696 passed / 2 skipped · sdk.test.ts 3/3.
cumulative ladder (all measured 2026-09-06, all in PERF_LOG): guarded regex 18.02 → 0.10ms per
          call · single-symbol sdk import 38.3 → ~5ms · prompt-firewall entry 44.1 → 5.6ms ·
          barrel-consumer path-guard 42.8 → 12.4ms · core/utils child-env 41.0 → 4.5ms.
artifacts: .temp_files/perf-ratchet/sdk-runner-r2/ deleted after this entry
          (numbers above are the record).
