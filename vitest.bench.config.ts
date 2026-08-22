import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { getVitestMaxWorkers } from './vitest.workers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Separate config for `vitest bench` so the runner picks up `*.bench.ts`
 * files only when invoked explicitly (`pnpm bench`). Sharing the main
 * `vitest.config.ts` would either (a) run benches during `pnpm test`,
 * skewing wall-clock measurements, or (b) require an `exclude` pattern
 * that drifts every time a new bench file lands. Keeping it separate is
 * the cheap fix.
 *
 * The resolve aliases + hermetic setup mirror the root `vitest.config.ts`:
 * benches in packages/plugins import `@wrongstack/core` / `@wrongstack/tools`,
 * which must resolve from source (not a prebuilt dist/) in local and CI runs.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './packages/webui/src'),
      '@wrongstack/core': path.resolve(__dirname, './packages/core/src'),
      '@wrongstack/tools': path.resolve(__dirname, './packages/tools/src'),
      '@wrongstack/sdd': path.resolve(__dirname, './packages/sdd/src'),
      '@wrongstack/kanban': path.resolve(__dirname, './packages/kanban/src'),
      '@wrongstack/security-scanner': path.resolve(__dirname, './packages/security-scanner/src'),
    },
  },
  // Exclude typescript from SSR transform to prevent "invalid JS syntax" errors
  // when vite tries to process the bundled typescript.js file.
  ssr: {
    external: ['typescript', 'typescript/lib/typescript'],
  },
  test: {
    globals: false,
    environment: 'node',
    // Hermetic ~/.wrongstack per worker (see vitest.setup.ts).
    setupFiles: ['./vitest.setup.ts'],
    include: ['packages/**/bench/**/*.bench.ts', 'packages/**/tests/**/*.bench.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    pool: 'forks',
    maxWorkers: getVitestMaxWorkers(),
    // Benches do their own warmup + iterations; the outer test timeout
    // just has to be generous enough for a slow CI worker to finish.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    benchmark: {
      // JSON output so CI can upload as an artifact and a follow-up
      // workflow can diff against the main-branch baseline.
      outputJson: './bench-results.json',
      reporters: ['default'],
    },
  },
});
