import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensureDesignPhotos,
  loadBundledPhotoCatalog,
  renderDesignPhotos,
  searchDesignPhotos,
} from '../../src/execution/design-photos.js';

describe('design-photos (Wikimedia Commons [data-slot] engine)', () => {
  it('loads the 306-entry open-licensed Wikimedia Commons catalog with valid URLs and licenses', async () => {
    const catalog = await loadBundledPhotoCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(300);

    const ids = new Set<string>();
    for (const entry of catalog) {
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.file).toMatch(/^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\//);
      expect(entry.page).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
      expect(entry.w).toBeGreaterThan(0);
      expect(entry.h).toBeGreaterThan(0);
      expect(entry.license.length).toBeGreaterThan(1);
    }
  });

  it('matches subjects via IDF + synonyms, filters orientation, and emits [data-slot] + data-credits HTML', async () => {
    const catalog = await loadBundledPhotoCatalog();
    const res = searchDesignPhotos({
      queries: ['sourdough bakery oven', 'pottery clay wheel'],
      catalog,
      countPerQuery: 2,
      orientation: 'landscape',
      axes: { paper: 'light', display: 'roman-serif', accent: 'warm' },
      kitId: 'furrow',
      photoTreatment: 'warm con=4 sat=-8',
      seed: 'test-seed-1',
    });

    expect(res.subjects).toHaveLength(2);
    expect(res.subjects[0]!.picks.length).toBeGreaterThan(0);
    expect(res.subjects[0]!.picks.every((p) => p.orient === 'landscape')).toBe(true);
    expect(res.subjects[0]!.picks[0]!.thumbUrl).toContain('/wikipedia/commons/thumb/');
    expect(res.subjects[0]!.picks[0]!.slotHtml).toContain('data-slot="hero"');
    expect(res.subjects[0]!.picks[0]!.slotHtml).toContain('srcset=');
    expect(res.creditsHtml).toContain('<p data-credits>Photographs:');
    expect(res.creditsHtml).toContain('Wikimedia Commons');
    expect(res.photoTreatmentCss).toContain('[data-slot] > img');
    expect(res.slotHelperScript).toContain('window.wrongstackSlots');

    const md = renderDesignPhotos(res);
    expect(md).toContain('furrow');
    expect(md).toContain('data-slot="hero"');
    expect(md).toContain('data-credits');
  });

  it('persists .wrongstack/design-photos.json and rotates away from recently dealt IDs', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-photos-'));
    try {
      const run1 = await ensureDesignPhotos(tmp, {
        queries: ['autumn apple orchard'],
        countPerQuery: 2,
        seed: 'rot-1',
      });
      const firstIds = run1.subjects[0]!.picks.map((p) => p.entry.id);
      expect(firstIds.length).toBeGreaterThan(0);

      const histRaw = JSON.parse(
        await fs.readFile(path.join(tmp, '.wrongstack', 'design-photos.json'), 'utf8'),
      ) as { runs: Array<{ ids: string[] }> };
      expect(histRaw.runs).toHaveLength(1);
      expect(histRaw.runs[0]!.ids).toEqual(firstIds);

      const run2 = await ensureDesignPhotos(tmp, {
        queries: ['autumn apple orchard'],
        countPerQuery: 2,
        seed: 'rot-1',
      });
      const secondIds = run2.subjects[0]!.picks.map((p) => p.entry.id);
      expect(secondIds).not.toEqual(firstIds);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
