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
    // are intentionally split via manualChunks below and only fetched when
    // the corresponding view is opened (React.lazy), so the raw size is
    // expected — raise the threshold instead of silencing per-chunk.
    chunkSizeWarningLimit: 4500,
    rollupOptions: {
      output: {
        // Split heavy libraries into separate cacheable chunks. These pair
        // with `React.lazy` in App.tsx so the editor / terminal / flow graph
        // code is only downloaded when the user actually opens that view.
        //   monaco  → ~3-4 MB, only needed for the Files editor + diff views
        //   xyflow  → ~250 KB, only needed for OfficeMap + SddFlowGraph
        //   xterm   → ~150 KB, only needed for the integrated terminal
        //   markdown→ react-markdown + rehype-highlight (~100 KB), chat only
        //   vendor  → everything else from node_modules
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // Keep React/React-DOM/Scheduler in the vendor chunk so all
            // components share one React instance.  The markdown chunk
            // (react-markdown + its micromark/unified/hast dependencies) can
            // pull React as a transitive peer, which would create a *second*
            // React instance — its hooks (useRef, useState, …) would have
            // their own __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN, causing
            // React error #310 ("Rendered more hooks than during the previous
            // render") in any component that statically imports from that
            // chunk (e.g. KanbanView → markdown).
            if (id.includes('react') || id.includes('scheduler')) return 'vendor';
            if (id.includes('monaco-editor') || id.includes('@monaco-editor')) return 'monaco';
            if (id.includes('@xyflow')) return 'xyflow';
            if (id.includes('@xterm')) return 'xterm';
            if (
              id.includes('react-markdown') ||
              id.includes('rehype-highlight') ||
              id.includes('remark-gfm') ||
              id.includes('highlight.js') ||
              id.includes('lowlight') ||
              id.includes('mdast') ||
              id.includes('micromark') ||
              id.includes('unified') ||
              id.includes('hast')
            )
              return 'markdown';
            return 'vendor';
          }
          return undefined;
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
