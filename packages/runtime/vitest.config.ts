import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // @wrongstack/core/agent is a special subpath export that maps to
      // packages/core/src/core (the agent module), NOT to packages/core/src/agent
      '@wrongstack/core/agent': path.resolve(__dirname, '../core/src/core'),
      '@wrongstack/core/agent-catalog': path.resolve(
        __dirname,
        '../core/src/coordination/agents/index.ts',
      ),
      '@wrongstack/core': path.resolve(__dirname, '../core/src'),
    },
  },
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
        // Barrel re-export — no runnable code
        'src/index.ts',
        // Pure interface file — no runnable code
        'src/pack.ts',
      ],
      thresholds: {
        lines: 99,
        functions: 91,
        branches: 95,
        statements: 96,
      },
    },
  },
});
