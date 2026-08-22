/// <reference types="vitest/config" />

import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';

/**
 * Development-only Vite plugin that injects a `<meta name="wrongstack-ws-url">`
 * tag into `index.html` so the frontend connects to the correct WebSocket
 * backend instead of deriving `ws://127.0.0.1:3466` from the page origin.
 *
 * ### Why this exists
 *
 * SimpleUI uses a shared-port design: in production (`wstack --simpleui`) the
 * backend webui-server serves both the frontend **and** the WebSocket chat
 * protocol on the same port. The frontend's `defaultWsUrl()` (in `lib/ws.ts`)
 * derives the WS URL from `window.location.host`, which works because both
 * HTTP and WS ride the same server.
 *
 * In development, Vite serves the frontend on port 3466 but does **not** host
 * the WrongStack chat-protocol WebSocket — it only has its own HMR WebSocket.
 * Without this meta tag the frontend tries to open a chat WS to the Vite
 * server, which fails with "WebSocket connection failed".
 *
 * ### How to use
 *
 *   # Terminal 1: start the backend on a custom port (default 3466 is taken
 *   # by the Vite dev server in this workflow)
 *   wstack --simpleui --port 3467
 *
 *   # Terminal 2:
 *   WRONGSTACK_BACKEND_PORT=3467 pnpm dev
 *
 * When `WRONGSTACK_BACKEND_PORT` is unset, the meta tag defaults to port 3466,
 * which matches the production default — useful when the backend runs on the
 * default port and Vite uses a non-default port, or for CI smoke tests.
 *
 * ⚠️  Environment variables are read once when the Vite config module loads.
 * Changing `WRONGSTACK_BACKEND_PORT` or `WRONGSTACK_BACKEND_HOST` after the
 * dev server has started has no effect — restart the dev server to pick up
 * new values.
 */
function injectWsUrlPlugin(): Plugin {
  const backendPort = process.env['WRONGSTACK_BACKEND_PORT'] || '3466';
  const backendHost = process.env['WRONGSTACK_BACKEND_HOST'] || '127.0.0.1';
  const wsUrl = `ws://${backendHost}:${backendPort}`;
  const metaTag = `<meta name="wrongstack-ws-url" content="${wsUrl}" />`;
  return {
    name: 'inject-ws-url',
    // Only inject during `vite dev` — `vite build` must produce a clean
    // artifact that the production server can serve without a hardcoded WS URL.
    apply: 'serve',
    transformIndexHtml(html) {
      if (html.includes('name="wrongstack-ws-url"')) return html;
      return html.replace('</head>', `  ${metaTag}\n  </head>`);
    },
  };
}

export default defineConfig({
  plugins: [react(), injectWsUrlPlugin()],
  // `rehype-pretty-code` imports `getSingletonHighlighter` from the `shiki`
  // root, which would bundle all ~340 languages / ~100 themes (~10MB). The
  // shim re-exports `shiki/core` and serves the curated highlighter instead.
  resolve: {
    alias: [
      {
        find: /^shiki$/,
        // fileURLToPath yields a native ABSOLUTE path on every platform
        // (D:\… on Windows, /home/… on Linux). The previous
        // `.pathname.slice(1)` hack stripped the leading slash to appease
        // Windows, but produced a RELATIVE path on POSIX ("home/runner/…"),
        // which rolldown could not load and failed the CI build.
        replacement: fileURLToPath(new URL('./src/lib/shiki-shim.ts', import.meta.url)),
      },
    ],
  },
  test: {
    maxWorkers: getVitestMaxWorkers(),
  },
  server: {
    host: '127.0.0.1',
    port: 3466,
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:*",
        "font-src 'self' data:",
        "img-src 'self' data: https:",
        "object-src 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    },
    proxy: {
      // Proxy the /ws-auth cookie-exchange endpoint to the backend so the
      // HttpOnly cookie is set on the backend's loopback origin, which the
      // WS connection (pointed at the same backend origin via the meta tag
      // above) will then send automatically.
      // Note: this proxy does NOT strip the /ws-auth path prefix — it assumes
      // the backend mounts the route at root (i.e. the backend serves it as
      // `/ws-auth` directly). If the backend ever moves the route under a
      // prefix, add `rewrite: (p) => p.replace(/^\/ws-auth/, '/new-prefix/ws-auth')`.
      '/ws-auth': {
        target: `http://${process.env['WRONGSTACK_BACKEND_HOST'] || '127.0.0.1'}:${process.env['WRONGSTACK_BACKEND_PORT'] || '3466'}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('react-markdown') || id.includes('remark-gfm')) return 'markdown';
          if (id.includes('node_modules')) return 'vendor';
          return undefined;
        },
      },
    },
  },
});
