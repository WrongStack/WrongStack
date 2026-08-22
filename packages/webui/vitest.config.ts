import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { coreAliases } from '../../scripts/vitest-core-aliases.mjs';
import { getVitestMaxWorkers } from '../../vitest.workers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Shared resolver + SSR config. Inline vitest projects do NOT inherit the
// root `resolve`/`ssr` blocks: without repeating them here, subpath imports
// (`@wrongstack/webui-server/server/*`) fall through to the package exports
// map (no such subpaths exist), `@/*` imports from src/ stop resolving, and
// barrel imports silently load the prebuilt dist instead of src.
const sharedSsr = {
  // typescript.js declares a sourceMappingURL but the npm package ships no
  // .map file — excluding it from the transform silences the ENOENT
  // sourcemap warning (same fix as the root vitest.config.ts).
  external: ['typescript', 'typescript/lib/typescript'],
};

const sharedResolve = {
  alias: {
    '@': path.resolve(__dirname, './src'),
    // Force @wrongstack/core to resolve from source (packages/core/src) instead
    // of going through the package's "exports" field which points to dist/.
    ...coreAliases(path.resolve(__dirname, '../core')),
    '@wrongstack/kanban': path.resolve(__dirname, '../../packages/kanban/src'),
    '@wrongstack/sdd': path.resolve(__dirname, '../../packages/sdd/src'),
    // governance: resolve from source like kanban/sdd. Through node_modules it
    // reaches packages/governance/dist, whose `node:sqlite` import
    // (event-store.ts) vite's jsdom client environment cannot bundle on CI.
    '@wrongstack/governance': path.resolve(__dirname, '../../packages/governance/src'),
    // Force @wrongstack/webui-server to resolve from source (its src/) instead
    // of the published dist bundle, so per-module vi.mock() boundaries and
    // partial @wrongstack/core / node:fs mocks work exactly as they did when
    // these suites imported ../../src/server/* before the PR-018b extraction.
    '@wrongstack/webui-server': path.resolve(__dirname, '../../packages/webui-server/src'),
    '@wrongstack/tools/tool-diff': path.resolve(__dirname, '../../packages/tools/src/tool-diff.ts'),
    '@wrongstack/tools/tool-icons': path.resolve(
      __dirname,
      '../../packages/tools/src/tool-icons.ts',
    ),
    '@wrongstack/tools/next-steps': path.resolve(
      __dirname,
      '../../packages/tools/src/next-steps.ts',
    ),
    '@wrongstack/tools/auto-proceed-loop-guard': path.resolve(
      __dirname,
      '../../packages/tools/src/auto-proceed-loop-guard.ts',
    ),
  },
};

export default defineConfig({
  ssr: sharedSsr,
  test: {
    maxWorkers: getVitestMaxWorkers(),
    // Two projects split by environment. tests/server suites exercise the
    // webui-server backend (HTTP routes, WS handlers, stores) and need no
    // DOM — but their import graph reaches @wrongstack/governance, whose
    // `node:sqlite` import (an experimental builtin) is REJECTED by vite's
    // jsdom client-environment bundler on Linux CI ("Cannot bundle Node.js
    // built-in", run 31799552021: 49 suites failed collection). Node
    // environments externalize builtins, so the same graph loads cleanly.
    // vitest 4 removed environmentMatchGlobs — projects is the replacement.
    projects: [
      {
        // Inline projects do not inherit root resolve/ssr — repeat them.
        resolve: sharedResolve,
        ssr: sharedSsr,
        test: {
          name: 'server-node',
          environment: 'node',
          include: ['tests/server/**/*.test.{ts,tsx}'],
          globals: true,
          // Server suites spawn real `git`/worktree child processes; keep the
          // raised ceilings so load, not a hang, never fails the run.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        resolve: sharedResolve,
        ssr: sharedSsr,
        test: {
          name: 'browser-jsdom',
          environment: 'jsdom',
          include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
          // Keep the two projects disjoint: server suites belong to node.
          exclude: ['tests/server/**', '**/node_modules/**', '**/dist/**'],
          globals: true,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // Package-local dir — never share root monorepo coverage/.tmp.
      reportsDirectory: './coverage',
      reporter: ['text', 'json', 'json-summary', 'html'],
      reportOnFailure: true,
      // Enforce coverage across the whole WebUI source, not just src/lib.
      //
      // `all: false` + this include keeps the report to files this run is
      // actually responsible for. The `@wrongstack/webui-server` alias below
      // resolves that package from source, so without the explicit exclude
      // its ~10k statements land in this report at near-0% — they are covered
      // by `packages/webui-server/tests` under the ROOT vitest config, not
      // here. That double-count is what made the generated coverage audit
      // list every webui-server route as "completely untested" when e.g.
      // ws-utils.ts is at 95% and zip.ts at 99% in its own run.
      //
      // This mirrors the root vitest.config.ts, which excludes
      // `packages/webui/src/**` for exactly the same reason in reverse.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.*',
        '**/dist/**',
        'src/env.d.ts', // ambient type declarations only
        'src/vite-env.d.ts', // ambient type declarations only
        'src/main.tsx', // ReactDOM bootstrap entry — exercised by E2E
        'src/lib/core-browser-shim.ts', // side-effect polyfill shim
        'src/server/entry.ts', // process/bootstrap entry — exercised at runtime
        // Type-only modules: interfaces and unions with zero runtime code. v8
        // reports them as 0/0 which the aggregate ratchet then reads as a real
        // gap. The root vitest.config.ts already excludes `**/types/**` for the
        // same reason — this mirrors it for the WebUI's own type surface.
        'src/types/**',
        'src/types.ts', // barrel: `export * from './types/*'`
        'src/protocol-compatibility.ts', // compile-time AssertNever bridge only
        // Measured by packages/webui-server/tests under the root config —
        // see the include comment above.
        '../webui-server/**',
        '**/packages/webui-server/**',
      ],
      // Aggregate WebUI ratchet. Per-file 100% is not yet representative of the
      // existing component inventory; keep the measured floor non-regressing.
      //
      // Raised 2026-07-29. Two things moved the number:
      //   1. The exclude list above stopped counting `../webui-server/**` and
      //      the type-only modules, so the denominator now reflects code this
      //      suite is actually responsible for (33,824 → 22,949 statements).
      //   2. ~430 new tests across lib/, stores/, hooks/ and the SetupScreen +
      //      AgentOfficeView helpers.
      // Measured: 45.76% statements, 37.73% branches, 39.2% functions,
      // 46.85% lines. Floors set just under to absorb ordinary jitter.
      //
      // Raised again after covering the ws-handler dispatch maps
      // (files-mailbox, fleet, techstack, misc) and useGlobalKeyboardShortcuts.
      // Measured: 47.71% statements, 39.89% branches, 40.03% functions,
      // 48.95% lines.
      //
      // Raised once more after finishing the dispatch layer (ws-handlers.ts,
      // session-handlers provider/delegate/context, chat-handlers tool
      // lifecycle) and useDesktopBridge.
      // Measured: 49.84% statements, 41.7% branches, 41.1% functions,
      // 51.27% lines.
      //
      // Raised after the non-component tail (small stores, lib leaf modules,
      // ChatInput/image-attachments, slash-routing branches).
      // Measured: 50.61% statements, 42.2% branches, 41.42% functions,
      // 52.1% lines.
      //
      // Raised after ws-client-actions, useWebSocket and the native
      // paste/drop interception path.
      // Measured: 51.13% statements, 42.45% branches, 42.61% functions,
      // 52.63% lines.
      //
      // Raised after the ws-handlers dispatch tail (session.start branches,
      // the inline WS_HANDLERS entries incl. the codemap overlay) and the
      // fleet/kanban/ui/viz/chat store surfaces.
      // Measured: 52.46% statements, 44.03% branches, 44.38% functions,
      // 53.93% lines.
      //
      // Raised after the ws-client socket lifecycle (auth cookie, connect
      // timeout, frame rejection), the useWebSocket delegation surface, and
      // kanban-cleaner / auto-submit-streak / CommandPalette export-utils.
      // Measured: 52.95% statements, 44.46% branches, 44.93% functions,
      // 54.35% lines.
      //
      // Raised after the first two rendered-component suites
      // (SessionWatchPanel, QuickModelSwitcher) — the start of the `.tsx`
      // render-tree work that is now the bulk of the remainder.
      // Measured: 53.97% statements, 45.24% branches, 45.83% functions,
      // 55.38% lines.
      thresholds: {
        statements: 53,
        branches: 44,
        functions: 45,
        lines: 55,
        perFile: false,
      },
    },
  },
});
