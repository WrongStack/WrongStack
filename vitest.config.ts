import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { coreAliases } from './scripts/vitest-core-aliases.mjs';
import { getVitestMaxWorkers } from './vitest.workers';

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
    include: ['packages/**/tests/**/*.test.{ts,tsx}', 'apps/**/tests/**/*.test.{ts,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // WebUI tests require jsdom + globals:true — run separately:
      //   cd packages/webui && pnpm test
      // or: pnpm --filter webui test
      'packages/webui/**',
      // hq-dashboard.test.ts requires jsdom environment which the root
      // forks pool may fail to resolve from the global vitest binary.
      // Run it separately: cd packages/cli && npx vitest run tests/hq-dashboard.test.ts
      'packages/cli/tests/hq-dashboard.test.ts',
      // status-bar-overflow.test.ts pins the raw `\x1b[38;2;253;159;2m` orange
      // SGR, which needs chalk at truecolor level. The root forks worker is
      // non-TTY with no FORCE_COLOR/COLORTERM, so chalk resolves to level 0 and
      // strips the escape before ink-testing-library sees it — the assertion
      // fails. It runs under its dedicated config via
      // `pnpm --filter @wrongstack/tui test:status-bar`
      // (packages/tui/vitest.status-bar-overflow.config.ts), which sets those
      // env vars. Mirrors the exclude in packages/tui/vitest.config.ts.
      'packages/tui/tests/status-bar-overflow.test.ts',
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
        // WebUI server entry points require process/WebSocket binding.
        'packages/webui-server/src/server/index.ts',
        'packages/webui-server/src/server/entry.ts',
        // LSP search — requires a live language server; integration-tested separately
        'packages/plug-lsp/src/tools/codebase-lsp-search.ts',
        'packages/plug-lsp/src/tools/lsp-search.ts',
        // Codebase index — requires real filesystem + sqlite; integration tested
        'packages/plug-lsp/src/tools/codebase-index/index.ts',
        // Tools shim — thin sqlite wrapper; exercised via integration tests
        'packages/tools/src/shim/**/*.ts',
        // Worker-thread bootstrap is exercised through the parser pool. V8
        // coverage from the child worker is not merged into the parent suite.
        'packages/tools/src/codebase-index/parser-worker-script.ts',
        // Language parsers — external-language support tested via integration
        'packages/plug-lsp/src/auto-doc/ts-parser.ts',
        'packages/plug-lsp/src/auto-doc/rs-parser.ts',
        'packages/plug-lsp/src/auto-doc/go-parser.ts',
        'packages/plug-lsp/src/auto-doc/py-parser.ts',
        'packages/plug-lsp/src/auto-doc/sh-parser.ts',
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
