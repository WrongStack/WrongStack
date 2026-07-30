import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';

// Dedicated config to run the carved-out hq-dashboard.test.ts (jsdom env),
// which the default cli/root configs exclude from the forks-pool run.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@wrongstack/core/agent-catalog': path.resolve(
        __dirname,
        '../../packages/core/src/coordination/agents/index.ts',
      ),
      '@wrongstack/core/agent': path.resolve(__dirname, '../../packages/core/src/core/index.ts'),
      '@wrongstack/core': path.resolve(__dirname, '../../packages/core/src'),
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
