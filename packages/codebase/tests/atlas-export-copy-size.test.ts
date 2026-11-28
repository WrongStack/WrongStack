import { describe, expect, it } from 'vitest';
import { renderAtlasHtml } from '../src/atlas-export.js';
import type { AtlasDocument } from '../src/atlas-types.js';

const document: AtlasDocument = {
  schema: 2,
  counts: { files: 1, symbols: 1, packages: 1 },
  packages: [{ name: 'pkg/a', files: 1, hub: 'src/a.ts', rank: 1 }],
  edges: [],
  files: [],
};

describe('atlas export body copy', () => {
  it('uses one 16px type token for body copy instead of sub-threshold literals', () => {
    const html = renderAtlasHtml(document);

    // Control: a populated document still renders the explanatory counts.
    expect(html).toContain('<p class="counts">1 files · 1 symbols · 1 packages');

    // The design_reference page-surface threshold is 16px. Every copy rule
    // measured in the rendered proof must resolve through the same token.
    expect(html).toContain('--copy-size: 16px;');
    expect(html).toContain('font: var(--copy-size)/1.5');
    for (const rule of [
      '.counts { color: var(--muted); font-size: var(--copy-size); }',
      'table { width: 100%; border-collapse: collapse; font-size: var(--copy-size); }',
      '.filter { margin: 10px 0 0; font-size: var(--copy-size); color: var(--muted); }',
      'footer { color: var(--muted); font-size: var(--copy-size);',
    ]) {
      expect(html).toContain(rule);
    }
  });
});
