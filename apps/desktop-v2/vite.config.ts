import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        // Project surfaces shared with the WebUI, compiled from source.
        find: /^@wrongstack\/project-surfaces\/(.*)$/,
        replacement: path.resolve(here, '../../packages/project-surfaces/src/$1'),
      },
      {
        // The SAGE kind vocabulary the surfaces read; dependency-free, as in the WebUI.
        find: /^@wrongstack\/core\/utils\/sage-kinds$/,
        replacement: path.resolve(here, '../../packages/core/src/utils/sage-kinds.ts'),
      },
    ],
    dedupe: ['react', 'react-dom', 'react-i18next', 'i18next'],
  },
  css: { postcss: {} },
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  clearScreen: false,
  build: { target: 'es2022' },
});
