import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { coreAliases } from '../../scripts/vitest-core-aliases.mjs';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Force selected workspace packages to resolve from source instead of
      // going through each package's "exports" field which points to dist/.
      // CLI tests import both @wrongstack/core and @wrongstack/tools; resolving
      // them from source keeps the test environment independent from prebuilt
      // sibling dist/ artifacts.
      ...coreAliases(path.resolve(__dirname, '../core')),
      '@wrongstack/tools': path.resolve(__dirname, '../../packages/tools/src'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    restoreMocks: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // hq-dashboard.test.ts requires jsdom environment which the forks pool
      // may fail to resolve from the global vitest binary. Run it separately.
      'tests/hq-dashboard.test.ts',
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Hermes ~/.wrongstack: redirect global state to per-worker temp dir so
    // tests never read the user's real config or leak fixture project dirs.
    setupFiles: ['../../vitest.setup.ts'],
    // Rebuild @wrongstack/sage when its dist entry is unresolvable (transient
    // peer-build windows made suite loads fail with resolution errors).
    globalSetup: ['./tests/sage-build-guard.global-setup.ts'],
    // Cap workers to prevent spawn-heavy tests from starving.
    maxWorkers: getVitestMaxWorkers(),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/types.ts',
        'src/auth-menu/types.ts',
        'src/auth-menu/index.ts',
        'src/multi-agent.ts',
        'src/pre-launch.ts',
        'src/vibe-protocol-wiring.ts',
        'src/wiring/sage.ts',
        'src/wiring/vector-memory-setup.ts',
        'src/wiring/tui-memory-counters.ts',
        'src/wiring/wrongtrace-gate.ts',
        'src/wiring/wrongtrace-hooks.ts',
        'src/webui-server/context-breakdown.ts',
        'src/webui-server/cost-helpers.ts',
        'src/webui-server/kanban-run-mirror.ts',
        'src/webui-server/kanban-supervisor.ts',
        'src/webui-server/lifecycle.ts',
        'src/webui-server/static-serve.ts',
        'src/webui-server/status-bar-coalescer.ts',
      ],
      thresholds: {
        lines: 72,
        statements: 70,
        functions: 70,
        branches: 61,
      },
    },
  },
});
