import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from './vitest.workers.ts';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/core/tests/architecture/coverage-matrix-script.test.ts',
      'packages/core/tests/architecture/coverage-runtime.test.ts',
      'packages/core/tests/architecture/architecture-health-script.test.ts',
      'packages/core/tests/architecture/build-lineage-script.test.ts',
      'packages/core/tests/architecture/test-skip-budget-script.test.ts',
      'packages/core/tests/architecture/script-entrypoints.test.ts',
      'packages/core/tests/architecture/check-dep-path-separators.test.ts',
    ],
    maxWorkers: getVitestMaxWorkers(),
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: 'coverage/scripts',
      include: [
        'scripts/coverage-lock.mjs',
        'scripts/check-zero-coverage.mjs',
        'scripts/coverage-matrix.mjs',
        'scripts/test-coverage.mjs',
        'scripts/lib/architecture-health.mjs',
        'scripts/lib/build-lineage.mjs',
        'scripts/lib/test-inventory.mjs',
        'scripts/lib/test-skip-budget.mjs',
        'vitest.workers.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
        perFile: true,
      },
    },
  },
});
