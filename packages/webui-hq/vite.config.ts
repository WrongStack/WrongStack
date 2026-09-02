/// <reference types="vitest/config" />

import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { getVitestMaxWorkers } from '../../vitest.workers.ts';

// HQ dashboard — offline React app served by the HQ server (port 3499).
// No CDN dependencies; everything bundles into dist/ for LAN/offline use.
//
// Tailwind v4 runs as a Vite plugin — there is no tailwind.config.js and no
// PostCSS config, matching `packages/webui`. The design tokens live in
// `src/styles/tokens.css`, a verbatim mirror of the WebUI palette guarded by
// `tests/design-tokens-parity.test.ts`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    maxWorkers: getVitestMaxWorkers(),
  },
  base: '/',
  // React 19 requires modern browsers; esbuild's default browser targets
  // (es2020/chrome87) can't transform its destructuring patterns.
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'esnext',
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules[\\/](react|react-dom)[\\/]/.test(id)) return 'vendor';
          if (/node_modules[\\/](react-markdown|remark-gfm|rehype-highlight)[\\/]/.test(id))
            return 'markdown';
          if (id.includes('node_modules/lucide-react/')) return 'icons';
          if (id.includes('node_modules/@radix-ui/')) return 'radix';
          if (id.includes('node_modules/@xyflow/')) return 'xyflow';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5174,
    host: '127.0.0.1',
  },
});
