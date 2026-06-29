import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/oauth/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2023',
  external: ['@wrongstack/core'],
});
