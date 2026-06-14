import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/main.tsx',
    types: 'src/types.ts',
    'server/entry': 'src/server/entry.ts',
    'server/index': 'src/server/index.ts',
  },
  format: ['esm'],
  target: 'es2022',
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  dts: true,
  external: [
    'react',
    'react-dom',
    '@wrongstack/core',
    '@wrongstack/providers',
    '@wrongstack/runtime',
    '@wrongstack/tools',
    'tailwindcss',
    './index.css',
    '@fontsource-variable/ibm-plex-sans',
    '@fontsource/ibm-plex-mono',
  ],
  esbuildOptions: (options) => {
    options.conditions = ['module', 'jsnext:main', 'jsnext'];
    options.mainFields = ['module', 'jsnext:main', 'main'];
  },
  // The `webui` bin maps to dist/server/entry.js. Without a shebang line
  // the OS doesn't know to launch it with Node, so the bin is unusable
  // after `npm i -g @wrongstack/webui`. tsup doesn't have a per-entry
  // banner option for ESM, so we patch it in post-build.
  onSuccess: async () => {
    const fs = await import('node:fs/promises');
    const path = 'dist/server/entry.js';
    try {
      const src = await fs.readFile(path, 'utf8');
      if (!src.startsWith('#!')) {
        await fs.writeFile(path, `#!/usr/bin/env node\n${src}`);
      }
    } catch {
      /* dist not produced yet on a partial build — skip silently. */
    }
  },
});
