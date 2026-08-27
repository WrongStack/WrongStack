import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';
import { coreAliases } from '../../scripts/vitest-core-aliases.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Force @wrongstack/core to resolve from source during package-local tests
      // instead of following package exports to dist/.
      ...coreAliases(path.resolve(__dirname, '../core')),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // `status-bar-sgr.test.ts` pins raw `\x1b[38;2;253;159;2m` SGR — it
      // requires chalk to emit truecolor, which the default vitest worker
      // (non-TTY, no FORCE_COLOR/COLORTERM env) does not. It runs under its
      // dedicated config via `pnpm test:status-bar` (see
      // `vitest.status-bar-sgr.config.ts`), which sets those env vars —
      // applied package-wide they would break ~55 unrelated ink tests that
      // depend on the default non-color path. status-bar-overflow.test.ts
      // moved back into this config: since the 2026-08-27 rewrite it renders
      // via renderRealTty at controlled widths and asserts text only.
      'tests/status-bar-sgr.test.ts',
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ['../../vitest.setup.ts'],
    maxWorkers: getVitestMaxWorkers(),
  },
});
