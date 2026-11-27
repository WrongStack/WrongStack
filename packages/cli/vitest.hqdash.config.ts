import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { coreAliases } from '../../scripts/vitest-core-aliases.mjs';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';

// Dedicated config to run the carved-out hq-dashboard.test.ts (jsdom env),
// which the default cli/root configs exclude from the forks-pool run.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      ...coreAliases(path.resolve(__dirname, '../core')),
      '@wrongstack/tools': path.resolve(__dirname, '../../packages/tools/src'),
    },
  },
  test: {
    maxWorkers: getVitestMaxWorkers(),
    globals: false,
    environment: 'jsdom',
    include: ['tests/hq-dashboard.test.ts'],
    testTimeout: 60_000,
  },
});
