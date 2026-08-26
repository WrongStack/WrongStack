import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';
import { coreAliases } from '../../scripts/vitest-core-aliases.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  test: {
    maxWorkers: getVitestMaxWorkers(),
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@wrongstack/cli': path.resolve(repoRoot, 'packages/cli/src'),
      ...coreAliases(path.resolve(repoRoot, 'packages/core')),
    },
  },
});
