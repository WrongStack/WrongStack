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

describe('atlas export map resize', () => {
  it('re-evaluates the map tab stop and centring when the viewport changes', () => {
    const html = renderAtlasHtml(document);

    // Control: the map still uses the horizontal-scroll figure.
    expect(html).toContain('<figure class="wrap">');

    // WCAG 2.2 SC 2.1.1: a map opened wide can become scrollable on resize,
    // so the tab stop must be added and removed with the overflow state.
    expect(html).toContain('function syncMapScroll() {');
    expect(html).toContain('var scrollable = map.scrollWidth > map.clientWidth;');
    expect(html).toContain("window.addEventListener('resize', syncMapScroll);");
    expect(html).toContain("map.removeAttribute('tabindex');");
    expect(html).toContain("map.removeAttribute('aria-label');");
  });
});
