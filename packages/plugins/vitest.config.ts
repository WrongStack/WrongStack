import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';

export default defineConfig({
  test: {
    maxWorkers: getVitestMaxWorkers(),
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: {
        lines: 94,
        functions: 95,
        statements: 91,
        branches: 79,
      },
    },
  },
});
