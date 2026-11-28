import { describe, expect, it } from 'vitest';
import { renderAtlasHtml } from '../src/atlas-export.js';
import type { AtlasDocument } from '../src/atlas-types.js';

const packages = [
  { name: 'pkg/a', files: 2, hub: 'src/a.ts', rank: 1 },
  { name: 'pkg/b', files: 1, hub: 'src/b.ts', rank: 0.5 },
];

const document: AtlasDocument = {
  schema: 2,
  counts: { files: 2, symbols: 2, packages: 2 },
  packages,
  edges: [
    { from: 'pkg/b', to: 'pkg/a', weight: 10, refType: 'import' },
    { from: 'pkg/a', to: 'pkg/b', weight: 1, refType: 'import' },
  ],
  files: [],
};

describe('atlas export dependency contrast', () => {
  it('keeps every dependency line above the non-text contrast opacity floor', () => {
    const html = renderAtlasHtml(document);

    // Control: both dependency lines are rendered with strength-based widths.
    const lines = [
      ...html.matchAll(/<line [^>]*stroke-width="([\d.]+)" stroke-opacity="([\d.]+)"/g),
    ];
    expect(lines).toHaveLength(2);

    // WCAG 2.2 SC 1.4.11: the old 0.12 floor made weak edges ~1.25:1 against
    // the panel; 0.7 is the measured minimum for 3:1 in both themes.
    const opacities = lines.map((match) => Number(match[2]));
    expect(Math.min(...opacities)).toBeGreaterThanOrEqual(0.7);
    expect(Math.max(...opacities)).toBeLessThanOrEqual(1);
    expect(Math.max(...opacities)).toBeGreaterThan(Math.min(...opacities));
  });
});
