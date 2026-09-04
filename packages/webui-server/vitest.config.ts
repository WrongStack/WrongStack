import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { coreAliases } from '../../scripts/vitest-core-aliases.mjs';
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
      /**
       * Resolve @wrongstack/core from SOURCE, the way `packages/webui`'s
       * config already does.
       *
       * Without this the two suites disagree about what they are testing:
       * `webui/tests/server/**` (56 files that mirror this suite, plus three
       * genuine cross-package tests — see B-07) runs against core's src while
       * the same assertions here run against core's prebuilt dist. Two
       * consequences, both bad:
       *
       *   - a `vi.mock('@wrongstack/core/...')` boundary that holds in one
       *     suite silently does nothing in the other, because the module
       *     identity differs;
       *   - a core source change is covered by one suite and invisible to the
       *     other until someone rebuilds.
       *
       * It is also the precondition for consolidating the mirrored suite here:
       * moving those tests without this alias would flip 18 of them from
       * core-src to core-dist in the same commit that moved them, which is
       * exactly the kind of silent behaviour change a move should not carry.
       *
       * See docs/audit/webui-full-review-2026-09-03.md B-07.
       */
      ...coreAliases(path.resolve(__dirname, '../core')),
    },
  },
});
