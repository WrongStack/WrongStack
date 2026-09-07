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
      '@wrongstack/tools': path.resolve(__dirname, '../tools/src'),
      '@wrongstack/tools/languages': path.resolve(__dirname, '../tools/src/languages'),
    },
  },
  test: {
    maxWorkers: getVitestMaxWorkers(),
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    setupFiles: ['../../vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/service.ts',
        'src/types.ts',
        'src/adapters/interface.ts',
        'src/research/types.ts',
        'src/research/index.ts',
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 97,
        branches: 86,
      },
    },
  },
});
