import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';
import { coreAliases } from '../../scripts/vitest-core-aliases.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      ...coreAliases(path.resolve(__dirname, '../core')),
    },
  },
  test: {
    maxWorkers: getVitestMaxWorkers(),
    include: ['tests/**/*.test.ts'],
    setupFiles: ['../../vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: [
        // Barrel re-export — no runnable code
        'src/index.ts',
        // Pure interface file — no runnable code
        'src/pack.ts',
      ],
      thresholds: {
        lines: 99,
        functions: 91,
        branches: 95,
        statements: 96,
      },
    },
  },
});
