import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';

export default defineConfig({
  test: {
    maxWorkers: getVitestMaxWorkers(),
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
