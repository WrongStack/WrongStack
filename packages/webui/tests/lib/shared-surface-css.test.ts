// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
let css = '';

beforeAll(async () => {
  const result = await build({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      cssMinify: false,
      rollupOptions: { input: path.join(root, 'src/index.css') },
    },
  });
  for (const bundle of Array.isArray(result) ? result : [result]) {
    if (!('output' in bundle)) throw new Error('Expected a completed CSS build');
    for (const asset of bundle.output) {
      if (asset.type !== 'asset' || !asset.fileName.endsWith('.css')) continue;
      css +=
        typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source);
    }
  }
}, 30_000);

describe('production WebUI styles', () => {
  it('emits the existing fixed overlay positioning', () => {
    expect(css).toMatch(/\.fixed\s*\{\s*position:\s*fixed;/);
  });

  it('emits centering utilities used by the shared dialog', async () => {
    const dialog = await readFile(path.join(root, '../project-surfaces/src/ui/dialog.tsx'), 'utf8');
    // Read candidates from production source. Spelling them here would let
    // Tailwind discover them in this test and hide a missing shared source.
    const candidates = dialog.match(/\b(?:left|top|translate-[xy])-\[[^\]]+\]/g) ?? [];
    expect(candidates).toHaveLength(4);
    for (const candidate of candidates) {
      const selector = `.${candidate.replace(/[^a-zA-Z0-9_-]/g, '\\$&')}`;
      expect(css.includes(selector), `Missing shared dialog utility: ${candidate}`).toBe(true);
    }
  });
});
