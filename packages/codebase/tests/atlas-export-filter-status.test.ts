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

describe('atlas export filter status', () => {
  it('mounts an empty status region and updates it when the filter changes', () => {
    const html = renderAtlasHtml(document);

    // Control: a pre-mounted, empty role=status region is present at load.
    expect(html).toContain('<span role="status" id="filter-status"></span>');

    // WCAG 2.2 SC 4.1.3: hiding rows changes results silently unless the
    // handler writes a status message the region can announce.
    expect(html).toContain("var status = document.getElementById('filter-status');");
    expect(html).toContain(
      'var shown = rows.filter(function (row) { return !row.hidden; }).length;',
    );
    expect(html).toContain(
      ": 'Showing ' + shown + ' of ' + rows.length + ' files for ' + name + '.';",
    );
  });
});
