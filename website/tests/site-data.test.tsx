import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pageMeta } from '../src/data/content-page-meta';
import { releaseHighlights } from '../src/data/release-highlights';
import {
  type ChangelogEntry,
  changelog,
  cn,
  META,
  packages,
  plugins,
  providerFamilies,
  SKILL_COUNT,
  skills,
  slashCommands,
  toolGroups,
} from '../src/lib/utils';

const websiteRoot = process.cwd();
const repoRoot = resolve(websiteRoot, '..');
const packageVersion: string = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
).version;

const releaseVersion = (version: string): [number, number, number] => {
  const parts = version.split('.').map(Number);
  expect(parts, `malformed version: ${version}`).toHaveLength(3);
  return [parts[0] as number, parts[1] as number, parts[2] as number];
};

describe('site data — changelog invariants', () => {
  it('keeps a strictly descending, duplicate-free version history', () => {
    const versions = changelog.map((entry: ChangelogEntry) => entry.version);
    for (let i = 1; i < versions.length; i += 1) {
      const prev = releaseVersion(versions[i - 1] as string);
      const current = releaseVersion(versions[i] as string);
      const descended =
        prev[0] > current[0] ||
        (prev[0] === current[0] && prev[1] > current[1]) ||
        (prev[0] === current[0] && prev[1] === current[1] && prev[2] > current[2]);
      expect(descended, `${versions[i - 1]} must come after ${versions[i]}`).toBe(true);
    }
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('flags exactly one latest release and it matches META.version', () => {
    const latest = changelog.filter((entry: ChangelogEntry) => entry.latest === true);
    expect(latest).toHaveLength(1);
    expect(latest[0]?.version).toBe(META.version);
  });

  it('leads with the current package release', () => {
    expect(changelog[0]?.version).toBe(packageVersion);
    expect(changelog[0]?.latest).toBe(true);
    expect(changelog[0]?.highlights.length).toBeGreaterThan(0);
  });

  it('keeps the release spotlight and social previews aligned with the current release', () => {
    const html = new DOMParser().parseFromString(
      readFileSync(resolve(websiteRoot, 'index.html'), 'utf8'),
      'text/html',
    );
    const schema = JSON.parse(
      html.querySelector('script[type="application/ld+json"]')!.textContent!,
    );
    expect(releaseHighlights.version).toBe(packageVersion);
    expect(pageMeta['/'].description).toBe(releaseHighlights.socialDescription);
    expect(html.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe(
      releaseHighlights.socialDescription,
    );
    expect(html.querySelector('meta[name="twitter:description"]')?.getAttribute('content')).toBe(
      releaseHighlights.socialDescription,
    );
    expect(schema.softwareVersion).toBe(packageVersion);
    expect(schema.dateModified).toBe(`${changelog[0]!.date}T00:00:00Z`);
  });

  it('keeps every entry on an ISO date with a non-empty tagline and highlights', () => {
    for (const entry of changelog) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.tagline.length).toBeGreaterThan(0);
      expect(entry.highlights.length).toBeGreaterThan(0);
    }
  });
});

describe('site data — skills catalog', () => {
  it('derives SKILL_COUNT from the catalog and matches packages/core/skills', () => {
    expect(SKILL_COUNT).toBe(skills.length);
    const siteNames = skills.map((skill) => skill.name);
    expect(new Set(siteNames).size).toBe(siteNames.length);
    const coreNames = readdirSync(resolve(repoRoot, 'packages/core/skills'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(new Set(siteNames)).toEqual(new Set(coreNames));
  });
});

describe('site data — public export surface of @/lib/utils', () => {
  it('still exports every consumer-facing value after the split', () => {
    expect(typeof cn).toBe('function');
    expect(META.version).toBe(packageVersion);
    expect(Array.isArray(changelog)).toBe(true);
    expect(changelog.length).toBeGreaterThan(90);
    expect(Array.isArray(toolGroups)).toBe(true);
    expect(Array.isArray(providerFamilies)).toBe(true);
    expect(Array.isArray(slashCommands)).toBe(true);
    expect(Array.isArray(packages)).toBe(true);
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins.length).toBeGreaterThan(90);
  });
});

describe('site data — hand-maintained file size budget', () => {
  const boundedFiles = [
    'index.html',
    'src/lib/utils.ts',
    'src/data/skills.ts',
    'src/data/changelog.ts',
    'src/data/changelog-types.ts',
    'src/data/changelog-1x.ts',
    'src/data/changelog-1x-early.ts',
    'src/data/changelog-0x-a.ts',
    'src/data/changelog-0x-b.ts',
    'src/pages/HomePage.tsx',
    'src/pages/EcosystemPage.tsx',
    'src/data/content-reference.ts',
    'tests/site-data.test.tsx',
  ];

  it('keeps every touched or split file at or under 800 physical lines', () => {
    for (const relPath of boundedFiles) {
      const content = readFileSync(resolve(websiteRoot, relPath), 'utf8');
      const lineCount = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
      expect(lineCount, `${relPath} exceeds the 800-line budget`).toBeLessThanOrEqual(800);
    }
  });
});
