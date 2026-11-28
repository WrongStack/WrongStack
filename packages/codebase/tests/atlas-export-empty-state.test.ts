import { describe, expect, it } from 'vitest';
import { renderAtlasHtml } from '../src/atlas-export.js';
import type { AtlasDocument } from '../src/atlas-types.js';

const populated: AtlasDocument = {
  schema: 2,
  counts: { files: 1, symbols: 1, packages: 1 },
  packages: [{ name: 'pkg/a', files: 1, hub: 'src/a.ts', rank: 1 }],
  edges: [],
  files: [],
};

const empty: AtlasDocument = {
  schema: 2,
  counts: { files: 0, symbols: 0, packages: 0 },
  packages: [],
  edges: [],
  files: [],
};

describe('atlas export empty state', () => {
  it('hides the package filter instruction when there are no packages to select', () => {
    const populatedHtml = renderAtlasHtml(populated);

    // Control: a populated atlas keeps the filter help and its live region.
    expect(populatedHtml).toContain(
      '<p class="filter" id="filter">Click a package to filter the table.',
    );
    expect(populatedHtml).toContain('<span role="status" id="filter-status"></span>');

    const emptyHtml = renderAtlasHtml(empty);
    expect(emptyHtml).toContain('<p class="empty">No ranked packages to draw.</p>');
    expect(emptyHtml).toContain(
      '<p class="filter" id="filter" hidden>Click a package to filter the table.',
    );
  });
});
