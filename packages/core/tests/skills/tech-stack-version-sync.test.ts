import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  selectStableVersion,
  stableVersionParts,
} from '../../skills/tech-stack/scripts/check-versions.mjs';
import {
  buildReplacementPairs,
  bumpPatchVersion,
  REGISTRY_SNAPSHOT_PACKAGES,
  selectNodeReleases,
} from '../../skills/tech-stack/scripts/sync-versions.mjs';

const SNAPSHOT_PATH = join(
  __dirname,
  '../../skills/tech-stack/references/stable-registry-check.json',
);

describe('tech-stack version sync & registry helpers', () => {
  it('excludes prereleases and deprecated versions when selecting highest stable', () => {
    expect(stableVersionParts('7.10.1')).toEqual([7, 10, 1]);
    expect(stableVersionParts('8.0.0-rc.27')).toBeUndefined();
    expect(stableVersionParts('4.2.0-M2')).toBeUndefined();

    const selected = selectStableVersion({
      '7.9.0': {},
      '7.10.1': {},
      '7.10.2': { deprecated: 'broken build' },
      '8.0.0-rc.27': {},
    });
    expect(selected).toBe('7.10.1');
  });

  it('never takes a Node.js prerelease as the current stable release', () => {
    // nodejs.org/dist/index.json on 2026-11-02: the Node 27 alpha channel is
    // listed first, and Node 26 has just become the active LTS line.
    const index = [
      { version: 'v27.0.0-alpha.0.0.0', lts: false },
      { version: 'v26.13.0', lts: 'Lithium' },
      { version: 'v25.9.0', lts: false },
      { version: 'v24.22.2', lts: 'Krypton' },
    ];
    expect(selectNodeReleases(index)).toEqual({ current: '26.13.0', lts: '26.13.0' });
    expect(selectNodeReleases(null)).toEqual({ current: undefined, lts: undefined });
  });

  it('follows the LTS line across majors', () => {
    const pairs = buildReplacementPairs({}, {}, { nodeCurrent: '26.13.0', nodeLts: '26.13.0' });
    let text =
      'Latest stable Node.js 26.12.1 (LTS 26.0.0, was v24.22.1 LTS); image `node:26.12.1-bookworm-slim`.';
    for (const [pattern, replacement] of pairs) text = text.replace(pattern, replacement);
    expect(text).toBe(
      'Latest stable Node.js 26.13.0 (LTS 26.13.0, was v26.13.0 LTS); image `node:26.13.0-bookworm-slim`.',
    );
  });

  it('keeps the three.js release label in step with its version', () => {
    const pairs = buildReplacementPairs({ three: { version: '0.187.0' } }, {}, {});
    let text = 'Three.js 0.186.1 (r186), React Three Fiber 9.8.2.';
    for (const [pattern, replacement] of pairs) text = text.replace(pattern, replacement);
    expect(text).toBe('Three.js 0.187.0 (r187), React Three Fiber 9.8.2.');
  });

  it('bumps 3-part semver patch numbers deterministically', () => {
    expect(bumpPatchVersion('1.5.2')).toBe('1.5.3');
    expect(bumpPatchVersion('2.1.0')).toBe('2.1.1');
  });

  it('rewrites dated version references across frontend, mobile, media, and backend prose', () => {
    const pairs = buildReplacementPairs(
      {
        next: { version: '16.5.0' },
        react: { version: '19.4.0' },
        prisma: { version: '7.11.0', latestTag: '8.0.0-rc.30' },
        expo: { version: '58.1.0' },
        'react-native': { version: '0.88.2' },
      },
      {
        fastapi: '0.165.0',
        uv: '0.14.0',
      },
      {
        nodeCurrent: '26.13.0',
        nodeLts: '24.23.0',
        flutter: '3.48.0',
        dart: '3.14.0',
        go: '1.27.4',
        rust: '1.99.2',
      },
      '2026-11-01',
    );

    let sample = [
      'Target the latest stable release: Next.js 16.4.3 with React/react-dom 19.3.1, verified from npm on 2026-10-23.',
      'Checked 2026-10-23: Prisma/client 7.10.1. Prisma latest tag currently points at 8.0.0-rc.27.',
      'Checked 2026-10-23: React Native 0.88.0, Expo 58.0.17, Flutter 3.47.8 with Dart SDK 3.13.7.',
      'Current Node.js (v26.12.1 Current / v24.22.1 LTS as checked 2026-10-23), FastAPI 0.162.0, uv 0.13.5, Go target: 1.27.3, Rust target: 1.99.1.',
    ].join('\n');

    for (const [pattern, replacement] of pairs) {
      sample = sample.replace(pattern, replacement);
    }

    expect(sample).toContain('Next.js 16.5.0 with React/react-dom 19.4.0');
    expect(sample).toContain('verified from npm on 2026-11-01');
    expect(sample).toContain('Prisma/client 7.11.0');
    expect(sample).toContain('points at 8.0.0-rc.30');
    expect(sample).toContain(
      'React Native 0.88.2, Expo 58.1.0, Flutter 3.48.0 with Dart SDK 3.14.0',
    );
    expect(sample).toContain('v26.13.0 Current / v24.23.0 LTS as checked 2026-11-01');
    expect(sample).toContain('FastAPI 0.165.0, uv 0.14.0, Go target: 1.27.4, Rust target: 1.99.2');
  });

  it('keeps stable-registry-check.json aligned with REGISTRY_SNAPSHOT_PACKAGES', () => {
    const raw = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Array<{
      package: string;
      version: string;
      latestTag: string;
      checkedAt: string;
    }>;
    expect(raw.map((entry) => entry.package)).toEqual(REGISTRY_SNAPSHOT_PACKAGES);
    for (const entry of raw) {
      expect(stableVersionParts(entry.version), entry.package).toBeDefined();
      expect(entry.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});
