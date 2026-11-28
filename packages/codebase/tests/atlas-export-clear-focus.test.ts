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

describe('atlas export clear-filter focus', () => {
  it('hands focus back to the active package when the self-hiding Clear button is used', () => {
    const html = renderAtlasHtml(document);

    // Control: a native, initially hidden Clear button is rendered.
    expect(html).toContain('<button type="button" id="clear" hidden>Clear filter</button>');

    // The Clear handler hides the focused button, so it must capture the
    // previous filter first and focus that package after resetting it;
    // otherwise focus silently falls back to <body>.
    expect(html).toContain('var previous = active;');
    expect(html).toContain('apply(null);');
    expect(html).toContain("if (group.getAttribute('data-package') === previous) group.focus();");
  });
});
