import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';

export default defineConfig({
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
        'src/index.ts',
        'src/sdk.ts',
        'src/v1.ts',
        'src/agent/index.ts',
        'src/client/index.ts',
        'src/types/**',
      ],
      thresholds: {
        lines: 95,
        functions: 98,
        branches: 90,
        statements: 95,
      },
    },
  },
});
