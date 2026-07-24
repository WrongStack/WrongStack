import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['../../vitest.setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
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
        100: true,
        perFile: true,
      },
    },
  },
});
