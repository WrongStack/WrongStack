import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@wrongstack/tools': path.resolve(__dirname, '../tools/src'),
      '@wrongstack/tools/languages': path.resolve(__dirname, '../tools/src/languages'),
      '@wrongstack/core/agent': path.resolve(__dirname, '../core/src/core'),
      '@wrongstack/core': path.resolve(__dirname, '../core/src'),
    },
  },
  test: {
    maxWorkers: getVitestMaxWorkers(),
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    setupFiles: ['../../vitest.setup.ts'],
  },
});
