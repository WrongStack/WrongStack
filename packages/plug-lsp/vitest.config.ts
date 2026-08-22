import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';

export default defineConfig({
  test: {
    maxWorkers: getVitestMaxWorkers(),
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['../../vitest.setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      // Package-local dir — never share root monorepo coverage/.tmp.
      reportsDirectory: './coverage',
      reporter: ['text', 'json', 'json-summary'],
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/types.ts',
        'src/tools/codebase-lsp-search.ts',
        'src/tools/lsp-search.ts',
        'src/tools/codebase-index/index.ts',
        'src/auto-doc/ts-parser.ts',
        'src/auto-doc/rs-parser.ts',
        'src/auto-doc/go-parser.ts',
        'src/auto-doc/py-parser.ts',
        'src/auto-doc/sh-parser.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
      },
    },
  },
});
