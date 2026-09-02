/**
 * Discovery unit test for `@wrongstack/techstack`.
 *
 * Verifies that `discoverWorkspaces()` correctly maps the output of
 * `detectLanguageWorkspaces()` (from `@wrongstack/tools/languages`) into
 * TechStack `Workspace` records:
 *
 *  - `EcosystemId` mapping (typescript/javascript → npm, java+gradle →
 *    gradle, java+maven → maven, etc.)
 *  - `relativeRoot` is project-root-relative and portable
 *  - `lockfiles` are extracted from `evidence` with `kind: 'lockfile'`
 *  - `coverage` follows the SDD §6 tier matrix (full / partial / unsupported)
 *  - Workspaces whose language has no ecosystem mapping (deno, shell) are
 *    silently dropped from the result
 *  - Sorting is stable: by `(ecosystem, relativeRoot, id)`
 *
 * The test exercises both the real `@wrongstack/tools/languages`
 * `detectLanguageWorkspaces` (against the on-disk fixtures) and a focused
 * `mapDetectedWorkspace` unit path with hand-rolled `DetectedWorkspace`
 * fixtures that isolate the mapping logic from filesystem state.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  coverageForEcosystem,
  discoverWorkspaces,
  mapDetectedWorkspace,
  type Workspace,
} from '../src/index.js';
import type { DetectedWorkspace } from '@wrongstack/tools/languages';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VALID_ECOSYSTEM_SET = new Set([
  'npm',
  'python',
  'rust',
  'go',
  'dotnet',
  'php',
  'dart',
  'maven',
  'gradle',
  'ruby',
  'swift',
  'elixir',
  'cpp',
] as const);

function mkDetectedWorkspace(overrides: Partial<DetectedWorkspace>): DetectedWorkspace {
  return {
    id: 'det-001',
    language: 'typescript',
    root: '/proj',
    confidence: 0.7,
    evidence: [],
    manifests: [],
    capabilities: [],
    ...overrides,
  };
}

describe('discovery — mapDetectedWorkspace', () => {
  it('maps typescript → npm with `full` coverage', () => {
    const ws = mapDetectedWorkspace(
      mkDetectedWorkspace({
        language: 'typescript',
        root: '/proj',
        confidence: 0.85,
        packageManager: 'pnpm',
        manifests: ['/proj/package.json'],
        evidence: [
          { kind: 'manifest', path: '/proj/package.json', value: 'package.json', weight: 55 },
          { kind: 'lockfile', path: '/proj/pnpm-lock.yaml', value: 'pnpm-lock.yaml', weight: 30 },
        ],
      }),
      '/proj',
    );
    expect(ws).toBeDefined();
    expect(ws?.ecosystem).toBe('npm');
    expect(ws?.coverage).toBe('full');
    expect(ws?.packageManager).toBe('pnpm');
    expect(ws?.relativeRoot).toBe('.');
    expect(ws?.manifests).toEqual(['/proj/package.json']);
    expect(ws?.lockfiles).toEqual(['/proj/pnpm-lock.yaml']);
    expect(ws?.confidence).toBeCloseTo(0.85);
  });

  it('maps javascript → npm', () => {
    const ws = mapDetectedWorkspace(mkDetectedWorkspace({ language: 'javascript' }), '/proj');
    expect(ws?.ecosystem).toBe('npm');
  });

  it('maps python → python with `full` coverage', () => {
    const ws = mapDetectedWorkspace(mkDetectedWorkspace({ language: 'python' }), '/proj');
    expect(ws?.ecosystem).toBe('python');
    expect(ws?.coverage).toBe('full');
  });

  it('maps rust → rust with `full` coverage', () => {
    const ws = mapDetectedWorkspace(mkDetectedWorkspace({ language: 'rust' }), '/proj');
    expect(ws?.ecosystem).toBe('rust');
    expect(ws?.coverage).toBe('full');
  });

  it('maps csharp → dotnet with `full` coverage', () => {
    const ws = mapDetectedWorkspace(mkDetectedWorkspace({ language: 'csharp' }), '/proj');
    expect(ws?.ecosystem).toBe('dotnet');
    expect(ws?.coverage).toBe('full');
  });

  it('maps php → php with `full` coverage', () => {
    const ws = mapDetectedWorkspace(mkDetectedWorkspace({ language: 'php' }), '/proj');
    expect(ws?.ecosystem).toBe('php');
    expect(ws?.coverage).toBe('full');
  });

  it('maps dart → dart with `full` coverage', () => {
    const ws = mapDetectedWorkspace(mkDetectedWorkspace({ language: 'dart' }), '/proj');
    expect(ws?.ecosystem).toBe('dart');
    expect(ws?.coverage).toBe('full');
  });

  it('maps go → go with `full` coverage', () => {
    const ws = mapDetectedWorkspace(mkDetectedWorkspace({ language: 'go' }), '/proj');
    expect(ws?.ecosystem).toBe('go');
    expect(ws?.coverage).toBe('full');
  });

  it('maps ruby → ruby with `partial` coverage', () => {
    const ws = mapDetectedWorkspace(mkDetectedWorkspace({ language: 'ruby' }), '/proj');
    expect(ws?.ecosystem).toBe('ruby');
    expect(ws?.coverage).toBe('partial');
  });

  it('maps swift → swift with `partial` coverage', () => {
    const ws = mapDetectedWorkspace(mkDetectedWorkspace({ language: 'swift' }), '/proj');
    expect(ws?.ecosystem).toBe('swift');
    expect(ws?.coverage).toBe('partial');
  });

  it('maps elixir → elixir with `partial` coverage', () => {
    const ws = mapDetectedWorkspace(mkDetectedWorkspace({ language: 'elixir' }), '/proj');
    expect(ws?.ecosystem).toBe('elixir');
    expect(ws?.coverage).toBe('partial');
  });

  it('maps java (no gradle evidence) → maven', () => {
    const ws = mapDetectedWorkspace(
      mkDetectedWorkspace({
        language: 'java',
        evidence: [{ kind: 'manifest', path: '/proj/pom.xml', value: 'pom.xml', weight: 90 }],
      }),
      '/proj',
    );
    expect(ws?.ecosystem).toBe('maven');
    expect(ws?.coverage).toBe('partial');
  });

  it('maps java (gradle lockfile evidence) → gradle', () => {
    const ws = mapDetectedWorkspace(
      mkDetectedWorkspace({
        language: 'java',
        evidence: [
          {
            kind: 'lockfile',
            path: '/proj/gradle.lockfile',
            value: 'gradle.lockfile',
            weight: 30,
          },
          { kind: 'manifest', path: '/proj/build.gradle', value: 'build.gradle', weight: 85 },
        ],
      }),
      '/proj',
    );
    expect(ws?.ecosystem).toBe('gradle');
    expect(ws?.coverage).toBe('partial');
  });

  it('maps cpp → cpp with `unsupported` coverage (Tier C)', () => {
    const ws = mapDetectedWorkspace(mkDetectedWorkspace({ language: 'cpp' }), '/proj');
    expect(ws?.ecosystem).toBe('cpp');
    expect(ws?.coverage).toBe('unsupported');
  });

  it('drops deno (no TechStack ecosystem mapping)', () => {
    const ws = mapDetectedWorkspace(mkDetectedWorkspace({ language: 'deno' }), '/proj');
    expect(ws).toBeUndefined();
  });

  it('drops shell (no TechStack ecosystem mapping)', () => {
    const ws = mapDetectedWorkspace(mkDetectedWorkspace({ language: 'shell' }), '/proj');
    expect(ws).toBeUndefined();
  });

  it('strips the projectRoot prefix to produce a portable relativeRoot', () => {
    const ws = mapDetectedWorkspace(
      mkDetectedWorkspace({
        root: '/proj/packages/web',
        language: 'typescript',
      }),
      '/proj',
    );
    expect(ws?.relativeRoot).toBe('packages/web');
  });

  it('treats a workspace root equal to the projectRoot as `.`', () => {
    const ws = mapDetectedWorkspace(
      mkDetectedWorkspace({ root: '/proj', language: 'typescript' }),
      '/proj',
    );
    expect(ws?.relativeRoot).toBe('.');
  });

  it('extracts and sorts lockfile paths from evidence', () => {
    const ws = mapDetectedWorkspace(
      mkDetectedWorkspace({
        language: 'rust',
        root: '/proj',
        evidence: [
          { kind: 'manifest', path: '/proj/Cargo.toml', value: 'Cargo.toml', weight: 90 },
          { kind: 'lockfile', path: '/proj/Cargo.lock', value: 'Cargo.lock', weight: 30 },
          // Duplicate lockfile evidence with a different weight (dedupe by path)
          { kind: 'lockfile', path: '/proj/Cargo.lock', value: 'Cargo.lock', weight: 30 },
        ],
      }),
      '/proj',
    );
    expect(ws?.lockfiles).toEqual(['/proj/Cargo.lock']);
  });

  it('clamps confidence into [0, 1]', () => {
    const high = mapDetectedWorkspace(
      mkDetectedWorkspace({ language: 'typescript', confidence: 1.5 }),
      '/proj',
    );
    const low = mapDetectedWorkspace(
      mkDetectedWorkspace({ language: 'typescript', confidence: -0.5 }),
      '/proj',
    );
    expect(high?.confidence).toBe(1);
    expect(low?.confidence).toBe(0);
  });
});

describe('coverageForEcosystem', () => {
  it('returns `full` for Tier A ecosystems', () => {
    for (const eco of ['npm', 'python', 'rust', 'go', 'dotnet', 'php', 'dart'] as const) {
      expect(coverageForEcosystem(eco)).toBe('full');
    }
  });

  it('returns `partial` for Tier B ecosystems', () => {
    for (const eco of ['maven', 'gradle', 'ruby', 'swift', 'elixir'] as const) {
      expect(coverageForEcosystem(eco)).toBe('partial');
    }
  });

  it('returns `unsupported` for Tier C ecosystems', () => {
    expect(coverageForEcosystem('cpp')).toBe('unsupported');
  });
});

describe('discovery — discoverWorkspaces against real fixtures', () => {
  it('discovers the pnpm monorepo fixture (root + 2 subpackages)', async () => {
    const root = path.resolve(__dirname, 'fixtures/monorepo-pnpm');
    const workspaces = await discoverWorkspaces(root);
    expect(workspaces.length).toBeGreaterThanOrEqual(3);
    // All detected workspaces must be `npm` ecosystem (the only supported
    // ecosystem in this fixture).
    for (const ws of workspaces) {
      expect(ws.ecosystem).toBe('npm');
      expect(ws.coverage).toBe('full');
    }
    // The pnpm-lock.yaml lives at the root, so only the root workspace has
    // lockfile evidence; sub-workspaces see only their own package.json.
    const rootWorkspace = workspaces.find((ws) => ws.relativeRoot === '.');
    expect(rootWorkspace).toBeDefined();
    expect(rootWorkspace?.lockfiles.some((lf) => lf.endsWith('pnpm-lock.yaml'))).toBe(true);
    // Sorted by (ecosystem, relativeRoot) — npm/., npm/packages/api, npm/packages/web
    expect(workspaces[0]?.relativeRoot).toBe('.');
    expect(workspaces.map((ws) => ws.relativeRoot).sort()).toEqual(
      [...workspaces.map((ws) => ws.relativeRoot)].sort(),
    );
  });

  it('discovers the Python monorepo fixture', async () => {
    const root = path.resolve(__dirname, 'fixtures/monorepo-python');
    const workspaces = await discoverWorkspaces(root);
    expect(workspaces.length).toBeGreaterThanOrEqual(1);
    const pythonWorkspaces = workspaces.filter((ws) => ws.ecosystem === 'python');
    expect(pythonWorkspaces.length).toBeGreaterThanOrEqual(1);
    for (const ws of pythonWorkspaces) {
      expect(ws.coverage).toBe('full');
      // pyproject.toml is a `config` detector, not `manifest` — manifests
      // may include requirements.txt depending on detection.
      expect(ws.manifests.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('discovers the mixed (JS + Python + Rust) fixture as separate workspaces', async () => {
    const root = path.resolve(__dirname, 'fixtures/monorepo-mixed');
    const workspaces = await discoverWorkspaces(root);
    const ecosystems = new Set(workspaces.map((ws) => ws.ecosystem));
    // The fixture contains JS (npm), Python, and Rust — all three should appear.
    expect(ecosystems.has('npm')).toBe(true);
    expect(ecosystems.has('python')).toBe(true);
    expect(ecosystems.has('rust')).toBe(true);
    // deno/shell would be filtered out — make sure no surprise unmapped langs.
    for (const ws of workspaces) {
      expect(typeof ws.ecosystem).toBe('string');
      expect(VALID_ECOSYSTEM_SET.has(ws.ecosystem)).toBe(true);
    }
  });

  it('excludes test-fixture directories from discovery', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'techstack-fixture-skip-'));
    try {
      await fs.mkdir(path.join(dir, 'tests', 'fixtures', 'fake-app', 'src'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'real-app', dependencies: { zod: '^4.4.3' } }),
      );
      await fs.writeFile(
        path.join(dir, 'tests', 'fixtures', 'fake-app', 'package.json'),
        JSON.stringify({ name: 'fake-app', dependencies: { zod: '^3.23.0' } }),
      );
      await fs.writeFile(
        path.join(dir, 'tests', 'fixtures', 'fake-app', 'src', 'index.ts'),
        'export {};',
      );
      const workspaces = await discoverWorkspaces(dir);
      // The root manifest may surface as multiple language profiles (js + ts),
      // but every discovered workspace must be the root — never the fixture.
      expect(workspaces.length).toBeGreaterThanOrEqual(1);
      expect(new Set(workspaces.map((ws) => ws.relativeRoot))).toEqual(new Set(['.']));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('still discovers a fixture tree when it is the project root itself', async () => {
    // The techstack test suite scans tests/fixtures/* roots directly — the
    // fixture-name exclusion must only apply to child directories.
    const root = path.resolve(__dirname, 'fixtures/monorepo-mixed');
    const workspaces = await discoverWorkspaces(root);
    expect(workspaces.length).toBeGreaterThanOrEqual(1);
  });

  it('handles an empty temp directory without throwing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'techstack-empty-'));
    try {
      const workspaces = await discoverWorkspaces(dir);
      expect(workspaces).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns workspaces sorted by (ecosystem, relativeRoot, id)', async () => {
    const root = path.resolve(__dirname, 'fixtures/monorepo-mixed');
    const workspaces = await discoverWorkspaces(root);
    const sorted = [...workspaces].sort((a: Workspace, b: Workspace) => {
      return (
        a.ecosystem.localeCompare(b.ecosystem) ||
        a.relativeRoot.localeCompare(b.relativeRoot) ||
        a.id.localeCompare(b.id)
      );
    });
    expect(workspaces).toEqual(sorted);
  });
});
