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
  },
});
