import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';

export default defineConfig({
  test: {
    maxWorkers: getVitestMaxWorkers(),
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Use the root setup for hermetic ~/.wrongstack (WRONGSTACK_HOME to temp dir)
    // and the SQLite ExperimentalWarning suppressor.
    setupFiles: ['../../vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: [
        // Barrel re-export — no runnable code
        'src/index.ts',
        'src/triage/index.ts',
        'src/sqlite-store-operations.ts',
        // Pure types
        'src/service-contract.ts',
        // Standalone daemon CLI binary entrypoint (spawned out-of-process)
        'src/project-server.ts',
      ],
      thresholds: {
        lines: 97,
        functions: 100,
        statements: 96,
        branches: 89,
      },
    },
  },
});
