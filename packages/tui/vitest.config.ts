import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Force @wrongstack/core to resolve from source during package-local tests
      // instead of following package exports to dist/.
      '@wrongstack/core/agent': path.resolve(__dirname, '../../packages/core/src/core'),
      '@wrongstack/core': path.resolve(__dirname, '../../packages/core/src'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ['../../vitest.setup.ts'],
    maxWorkers: getVitestMaxWorkers(),
  },
});
