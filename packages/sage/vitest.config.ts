import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
      ],
      thresholds: {
        100: true,
        perFile: true,
      },
    },
  },
});
