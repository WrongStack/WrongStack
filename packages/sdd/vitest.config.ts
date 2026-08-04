import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@wrongstack/core/agent': path.resolve(__dirname, '../core/src/core'),
      '@wrongstack/core': path.resolve(__dirname, '../core/src'),
      '@wrongstack/core/kernel': path.resolve(__dirname, '../core/src/kernel'),
      '@wrongstack/core/types': path.resolve(__dirname, '../core/src/types'),
      '@wrongstack/core/coordination': path.resolve(__dirname, '../core/src/coordination'),
      '@wrongstack/core/execution': path.resolve(__dirname, '../core/src/execution'),
      '@wrongstack/core/utils': path.resolve(__dirname, '../core/src/utils'),
      '@wrongstack/core/security': path.resolve(__dirname, '../core/src/security'),
      '@wrongstack/core/storage': path.resolve(__dirname, '../core/src/storage'),
      '@wrongstack/core/models': path.resolve(__dirname, '../core/src/models'),
      '@wrongstack/core/skills': path.resolve(__dirname, '../core/src/skills'),
      '@wrongstack/core/plugin': path.resolve(__dirname, '../core/src/plugin'),
      '@wrongstack/core/defaults': path.resolve(__dirname, '../core/src/defaults'),
      '@wrongstack/core/infrastructure': path.resolve(__dirname, '../core/src/infrastructure'),
      '@wrongstack/core/tasking': path.resolve(__dirname, '../core/src/tasking'),
      '@wrongstack/core/worktree': path.resolve(__dirname, '../core/src/worktree'),
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
        // Barrel re-export and type-only modules — no runnable code
        'src/index.ts',
        'src/sdd-parallel-run-types.ts',
        // Re-export shim of Core's TaskTracker — no runnable code (the core
        // package owns the implementation; sdd only re-exports it for the
        // test suite and internal consumers).
        'src/task-tracker.ts',
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
