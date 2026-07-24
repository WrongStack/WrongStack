import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Exclude typescript from the SSR transform (same fix as the root
  // vitest.config.ts): typescript.js declares a sourceMappingURL but the npm
  // package ships no .map file, so vite logs an ENOENT sourcemap warning on
  // every run when the aliased-from-source packages pull it into the graph.
  ssr: {
    external: ['typescript', 'typescript/lib/typescript'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // A handful of server suites spawn real `git` / worktree processes
    // (git-handlers, worktree-ws-handler). Each passes comfortably in
    // isolation, but under the full 200+ file suite the box is CPU-starved
    // and those spawns miss vitest's default ceilings (test 5s / hook 10s) —
    // surfacing as spurious timeouts that abort `release:check`'s `pnpm test`
    // step. Raise the ceilings so load, not a real hang, no longer fails the
    // release. See memory: full-suite-load-flakes.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      reportOnFailure: true,
      // Enforce coverage across the whole WebUI source, not just src/lib.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.*',
        '**/dist/**',
        'src/env.d.ts',        // ambient type declarations only
        'src/main.tsx',        // ReactDOM bootstrap entry — exercised by E2E
        'src/lib/core-browser-shim.ts', // side-effect polyfill shim
        'src/server/entry.ts', // process/bootstrap entry — exercised at runtime
      ],
      // Aggregate WebUI ratchet. Per-file 100% is not yet representative of the
      // existing component inventory; keep the measured floor non-regressing.
      thresholds: {
        statements: 19,
        branches: 16,
        functions: 17,
        lines: 19,
        perFile: false,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Force @wrongstack/core to resolve from source (packages/core/src) instead
      // of going through the package's "exports" field which points to dist/.
      '@wrongstack/core/agent-catalog': path.resolve(
        __dirname,
        '../../packages/core/src/coordination/agents/index.ts',
      ),
      '@wrongstack/core/agent': path.resolve(__dirname, '../../packages/core/src/core'),
      '@wrongstack/core': path.resolve(__dirname, '../../packages/core/src'),
      '@wrongstack/kanban': path.resolve(__dirname, '../../packages/kanban/src'),
      '@wrongstack/sdd': path.resolve(__dirname, '../../packages/sdd/src'),
      // Force @wrongstack/webui-server to resolve from source (its src/) instead
      // of the published dist bundle, so per-module vi.mock() boundaries and
      // partial @wrongstack/core / node:fs mocks work exactly as they did when
      // these suites imported ../../src/server/* before the PR-018b extraction.
      '@wrongstack/webui-server': path.resolve(__dirname, '../../packages/webui-server/src'),
      '@wrongstack/tools/tool-icons': path.resolve(__dirname, '../../packages/tools/src/tool-icons.ts'),
      '@wrongstack/tools/next-steps': path.resolve(__dirname, '../../packages/tools/src/next-steps.ts'),
      '@wrongstack/tools/auto-proceed-loop-guard': path.resolve(
        __dirname,
        '../../packages/tools/src/auto-proceed-loop-guard.ts',
      ),
    },
  },
});
