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

describe('atlas export toggle accessibility', () => {
  it('exposes each package filter as a named button with an initial pressed state', () => {
    const html = renderAtlasHtml(document);

    // Control: two populated, keyboard-focusable package groups are rendered.
    expect(html.match(/class="pkg"/g)).toHaveLength(2);
    expect(html).toContain('tabindex="0"');

    // role="img" would make descendants presentational and hide the toggles.
    expect(html).toContain('role="group" aria-label="Package dependency map"');
    expect(html).toContain(
      'data-package="pkg/a" role="button" aria-label="pkg/a" aria-pressed="false"',
    );

    // The filter handler must keep aria-pressed in sync with the visual state.
    expect(html).toContain("group.setAttribute('aria-pressed', selected ? 'true' : 'false')");
  });
});
