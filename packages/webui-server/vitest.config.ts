import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      // Self-alias so tests can import from '@wrongstack/webui-server'
      // instead of using relative paths like '../src/server/...'.
      '@wrongstack/webui-server': path.resolve(__dirname, './src'),
    },
  },
});
