import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@wrongstack/core': path.resolve(__dirname, '../core/src'),
      '@wrongstack/core/utils': path.resolve(__dirname, '../core/src/utils'),
    },
  },
  test: {
    maxWorkers: getVitestMaxWorkers(),
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    setupFiles: ['../../vitest.setup.ts'],
  },
});
