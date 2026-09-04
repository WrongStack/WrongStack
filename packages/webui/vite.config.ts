import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@wrongstack\/webui-server\/protocol$/,
        replacement: path.resolve(__dirname, '../webui-server/src/protocol/index.ts'),
      },
      {
        find: /^@wrongstack\/core\/agent-catalog$/,
        replacement: path.resolve(__dirname, '../core/src/coordination/agents/index.ts'),
      },
      {
        find: /^@wrongstack\/core\/models$/,
        // ME-4: ModelSchemaEditor runtime-imports MODELS_DEV_MODALITY_VALUES +
        // modelsDevModelSchema from the `@wrongstack/core/models` barrel, whose
        // bundled dist/models/index.js pulls node:fs/promises + node:path into
        // the browser. The schema module itself is browser-safe (zod + the
        // import-free deep-merge helper); type-only barrel imports are erased
        // before Vite resolves, so aliasing the subpath to the schema source
        // is safe (same pattern as @wrongstack/core/utils/error below).
        replacement: path.resolve(__dirname, '../core/src/models/models-dev-schema.ts'),
      },
      {
        find: /^@wrongstack\/core\/utils\/expect-defined$/,
        replacement: path.resolve(__dirname, '../core/src/utils/expect-defined.ts'),
      },
      {
        find: /^@wrongstack\/core\/execution\/prompt-enhancer$/,
        replacement: path.resolve(__dirname, '../core/src/execution/prompt-enhancer.ts'),
      },
      {
        find: /^@wrongstack\/core\/utils\/error$/,
        replacement: path.resolve(__dirname, '../core/src/utils/error.ts'),
      },
      {
        find: /^@wrongstack\/tools\/next-steps$/,
        replacement: path.resolve(__dirname, '../tools/src/next-steps.ts'),
      },
      // Browser-only: redirect the bare `@wrongstack/core` barrel (which drags
      // in Node built-ins) to a tiny browser-safe shim. Exact match only, so
      // subpath imports like `@wrongstack/core/storage` are left untouched.
      {
        find: /^@wrongstack\/core$/,
        replacement: path.resolve(__dirname, './src/lib/core-browser-shim.ts'),
      },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
  server: {
    port: 3456,
    host: '127.0.0.1',
    // NOTE: `server.headers` applies to the DEV server only — the production
    // CSP lives in src/server/http-server.ts (buildCspHeader) and stays
    // strict. Dev needs two relaxations:
    //   - script-src 'unsafe-inline': @vitejs/plugin-react injects an inline
    //     react-refresh preamble into index.html; `script-src 'self'` blocked
    //     it and the app crashed at boot with "can't detect preamble".
    //   - connect-src ws://…:* — ports auto-advance when 3456 is taken
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:*",
        "worker-src 'self' blob:",
        "font-src 'self' data:",
        "object-src 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    },
  },
  build: {
    // Monaco (ts.worker alone is ~4.4 MB minified) and the other heavy
    // lazy-loaded chunks trip Vite's default 500 kB warning. All of these
    // are split into their own groups below and only fetched when the
    // corresponding view is opened (React.lazy), so the raw size is
    // expected — raise the threshold instead of silencing per-chunk.
    chunkSizeWarningLimit: 4500,
    rollupOptions: {
      output: {
        // ── Chunking ────────────────────────────────────────────────────
        //
        // This is Rolldown's NATIVE `codeSplitting.groups`, not the
        // rollup-compat `manualChunks(id)` function. The switch is not
        // cosmetic: under Vite 8 / Rolldown, `manualChunks` is advisory.
        // A name it returns can be silently ignored and the module placed
        // elsewhere, which is how a 1 kB helper ended up costing every
        // visitor 4.4 MB — see the `vite-preload` group below. Returning
        // 'vite-preload' from `manualChunks` for that module changed the
        // output by not one byte; the group here does exactly what it says.
        //
        //   vite-preload → Vite's dynamic-import runtime (see below)
        //   react-core   → react / react-dom / scheduler, one shared copy
        //   monaco       → ~4.4 MB, Files editor + diff views only
        //   xyflow       → ~180 KB, OfficeMap + SddFlowGraph + Kanban graph
        //   xterm        → ~330 KB, integrated terminal only
        //   markdown     → react-markdown + micromark/hast/highlight.js
        //   vendor       → everything else from node_modules
        //
        // Groups are tried in order; the first whose `test` matches a module
        // id claims it, so the narrow rules must precede `vendor`.
        codeSplitting: {
          // No floor. A group smaller than `minSize` gets merged back into a
          // neighbour, and `vite-preload` is ~1 kB — the whole point of that
          // group is that it stays its own chunk no matter how small.
          minSize: 0,
          groups: [
            {
              // Vite's `__vitePreload` helper: the runtime every dynamic
              // `import()` call site compiles down to. Its module id is
              // virtual (`vite/preload-helper.js`, no node_modules), so it
              // fell through to Rolldown's automatic placement, which parked
              // it INSIDE the monaco chunk — the chunk with by far the most
              // dynamic imports.
              //
              // Consequence: every chunk that lazy-imports anything, the
              // eager entry and the i18n chunk included, had to statically
              // import the 4.4 MB / 1.12 MB-gzip monaco chunk just to reach
              // the helper. Vite therefore wrote
              // `<link rel="modulepreload" href="…/monaco-*.js">` into
              // index.html and EVERY page load downloaded the editor —
              // for every user, whether or not they ever opened Files or a
              // diff. Every Monaco consumer in src is correctly behind
              // `React.lazy`; the leak was purely this chunk assignment.
              //
              // Measured: eager bytes named by index.html 7,613 kB → 3,355 kB.
              // See docs/audit/webui-full-review-2026-09-03.md B-18.
              name: 'vite-preload',
              test: /vite\/preload-helper/,
              priority: 100,
            },
            {
              // React must exist exactly ONCE across all chunks. A second
              // copy has its own dispatcher internals, so any component
              // importing from the chunk that carries the duplicate throws
              // React error #310 ("Rendered more hooks than during the
              // previous render").
              //
              // The old `manualChunks` guard was `id.includes('react')`,
              // which is far wider than the three packages it needs: every
              // node_modules path containing the substring was pinned into
              // the eager vendor chunk — `@monaco-editor/react`,
              // `@xyflow/react`, `react-markdown`, react-i18next,
              // @tanstack/react-virtual and every @radix-ui/react-*. Those
              // libraries belong with their own feature chunk; they still
              // import React from here, so there is still one instance.
              //
              // The `.pnpm/<name>@<version>/node_modules/` middle segment is
              // matched explicitly because pnpm's virtual store puts the
              // real package behind a second `node_modules/`.
              name: 'react-core',
              test: /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(react|react-dom|scheduler)\//,
              priority: 90,
            },
            {
              name: 'monaco',
              test: /node_modules\/.*(monaco-editor|@monaco-editor)/,
              priority: 80,
            },
            { name: 'xyflow', test: /node_modules\/.*@xyflow/, priority: 70 },
            { name: 'xterm', test: /node_modules\/.*@xterm/, priority: 60 },
            {
              name: 'markdown',
              test: /node_modules\/.*(react-markdown|rehype-highlight|remark-gfm|highlight\.js|lowlight|mdast|micromark|unified|hast)/,
              priority: 50,
            },
            { name: 'vendor', test: /node_modules/, priority: 10 },
          ],
        },
      },
    },
  },
  define: {
    // NODE_ENV is set by Vite; 'development' only when in dev mode.
    // In production builds this resolves to false, keeping dev-only
    // code paths inactive in the browser bundle.
    __DEV__: JSON.stringify(process.env.NODE_ENV === 'development'),
  },
});
