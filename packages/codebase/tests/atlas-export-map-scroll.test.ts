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

describe('atlas export map scrolling', () => {
  it('gives the overflowing map a named keyboard tab stop', () => {
    const html = renderAtlasHtml(document);

    // Control: the map keeps its horizontal-scroll container.
    expect(html).toContain('<figure class="wrap">');

    // WCAG 2.2 SC 2.1.1: the scroll container gets a tab stop and a name only
    // when it actually overflows, so keyboard users can pan the map.
    expect(html).toContain('var scrollable = map.scrollWidth > map.clientWidth;');
    expect(html).toContain('map.tabIndex = 0;');
    expect(html).toContain("map.setAttribute('aria-label', 'Package map');");
  });
});
