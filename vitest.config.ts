import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { coreAliases } from './scripts/vitest-core-aliases.mjs';
import { getVitestMaxWorkers } from './vitest.workers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // The `@` alias is webui-only (no other package uses it). Mapping it here lets
  // webui tests picked up by this root config (packages/**/tests/**) resolve
  // `@/...` imports the same way the webui Vite/vitest configs do.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './packages/webui/src'),
      // Force @wrongstack/core to resolve from source (packages/core/src) instead
      // of going through the package's "exports" field which points to dist/.
      // The dist/ output is only needed for published consumers; local vitest
      // workers (fork pool) need to import from source directly.
      ...coreAliases(path.resolve(__dirname, 'packages/core')),
      // Same for @wrongstack/tools: CLI tests import wiring that reaches the
      // tools package, and root Vitest must not require a prebuilt dist/.
      '@wrongstack/tools': path.resolve(__dirname, './packages/tools/src'),
      '@wrongstack/providers/definitions': path.resolve(
        __dirname,
        './packages/providers/src/provider-definitions.ts',
      ),
      '@wrongstack/providers': path.resolve(__dirname, './packages/providers/src'),
      '@wrongstack/runtime/probe': path.resolve(
        __dirname,
        './packages/runtime/src/local-llm-probe.ts',
      ),
      '@wrongstack/runtime': path.resolve(__dirname, './packages/runtime/src'),
      '@wrongstack/governance': path.resolve(__dirname, './packages/governance/src'),
      '@wrongstack/wrongtrace': path.resolve(__dirname, './packages/wrongtrace/src'),
      // Packages extracted from core (sdd/kanban/security-scanner) — the core
      // barrel re-exports from them, so every test importing core needs these
      // resolved from source as well.
      '@wrongstack/sdd': path.resolve(__dirname, './packages/sdd/src'),
      '@wrongstack/kanban': path.resolve(__dirname, './packages/kanban/src'),
      '@wrongstack/persistence': path.resolve(__dirname, './packages/persistence/src'),
      '@wrongstack/security-scanner': path.resolve(__dirname, './packages/security-scanner/src'),
      '@wrongstack/requirement-intake': path.resolve(
        __dirname,
        './packages/requirement-intake/src',
      ),
      // CLI tests re-export and exercise the extracted WebUI server. Resolve
      // it from source so a concurrent/stale package build cannot make the
      // root suite test an older dist bundle.
      '@wrongstack/webui-server': path.resolve(__dirname, './packages/webui-server/src'),
      // The plugins package's runtime shims re-export from the extracted SDK
      // (`@wrongstack/plugin-sdk/runtime`); resolve it from source the same
      // way so plugin tests exercise current SDK code, not a stale dist.
      '@wrongstack/plugin-sdk': path.resolve(__dirname, './packages/plugin-sdk/src'),
    },
  },
  // Exclude typescript from SSR transform to prevent "invalid JS syntax" errors
  // when vite tries to process the bundled typescript.js file.
  ssr: {
    external: ['typescript', 'typescript/lib/typescript'],
  },
  test: {
    globals: false,
    environment: 'node',
    // forks pool: each test file runs in a dedicated child process with
    // per-file isolation (Vitest 4 default for this pool). Prevents heap
    // accumulation across ~500 test files in this monorepo (the 'threads'
    // pool shares one process and runs OOM on large suites).
    // NOTE: the old `poolOptions.forks.singleFork` knob was removed in
    // Vitest 4 and had been silently ignored — do not reintroduce it.
    pool: 'forks',
    // Workers themselves must also get the 4 GB heap. `test.env.NODE_OPTIONS`
    // is only inherited by child processes spawned *inside* tests; fork
    // workers are already running by the time that env is read.
    execArgv: ['--max-old-space-size=4096'],
    // Cap fork workers explicitly. At Vitest's default (= all 32 logical cores
    // on the main development machine), spawn-heavy tests
    // (bash/git/biome/mock servers) starve:
    // each release:check run failed a different set with empty output, wrong
    // exit codes, or timeouts — all passing in isolation. Shells spawned BY
    // tests need free cores too, and live dev servers share this machine.
    //
    // Four workers leave headroom for test-spawned shells and shared dev
    // servers; watch mode uses two workers to stay responsive while editing.
    maxWorkers: getVitestMaxWorkers(),
    clearMocks: true,
    restoreMocks: true,
    // 5s (the default) flakes under full-suite load on this machine: with
    // ~16 fork workers competing, wiring-plugins / system-prompt-builder /
    // plug-lsp setup intermittently time out while passing in isolation.
    // 15s was still not enough for spawn-heavy tests (shell hooks, git,
    // tree-kill, biome) — every full run flaked a different set while all
    // passed in isolation. The ceiling only matters for genuinely hung
    // tests, so keep it generous.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Do not rerun an entire 40k-test gate because a loopback listener hit a
    // temporary OS resource limit. Vitest retries only the failed test, and
    // only for connection/bind failures; assertion and type regressions still
    // fail immediately. Keep this CI-only so local red/green feedback stays
    // literal while the shared runner gets a short recovery window.
    retry:
      process.env.CI === 'true'
        ? {
            count: 2,
            delay: 250,
            // `connect ENOENT` on a `\\.\pipe\wrongstack-session-catalog-*`
            // endpoint is one deliberate addition to the errno list above: on
            // Windows a named pipe that is not bound *yet* surfaces as ENOENT
            // rather than ECONNREFUSED, so no existing alternative can see it.
            // Measured 2026-09-09: 1 fatal occurrence across 10 iterations of
            // packages/cli/tests/hq-mailbox-mutation.test.ts run alongside
            // concurrent vitest load (~10%), green in isolation. It struck two
            // different cases with two different pipe hashes across
            // occurrences, i.e. a bind race hitting whichever test is in
            // flight, not a defect in one case.
            // Re-measured 2026-09-10: 17 fresh runs of this file — 5 serial
            // (26-29s each) and 12 under genuine concurrent vitest load (a
            // full-suite shard 1/3 running alongside, 33-63s each) — all
            // 527 tests green, zero error signatures (no `connect ENOENT
            // ...session-catalog` in any log). P(0 failures in 12 | p=0.10)
            // is ~0.28, so the no-show stays consistent with the ~10% rate;
            // the throwing site remains unidentified.
            // The pattern stays narrowed to
            // this pipe family on purpose — bare `ENOENT` would also retry
            // genuine missing-fixture bugs. This is a mitigation, NOT a
            // root-cause fix: the throwing site is still unidentified — the two
            // cross-project probe sites in session-catalog/registry.ts (:310 in
            // try/catch, :334 with .catch) already swallow this error, so
            // neither produced the fatal failure.
            // Related: `connectWithElection(spawnIfMissing=false)` no longer
            // breaks on its first connect failure; it retries while the daemon
            // that owns the endpoint is still alive (`ownerPidIsAlive`). Gating
            // on pid LIVENESS is not the same as gating on metadata PRESENCE,
            // and presence would be wrong: project-server.ts binds the endpoint
            // (L588) strictly BEFORE writing metadata (L608), so ENOENT with
            // metadata present means an owner that already bound and is leaving
            // (shutdown closes the endpoint at :550 before removing metadata at
            // :553) — waiting on it stalls exactly the fast-fail that
            // cross-project discovery needs, since it probes every known
            // project. ENOENT with metadata absent is no better: "no daemon"
            // and "daemon not yet bound" look identical, so presence has no
            // usable polarity in either state. Liveness does — a live pid names
            // a specific process that can still (re)bind, and no live owner is
            // precisely the absent-daemon case to fail fast on. It fails closed
            // (unreadable metadata = no owner), and probes never spawn, so a
            // dead owner yields no event to wait for. It does NOT cover the
            // cold-start pre-bind window, where no metadata exists yet; that
            // needs a pre-bind ownership marker. Hence this retry stays.
            condition:
              /ENOBUFS|EADDRINUSE|EADDRNOTAVAIL|EACCES|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|connect ENOENT.*session-catalog/i,
          }
        : 0,
    // Bump Node heap to 4 GB for child processes spawned BY tests (vitest
    // worker processes themselves don't re-read NODE_OPTIONS set here).
    env: {
      NODE_OPTIONS: '--max-old-space-size=4096',
    },
    // Hermetic ~/.wrongstack: redirects all global state to a per-worker temp
    // dir (WRONGSTACK_HOME) so tests never read the user's real config (live
    // Telegram tokens!) or leak fixture project dirs into the real home.
    setupFiles: ['./vitest.setup.ts'],
    // Reap detached project-server daemons a suite left bound to a temp dir.
    // They are spawned `detached` + unref'd, so nothing in the test process
    // owns them and a forgotten kill switch leaks one per run.
    globalSetup: ['./vitest.globalTeardown.ts'],
    // `.tsx` is included explicitly: the Ink component tests in tui/ and
    // simpleui/ are .tsx, and a `*.test.ts`-only glob silently skipped all of
    // them — they passed CI by never running.
    include: [
      'packages/**/tests/**/*.test.{ts,tsx}',
      'packages/**/src/**/__tests__/**/*.test.{ts,tsx}',
      'apps/**/tests/**/*.test.{ts,tsx}',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Scratch and stale-mirror copies under `.temp_files/**` (release-scoped
      // snapshots, bug-hunter fixtures) must never enter root-suite discovery:
      // they are not workspace members and fail to resolve `@wrongstack/*`
      // imports, surfacing as phantom Failed Suites. Unanchored on purpose —
      // mirrors live at `.temp_files/<scope>/packages/**/tests/**`.
      '**/.temp_files/**',
      // WebUI tests require jsdom + globals:true — run separately:
      //   cd packages/webui && pnpm test
      // or: pnpm --filter webui test
      'packages/webui/**',
      // hq-dashboard.test.ts requires jsdom environment which the root
      // forks pool may fail to resolve from the global vitest binary.
      // Run it with the CLI package's dedicated config — a bare standalone
      // run (`npx vitest run tests/hq-dashboard.test.ts` from packages/cli)
      // is dead: packages/cli/vitest.config.ts excludes this file too, so it
      // collects zero tests and exits 1 ("No test files found"). Verified
      // 2026-09-10:
      //   cd packages/cli && npx vitest run tests/hq-dashboard.test.ts --config vitest.hqdash.config.ts
      'packages/cli/tests/hq-dashboard.test.ts',
      // status-bar-sgr.test.ts pins the raw `\x1b[38;2;253;159;2m` orange
      // SGR, which needs chalk at truecolor level. The root forks worker is
      // non-TTY with no FORCE_COLOR/COLORTERM, so chalk resolves to level 0 and
      // strips the escape before ink-testing-library sees it — the assertion
      // fails. It runs under its dedicated config via
      // `pnpm --filter @wrongstack/tui test:status-bar`
      // (packages/tui/vitest.status-bar-sgr.config.ts), which sets those
      // env vars. Mirrors the exclude in packages/tui/vitest.config.ts.
      // (status-bar-overflow.test.ts was re-included here after its
      // 2026-08-27 renderRealTty rewrite dropped the SGR pins.)
      'packages/tui/tests/status-bar-sgr.test.ts',
    ],
    coverage: {
      // Vitest 4's AST-remapped V8 provider produces Istanbul-equivalent
      // reports without instrumenting every loaded module. The Istanbul
      // coordinator retained ~3.9 GB RSS across the 1,947-file root suite and
      // ran into the same 4 GB ceiling this gate is supposed to catch.
      provider: 'v8',
      // Isolated from package-level and scripts coverage dirs so a nested or
      // concurrent package run cannot wipe this suite's coverage/.tmp mid-run.
      reportsDirectory: 'coverage/root',
      reporter: ['text', 'json', 'json-summary', 'html'],
      reportOnFailure: true,
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.ts',
        '**/*.bench.ts',
        '**/tests/**',
        '**/dist/**',
        // grep.ts — ripgrep-specific code (rg detection, runRgStream, parseRgCountLine).
        // rg is not present on Windows by default; the entire rg path is unreachable
        // in standard CI. The native walk() path is well-tested.
        'packages/tools/src/grep.ts',
        // _env.ts — backward-compat re-export, no runnable code.
        'packages/tools/src/_env.ts',
        'packages/*/src/index.ts',
        '**/types/**',
        // Test helpers — only exist to support tests, not production code
        'packages/*/src/test-helpers/**',
        // CLI entry points — require interactive TTY, not testable in unit context
        'packages/cli/src/input-reader.ts',
        'packages/cli/src/repl.ts',
        'packages/cli/src/spinner.ts',
        // TUI entry/runtime — Ink render-tree wiring, exercised end-to-end
        'packages/tui/src/run-tui.ts',
        // Clipboard — depends on OS-level pasteboards (xsel/pbcopy/clip.exe)
        'packages/tui/src/clipboard.ts',
        // Runtime pack.ts is a pure TypeScript interface file — no runnable code
        'packages/runtime/src/pack.ts',
        // WebUI has a dedicated jsdom coverage run in packages/webui. Excluding
        // it here prevents the Node run from reporting the same files as 0%.
        'packages/webui/src/**',
        'packages/webui-hq/src/**',
        // WebUI server entry points require process/WebSocket binding.
        'packages/webui-server/src/server/index.ts',
        'packages/webui-server/src/server/entry.ts',
        // LSP search — the tool's own paths are covered by 11 unit tests in
        // packages/plug-lsp/tests/unit/codebase-lsp-search.test.ts (they run in
        // this suite). It stays excluded from the coverage NUMBER because the
        // remaining uncovered lines are the live-language-server branches the
        // mocks cannot reach, not because the file is untested. The previous
        // comment here said "integration-tested separately", which named an
        // integration test that does not exist.
        'packages/plug-lsp/src/tools/codebase-lsp-search.ts',
        // Tools shim — thin sqlite wrapper; exercised via integration tests
        'packages/tools/src/shim/**/*.ts',
        // Worker-thread bootstrap is exercised through the parser pool. V8
        // coverage from the child worker is not merged into the parent suite.
        'packages/tools/src/codebase-index/parser-worker-script.ts',
      ],
      // Aggregate ratchet: keep the expanded TS/TSX inventory covered without
      // pretending the existing workspace is already at 100% per file.
      // Bumped 2026-07-27 after adding 258+ tests across 10 packages covering
      // sage, runtime, kanban, techstack, providers, tools, and core modules.
      // Actual full-suite coverage: 76.81% lines, 66.7% branches, 75.84%
      // functions, 75.25% statements (26,842 tests, 304s).
      thresholds: {
        lines: 76,
        functions: 75,
        branches: 66,
        statements: 75,
        perFile: false,
      },
    },
  },
});
