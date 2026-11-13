/**
 * Copyright-safe Wikimedia Commons photography index & `[data-slot]` builder.
 *
 * Stock sites (Unsplash, Pexels, Pixabay) restrict automated AI selection in
 * their terms, and models routinely hallucinate broken image URLs. This module
 * ranks bundled, open-licensed (CC0 / Public Domain / CC BY / CC BY-SA)
 * Wikimedia Commons photographs by IDF keyword coverage, orientation, and the
 * active kit's paper/accent axes, rotates away from recently used IDs, and
 * emits ready `<figure data-slot="...">` markup plus mandatory `data-credits`
 * footer attribution.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DesignKitAxes } from '@wrongstack/contracts/types/design-kit';
import { resolveBundledDesignKitsDir } from './design-kit-loader.js';
import { compilePhotoTreatmentCss } from './design-material.js';

export type DesignPhotoOrientation = 'landscape' | 'portrait' | 'square';

export interface DesignPhotoEntry {
  id: string;
  file: string;
  page: string;
  w: number;
  h: number;
  color: string;
  license: string;
  author: string;
  subject: string;
  tags: string[];
  cat: string;
  tone: 'light' | 'mid' | 'dark';
  temp: 'warm' | 'cool' | 'neutral';
  people: string;
  q: number;
  fp?: [number, number] | undefined;
  thumbName?: string | undefined;
}

export interface DesignPhotoPick {
  entry: DesignPhotoEntry;
  orient: DesignPhotoOrientation;
  score: number;
  match: 'close' | 'partial';
  thumbUrl: string;
  srcset: string;
  objectPosition?: string | undefined;
  creditHtml: string;
  slotHtml: string;
}

export interface DesignPhotoSubjectResult {
  query: string;
  picks: DesignPhotoPick[];
}

export interface DesignPhotosResult {
  subjects: DesignPhotoSubjectResult[];
  kit?: string | undefined;
  photoTreatment?: string | undefined;
  photoTreatmentCss?: string | undefined;
  creditsHtml: string;
  slotHelperScript: string;
}

const STANDARD_WIDTHS = [960, 1280, 1920] as const;

const PHOTO_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'over',
  'under',
  'near',
  'view',
  'shot',
  'photo',
  'image',
  'picture',
  'page',
  'hero',
  'section',
]);

const PHOTO_SYNONYMS: Record<string, string[]> = {
  cafe: ['coffee', 'bistrot', 'terrace', 'espresso', 'bakery'],
  bakery: ['bread', 'pastry', 'oven', 'flour', 'dough', 'kitchen'],
  farm: ['field', 'agriculture', 'orchard', 'pasture', 'harvest', 'rural'],
  orchard: ['apple', 'fruit', 'trees', 'autumn', 'harvest', 'farm'],
  pottery: ['clay', 'ceramics', 'potter', 'kiln', 'wheel', 'workshop'],
  ceramic: ['clay', 'pottery', 'potter', 'workshop', 'artisan'],
  transit: ['train', 'metro', 'station', 'platform', 'tram', 'railway', 'commute'],
  music: ['concert', 'band', 'stage', 'festival', 'venue', 'auditorium'],
  concert: ['stage', 'festival', 'band', 'crowd', 'live', 'auditorium'],
  construction: ['concrete', 'excavator', 'bridge', 'engineering', 'builders', 'industrial'],
  workshop: ['tools', 'craft', 'artisan', 'bench', 'woodworking', 'studio', 'metalwork'],
  gallery: ['museum', 'exhibition', 'art', 'photographs', 'statue', 'interior'],
  architecture: ['building', 'facade', 'arcade', 'bridge', 'roof', 'interior'],
  coast: ['sea', 'beach', 'harbour', 'pier', 'ocean', 'tide'],
};

let cachedCatalog: DesignPhotoEntry[] | null = null;

function stemWord(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !PHOTO_STOP_WORDS.has(w));
}

function orientationOf(entry: DesignPhotoEntry): DesignPhotoOrientation {
  const ratio = entry.w / Math.max(1, entry.h);
  if (ratio > 1.18) return 'landscape';
  if (ratio < 0.85) return 'portrait';
  return 'square';
}

function widthsFor(entry: DesignPhotoEntry): number[] {
  const valid = STANDARD_WIDTHS.filter((w) => w < entry.w);
  return valid.length > 0 ? [...valid] : [STANDARD_WIDTHS[0]];
}

function wikimediaThumbUrl(entry: DesignPhotoEntry, width: number): string {
  const fileName = entry.file.split('/').pop() ?? 'image.jpg';
  const thumbFile = entry.thumbName ?? fileName;
  return `${entry.file.replace('/wikipedia/commons/', '/wikipedia/commons/thumb/')}/${width}px-${thumbFile}`;
}

export function formatPhotoCreditHtml(entry: DesignPhotoEntry): string {
  return `<a href="${entry.page}" rel="noopener noreferrer">${entry.author}</a> (${entry.license}, Wikimedia Commons)`;
}

function seededPrng(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let state = h || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function loadBundledPhotoCatalog(): Promise<DesignPhotoEntry[]> {
  if (cachedCatalog) return cachedCatalog;
  const kitsDir = resolveBundledDesignKitsDir();
  if (!kitsDir) return [];
  try {
    const raw = await fs.readFile(path.join(kitsDir, 'photos.json'), 'utf8');
    const parsed = JSON.parse(raw) as { photos?: DesignPhotoEntry[] };
    cachedCatalog = Array.isArray(parsed.photos) ? parsed.photos : [];
    return cachedCatalog;
  } catch {
    return [];
  }
}

export const WRONGSTACK_SLOTS_HELPER =
  `window.wrongstackSlots = (map) => { for (const [slot, val] of Object.entries(map)) { ` +
  `const el = document.querySelector('[data-slot="' + slot + '"]'); if (!el) continue; ` +
  `const img = document.createElement('img'); img.src = typeof val === 'string' ? val : val.src; ` +
  `img.alt = (typeof val === 'object' && val.alt) || el.getAttribute('data-alt') || ''; ` +
  `el.querySelectorAll(':scope > img').forEach((old) => old.remove()); el.prepend(img); } };`;

export interface SearchDesignPhotosOptions {
  queries: string[];
  catalog: readonly DesignPhotoEntry[];
  countPerQuery?: number | undefined;
  orientation?: DesignPhotoOrientation | undefined;
  axes?: DesignKitAxes | undefined;
  kitId?: string | undefined;
  photoTreatment?: string | undefined;
  recentIds?: readonly string[] | undefined;
  seed?: string | undefined;
}

export function searchDesignPhotos(opts: SearchDesignPhotosOptions): DesignPhotosResult {
  const catalog = opts.catalog;
  const perQuery = Math.max(1, Math.min(6, opts.countPerQuery ?? 3));
  const recentSet = new Set(opts.recentIds ?? []);
  const rand = seededPrng(`photos:${opts.seed ?? 'default'}`);

  const docTerms = catalog.map((p) => {
    const set = new Set<string>();
    for (const tag of p.tags) {
      for (const w of tokenize(tag)) set.add(stemWord(w));
    }
    for (const w of tokenize(p.subject)) set.add(stemWord(w));
    for (const w of tokenize(p.cat)) set.add(stemWord(w));
    return set;
  });

  const df = new Map<string, number>();
  for (const terms of docTerms) {
    for (const w of terms) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const idf = (w: string): number => Math.log((catalog.length + 1) / ((df.get(w) ?? 0) + 1)) + 0.3;

  const usedIds = new Set<string>();
  const allPickedEntries: DesignPhotoEntry[] = [];
  const subjects: DesignPhotoSubjectResult[] = [];

  for (let qIdx = 0; qIdx < opts.queries.length; qIdx++) {
    const rawQuery = opts.queries[qIdx]?.trim() ?? '';
    if (!rawQuery) continue;
    const queryWords = [...new Set(tokenize(rawQuery).map(stemWord))];
    const totalWeight = queryWords.reduce((sum, w) => sum + idf(w), 0) || 1;
    const wantsFace = /\b(?:portrait|person|people|face|actor|musician)\b/i.test(rawQuery);

    const candidates: Array<{
      entry: DesignPhotoEntry;
      orient: DesignPhotoOrientation;
      score: number;
      coverage: number;
    }> = [];

    for (let i = 0; i < catalog.length; i++) {
      const entry = catalog[i]!;
      if (usedIds.has(entry.id)) continue;
      const orient = orientationOf(entry);
      if (opts.orientation && orient !== opts.orientation) continue;

      const terms = docTerms[i]!;
      let matchedWeight = 0;
      for (const w of queryWords) {
        if (terms.has(w)) {
          matchedWeight += idf(w);
        } else if ((PHOTO_SYNONYMS[w] ?? []).some((syn) => terms.has(stemWord(syn)))) {
          matchedWeight += 0.72 * idf(w);
        } else if (
          [...terms].some(
            (t) =>
              t.length >= 4 &&
              w.length >= 4 &&
              (t.startsWith(w.slice(0, 4)) || w.startsWith(t.slice(0, 4))),
          )
        ) {
          matchedWeight += 0.65 * idf(w);
        }
      }

      const coverage = queryWords.length === 0 ? 0.5 : matchedWeight / totalWeight;
      if (queryWords.length > 0 && coverage < 0.35) continue;

      let score = coverage * 10;
      for (const tag of entry.tags) {
        if (tag.includes(' ') && rawQuery.toLowerCase().includes(tag)) score += 1.2;
      }
      if (entry.q >= 3) score += 0.8;
      if (entry.people === 'face' && !wantsFace) score -= 2.5;
      if (recentSet.has(entry.id)) score -= 3.5;

      if (opts.axes) {
        if (opts.axes.paper === 'dark' && entry.tone !== 'light') score += 0.35;
        if (opts.axes.paper === 'light' && entry.tone !== 'dark') score += 0.2;
        if ((opts.axes.accent === 'warm') === (entry.temp === 'warm')) score += 0.25;
      }
      score += rand() * 0.6;
      candidates.push({ entry, orient, score, coverage });
    }

    candidates.sort((a, b) => b.score - a.score);
    const chosen = candidates.slice(0, perQuery);
    const picks: DesignPhotoPick[] = chosen.map((c, idx) => {
      usedIds.add(c.entry.id);
      allPickedEntries.push(c.entry);
      const sizes = widthsFor(c.entry);
      const preferredWidth = sizes.includes(1280) ? 1280 : (sizes[sizes.length - 1] ?? 960);
      const thumbUrl = wikimediaThumbUrl(c.entry, preferredWidth);
      const srcset = sizes.map((w) => `${wikimediaThumbUrl(c.entry, w)} ${w}w`).join(', ');
      const objectPosition = c.entry.fp
        ? `${Math.round(c.entry.fp[0] * 100)}% ${Math.round(c.entry.fp[1] * 100)}%`
        : undefined;
      const slotName = qIdx === 0 && idx === 0 ? 'hero' : `photo-${qIdx + 1}-${idx + 1}`;
      const posAttr = objectPosition ? ` style="object-position: ${objectPosition}"` : '';
      const loadingAttr = slotName === 'hero' ? ' fetchpriority="high"' : ' loading="lazy"';
      const slotHtml =
        `<figure data-slot="${slotName}" data-alt="${c.entry.subject.replace(/"/g, '&quot;')}">` +
        `<img src="${thumbUrl}" srcset="${srcset}" sizes="(min-width: 1024px) 50vw, 100vw" ` +
        `width="${c.entry.w}" height="${c.entry.h}" alt="${c.entry.subject.replace(/"/g, '&quot;')}"${loadingAttr}${posAttr} />` +
        `</figure>`;
      return {
        entry: c.entry,
        orient: c.orient,
        score: Math.round(c.score * 10) / 10,
        match: c.coverage >= 0.7 ? 'close' : 'partial',
        thumbUrl,
        srcset,
        ...(objectPosition ? { objectPosition } : {}),
        creditHtml: formatPhotoCreditHtml(c.entry),
        slotHtml,
      };
    });

    subjects.push({ query: rawQuery, picks });
  }

  const treatmentCompiled = opts.photoTreatment
    ? compilePhotoTreatmentCss(opts.photoTreatment, { darkPaper: opts.axes?.paper === 'dark' })
    : undefined;

  return {
    subjects,
    ...(opts.kitId ? { kit: opts.kitId } : {}),
    ...(opts.photoTreatment ? { photoTreatment: opts.photoTreatment } : {}),
    ...(treatmentCompiled?.css ? { photoTreatmentCss: treatmentCompiled.css } : {}),
    creditsHtml: renderPhotoCredits(allPickedEntries),
    slotHelperScript: WRONGSTACK_SLOTS_HELPER,
  };
}

export function renderPhotoCredits(entries: readonly DesignPhotoEntry[]): string {
  if (entries.length === 0) return '';
  const unique = new Map<string, DesignPhotoEntry>();
  for (const e of entries) unique.set(e.id, e);
  const links = [...unique.values()].map(formatPhotoCreditHtml).join(' · ');
  return `<p data-credits>Photographs: ${links}</p>`;
}

interface PhotoHistoryFile {
  runs: Array<{ at: string; ids: string[] }>;
}

const PHOTO_HISTORY_REL = '.wrongstack/design-photos.json';

export async function ensureDesignPhotos(
  projectRoot: string,
  opts: Omit<SearchDesignPhotosOptions, 'catalog' | 'recentIds'> & {
    catalog?: readonly DesignPhotoEntry[] | undefined;
  },
): Promise<DesignPhotosResult> {
  const catalog = opts.catalog ?? (await loadBundledPhotoCatalog());
  const histPath = path.join(projectRoot, PHOTO_HISTORY_REL);
  let runs: PhotoHistoryFile['runs'] = [];
  try {
    const raw = JSON.parse(await fs.readFile(histPath, 'utf8')) as PhotoHistoryFile;
    if (Array.isArray(raw.runs)) runs = raw.runs;
  } catch {
    // No history yet.
  }
  const recentIds = runs.slice(0, 5).flatMap((r) => r.ids);
  const result = searchDesignPhotos({
    ...opts,
    catalog,
    recentIds,
  });
  const pickedIds = result.subjects.flatMap((s) => s.picks.map((p) => p.entry.id));
  if (pickedIds.length > 0) {
    const nextRuns = [{ at: new Date().toISOString(), ids: pickedIds }, ...runs].slice(0, 12);
    await fs.mkdir(path.dirname(histPath), { recursive: true });
    await fs.writeFile(histPath, `${JSON.stringify({ runs: nextRuns }, null, 2)}\n`, 'utf8');
  }
  return result;
}

export function renderDesignPhotos(result: DesignPhotosResult): string {
  const lines: string[] = ['# Open-Licensed Photo Picks (Wikimedia Commons · `[data-slot]`)'];
  if (result.kit || result.photoTreatment) {
    lines.push(
      `Active treatment${result.kit ? ` (${result.kit})` : ''}: \`${result.photoTreatment ?? 'natural'}\` — materialized CSS styles every \`[data-slot] > img\` automatically.`,
    );
  }
  for (const s of result.subjects) {
    lines.push('', `## "${s.query}"`);
    if (s.picks.length === 0) {
      lines.push(
        'No close match in the offline Commons index — re-query with concrete physical nouns (place, material, craft, landscape) or keep an empty `[data-slot]` for user-supplied media.',
      );
      continue;
    }
    for (const p of s.picks) {
      lines.push(
        `- **${p.entry.subject}** (${p.entry.w}×${p.entry.h} ${p.orient} · ${p.entry.tone}/${p.entry.temp} · ${p.entry.license})`,
        `  \`\`\`html\n  ${p.slotHtml}\n  \`\`\``,
        `  Credit: \`${p.creditHtml}\``,
      );
    }
  }
  if (result.creditsHtml) {
    lines.push(
      '',
      '## Required Footer Attribution (`data-credits`)',
      '```html',
      result.creditsHtml,
      '```',
    );
  }
  return `${lines.join('\n')}\n`;
}
