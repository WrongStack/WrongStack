import { describe, expect, it } from 'vitest';
import { renderAtlasHtml } from '../src/atlas-export.js';
import type { AtlasDocument } from '../src/atlas-types.js';

const MIN_TARGET_CSS_PX = 24;
const CANVAS_WIDTH = 1000;
const MIN_RADIUS = 14;

const document: AtlasDocument = {
  schema: 2,
  counts: { files: 2, symbols: 2, packages: 2 },
  packages: [
    { name: 'pkg/a', files: 2, hub: 'src/a.ts', rank: 1 },
    { name: 'pkg/b', files: 1, hub: 'src/b.ts', rank: 0 },
  ],
  edges: [],
  files: [],
};

describe('atlas export target size', () => {
  it('keeps every package circle at the WCAG 2.2 minimum target size on narrow screens', () => {
    const html = renderAtlasHtml(document);

    // Control: a populated, interactive map is rendered.
    expect(html).toContain('role="group" aria-label="Package dependency map"');
    expect(html).toContain('data-package="pkg/a" role="button"');

    // The map scales with its container. Without a floor, the smallest circle
    // (2 * MIN_RADIUS user units in a CANVAS_WIDTH-wide viewBox) shrinks below
    // the 24 CSS px minimum of WCAG 2.2 SC 2.5.8 at narrow viewports.
    const minWidth = html.match(/svg \{[^}]*min-width: (\d+)px/)?.[1];
    expect(minWidth).toBeDefined();
    const renderedSmallest = (2 * MIN_RADIUS * Number(minWidth)) / CANVAS_WIDTH;
    expect(renderedSmallest).toBeGreaterThanOrEqual(MIN_TARGET_CSS_PX);

    // At narrow widths the floor makes the map wider than its container, so it
    // must live in a horizontal scroll container to stay reachable.
    expect(html).toContain('<figure class="wrap">');
  });
});
