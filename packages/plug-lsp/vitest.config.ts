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
      // `codebase-lsp-search.ts` is excluded from the 100% threshold, not from
      // testing: tests/unit/codebase-lsp-search.test.ts covers it with 11 cases.
      // What the mocks cannot reach are the branches that need a live language
      // server, and holding the file to 100% would force those to be faked.
      exclude: ['src/index.ts', 'src/types.ts', 'src/tools/codebase-lsp-search.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 100,
      },
    },
  },
});
