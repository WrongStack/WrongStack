import { describe, expect, it } from 'vitest';
import { renderAtlasHtml } from '../src/atlas-export.js';
import type { AtlasDocument } from '../src/atlas-types.js';

const document: AtlasDocument = {
  schema: 2,
  counts: { files: 1, symbols: 1, packages: 2 },
  packages: [
    { name: 'pkg/a', files: 1, hub: 'src/a.ts', rank: 1 },
    { name: 'pkg/b', files: 1, hub: 'src/b.ts', rank: 0 },
  ],
  edges: [],
  files: [],
};

describe('atlas export filtered-package contrast', () => {
  it('dims only the circle of a filtered-out package, keeping its label readable', () => {
    const html = renderAtlasHtml(document);

    // Control: the muted state is still emitted for filtered-out packages.
    expect(html).toContain('svg .pkg.muted circle { fill-opacity: .06; }');

    // WCAG 2.2 SC 1.4.3: a whole-group opacity would composite the label
    // toward the panel colour and drop it below 4.5:1 while it stays focusable.
    expect(html).not.toContain('svg .pkg.muted { opacity:');
    expect(html).toMatch(/<text x="[\d.]+" y="[\d.]+">pkg\/a<\/text>/);
  });
});
