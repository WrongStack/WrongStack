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
    //   - connect-src ws://…:* — ports auto-advance when 3456/3457 are taken
    //     (multiple instances), so pinning :3457 blocked the backend WS.
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
            if (id.includes('monaco-editor') || id.includes('@monaco-editor')) return 'monaco';
            if (id.includes('@xyflow')) return 'xyflow';
            if (id.includes('@xterm')) return 'xterm';
            if (id.includes('react-markdown') || id.includes('rehype-highlight') || id.includes('remark-gfm') || id.includes('highlight.js') || id.includes('lowlight') || id.includes('mdast') || id.includes('micromark') || id.includes('unified') || id.includes('hast')) return 'markdown';
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
