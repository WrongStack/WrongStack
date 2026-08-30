import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';
import { coreAliases } from '../../scripts/vitest-core-aliases.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const coreDir = path.resolve(repoRoot, 'packages/core');

export default defineConfig({
  test: {
    maxWorkers: getVitestMaxWorkers(),
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: [
        // Barrel re-export — no runnable code
        'src/index.ts',
        // Type-only module — no runnable statements
        'src/types.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
      },
    },
  },
  resolve: {
    alias: {
      // Self-alias so tests can import from '@wrongstack/webui-protocol'.
      '@wrongstack/webui-protocol': path.resolve(__dirname, './src'),
      // @wrongstack/core sub-path exports must resolve to source (not dist)
      // because this package is browser-safe and must not reach for built
      // output at test time.
      ...coreAliases(coreDir),
    },
  },
});
