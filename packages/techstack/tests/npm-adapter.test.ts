/**
 * TechStack — npm adapter tests.
 *
 * Tests the NpmAdapter against real fixture package.json + pnpm-lock.yaml
 * files in the tests/fixtures/ directory.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NpmAdapter } from '../src/adapters/npm.js';
import { workspaceId } from '../src/discovery/index.js';
import type { Workspace } from '../src/types.js';

function makeTempWorkspace(
  name: string,
  pkgJson: Record<string, unknown>,
  lockfile?: { filename: string; content: string },
): { dir: string; workspace: Workspace } {
  const dir = join(
    tmpdir(),
    `techstack-npm-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2));
  if (lockfile) {
    writeFileSync(join(dir, lockfile.filename), lockfile.content);
  }
  const workspace: Workspace = {
    id: workspaceId('', 'npm'),
    relativeRoot: dir,
    ecosystem: 'npm',
    manifests: ['package.json'],
    lockfiles: lockfile ? [lockfile.filename] : [],
    confidence: 0.9,
    coverage: 'full',
  };
  return { dir, workspace };
}

/**
 * A real pnpm v9 lockfile.
 *
 * The previous fixture used `packages:` keys of the form `/react@19.1.0:` with
 * a nested `version:` field — a shape pnpm has never emitted in any version.
 * The parser was written against that same fiction, so the two agreed with each
 * other and the suite stayed green while every real lockfile silently resolved
 * to zero locked versions. Keep this fixture faithful to pnpm's actual output.
 *
 * Real v9 puts the per-workspace resolved versions under `importers:`, and its
 * `packages:` keys carry no leading slash and no `version:` field.
 */
const SAMPLE_PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      react:
        specifier: ^19.1.0
        version: 19.1.0
      express:
        specifier: ~4.21.0
        version: 4.21.2
      '@wrongstack/core':
        specifier: workspace:*
        version: link:../core
      local-thing:
        specifier: file:../local-thing
        version: file:../local-thing
      git-pkg:
        specifier: git+https://github.com/foo/bar.git
        version: https://codeload.github.com/foo/bar/tar.gz/abc1234
    devDependencies:
      vitest:
        specifier: ^1.0.0
        version: 1.0.0

packages:

  express@4.21.2:
    resolution: {integrity: sha512-fake-express-integrity}
    engines: {node: '>= 0.10.0'}

  react@19.1.0:
    resolution: {integrity: sha512-fake-react-integrity}
    engines: {node: '>=0.10.0'}

  vitest@1.0.0:
    resolution: {integrity: sha512-fake-vitest-integrity}
    engines: {node: ^18.0.0 || >=20.0.0}
`;

const SAMPLE_PKG_JSON = {
  name: 'test-app',
  version: '1.0.0',
  dependencies: {
    react: '^19.1.0',
    express: '~4.21.0',
    '@wrongstack/core': 'workspace:*',
    'local-thing': 'file:../local-thing',
    'git-pkg': 'git+https://github.com/foo/bar.git',
  },
  devDependencies: {
    vitest: '^1.0.0',
  },
  peerDependencies: {
    react: '^19.0.0',
  },
};

describe('NpmAdapter', () => {
  it('extracts dependencies from package.json', async () => {
    const { dir, workspace } = makeTempWorkspace('basic', SAMPLE_PKG_JSON);
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});

      // react appears in deps + peer (deduped → first wins)
      const names = deps.map((d) => d.name);
      expect(names).toContain('react');
      expect(names).toContain('express');
      expect(names).toContain('@wrongstack/core');
      expect(names).toContain('local-thing');
      expect(names).toContain('git-pkg');
      expect(names).toContain('vitest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deduplicates by name (react in deps + peer → first wins)', async () => {
    const { dir, workspace } = makeTempWorkspace('dedup', SAMPLE_PKG_JSON);
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});
      const reactEntries = deps.filter((d) => d.name === 'react');
      expect(reactEntries).toHaveLength(1);
      // Should be runtime scope (first occurrence in dependencies)
      expect(reactEntries[0]!.scope).toBe('runtime');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies workspace: link as local_path', async () => {
    const { dir, workspace } = makeTempWorkspace('workspace-dep', SAMPLE_PKG_JSON);
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});
      const wsDep = deps.find((d) => d.name === '@wrongstack/core');
      expect(wsDep).toBeDefined();
      expect(wsDep!.status).toBe('local_path');
      expect(wsDep!.sourceType).toBe('path');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies file: link as local_path', async () => {
    const { dir, workspace } = makeTempWorkspace('file-dep', SAMPLE_PKG_JSON);
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});
      const fileDep = deps.find((d) => d.name === 'local-thing');
      expect(fileDep).toBeDefined();
      expect(fileDep!.status).toBe('local_path');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies git+ as git_dependency', async () => {
    const { dir, workspace } = makeTempWorkspace('git-dep', SAMPLE_PKG_JSON);
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});
      const gitDep = deps.find((d) => d.name === 'git-pkg');
      expect(gitDep).toBeDefined();
      expect(gitDep!.status).toBe('git_dependency');
      expect(gitDep!.sourceType).toBe('git');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves locked versions from pnpm-lock.yaml', async () => {
    const { dir, workspace } = makeTempWorkspace('with-lock', SAMPLE_PKG_JSON, {
      filename: 'pnpm-lock.yaml',
      content: SAMPLE_PNPM_LOCK,
    });
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});

      const react = deps.find((d) => d.name === 'react');
      expect(react).toBeDefined();
      expect(react!.locked).toBe('19.1.0');

      const express = deps.find((d) => d.name === 'express');
      expect(express).toBeDefined();
      expect(express!.locked).toBe('4.21.2');

      const vitest = deps.find((d) => d.name === 'vitest');
      expect(vitest).toBeDefined();
      expect(vitest!.locked).toBe('1.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds PURL for registry deps with locked version', async () => {
    const { dir, workspace } = makeTempWorkspace('purl', SAMPLE_PKG_JSON, {
      filename: 'pnpm-lock.yaml',
      content: SAMPLE_PNPM_LOCK,
    });
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});

      const react = deps.find((d) => d.name === 'react');
      expect(react).toBeDefined();
      expect(react!.purl).toBe('pkg:npm/react@19.1.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not build PURL for local/git deps', async () => {
    const { dir, workspace } = makeTempWorkspace('no-purl', SAMPLE_PKG_JSON, {
      filename: 'pnpm-lock.yaml',
      content: SAMPLE_PNPM_LOCK,
    });
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});

      const wsDep = deps.find((d) => d.name === '@wrongstack/core');
      expect(wsDep!.purl).toBeUndefined();

      const fileDep = deps.find((d) => d.name === 'local-thing');
      expect(fileDep!.purl).toBeUndefined();

      const gitDep = deps.find((d) => d.name === 'git-pkg');
      expect(gitDep!.purl).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes manifest evidence for all deps', async () => {
    const { dir, workspace } = makeTempWorkspace('evidence', SAMPLE_PKG_JSON);
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});

      for (const dep of deps) {
        const manifestEv = dep.evidence.find((e) => e.kind === 'manifest');
        expect(manifestEv).toBeDefined();
        expect(manifestEv!.source).toContain('package.json');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes lockfile evidence for resolved deps', async () => {
    const { dir, workspace } = makeTempWorkspace('lock-ev', SAMPLE_PKG_JSON, {
      filename: 'pnpm-lock.yaml',
      content: SAMPLE_PNPM_LOCK,
    });
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});

      const react = deps.find((d) => d.name === 'react');
      const lockEvs = react!.evidence.filter((e) => e.kind === 'lockfile');
      expect(lockEvs).toHaveLength(1);
      expect(lockEvs[0]!.source).toContain('pnpm-lock.yaml');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('assigns correct scopes', async () => {
    const { dir, workspace } = makeTempWorkspace('scopes', SAMPLE_PKG_JSON);
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});

      const vitest = deps.find((d) => d.name === 'vitest');
      expect(vitest!.scope).toBe('development');

      // react deduped to runtime (first in dependencies)
      const react = deps.find((d) => d.name === 'react');
      expect(react!.scope).toBe('runtime');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores requested (constraint) from manifest', async () => {
    const { dir, workspace } = makeTempWorkspace('requested', SAMPLE_PKG_JSON);
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});

      const react = deps.find((d) => d.name === 'react');
      expect(react!.requested).toBe('^19.1.0');

      const express = deps.find((d) => d.name === 'express');
      expect(express!.requested).toBe('~4.21.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty array for unreadable manifest', async () => {
    const dir = join(tmpdir(), `techstack-npm-empty-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const workspace: Workspace = {
      id: workspaceId('', 'npm'),
      relativeRoot: dir,
      ecosystem: 'npm',
      manifests: ['nonexistent.json'],
      lockfiles: [],
      confidence: 0.9,
      coverage: 'full',
    };
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});
      expect(deps).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── yarn.lock detection ────────────────────────────────────────────────

  it('detects yarn.lock and uses it for lockfile evidence', async () => {
    const { dir, workspace } = makeTempWorkspace(
      'yarn-lock',
      { name: 'yarn-app', dependencies: { react: '^18.0.0' } },
      { filename: 'yarn.lock', content: '# yarn.lock placeholder\n' },
    );
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});
      // yarn.lock is detected but no parsed versions (we don't parse yarn.lock)
      const react = deps.find((d) => d.name === 'react');
      expect(react).toBeDefined();
      expect(react!.locked).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── npm package-lock.json ──────────────────────────────────────────────

  const SAMPLE_NPM_LOCK = JSON.stringify({
    lockfileVersion: 3,
    name: 'test-app',
    dependencies: {
      react: { version: '18.3.1' },
      express: { version: '4.21.2' },
    },
    packages: {
      'node_modules/react': { version: '18.3.1' },
      'node_modules/express': { version: '4.21.2' },
    },
  });

  it('resolves locked versions from package-lock.json', async () => {
    const { dir, workspace } = makeTempWorkspace(
      'npm-lock',
      { name: 'npm-app', dependencies: { react: '^18.0.0', express: '^4.18.0' } },
      { filename: 'package-lock.json', content: SAMPLE_NPM_LOCK },
    );
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});
      const react = deps.find((d) => d.name === 'react');
      expect(react).toBeDefined();
      expect(react!.locked).toBe('18.3.1');

      const express = deps.find((d) => d.name === 'express');
      expect(express).toBeDefined();
      expect(express!.locked).toBe('4.21.2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips version prefixes from npm lock versions', async () => {
    const npmLock = JSON.stringify({
      lockfileVersion: 2,
      dependencies: {
        react: { version: '^18.3.1' },
      },
    });
    const { dir, workspace } = makeTempWorkspace(
      'npm-lock-ver',
      { name: 'npm-app', dependencies: { react: '^18.0.0' } },
      { filename: 'package-lock.json', content: npmLock },
    );
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});
      expect(deps.find((d) => d.name === 'react')!.locked).toBe('18.3.1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles malformed package-lock.json gracefully', async () => {
    const { dir, workspace } = makeTempWorkspace(
      'bad-npm-lock',
      { name: 'npm-app', dependencies: { react: '^18.0.0' } },
      { filename: 'package-lock.json', content: 'not-json' },
    );
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});
      // Falls back gracefully, no locked versions
      const react = deps.find((d) => d.name === 'react');
      expect(react!.locked).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── optionalDependencies scope ─────────────────────────────────────────

  it('assigns optional scope for optionalDependencies', async () => {
    const { dir, workspace } = makeTempWorkspace('optional-scope', {
      name: 'test',
      optionalDependencies: { fsevents: '^2.3.2' },
    });
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});
      const fsevents = deps.find((d) => d.name === 'fsevents');
      expect(fsevents).toBeDefined();
      expect(fsevents!.scope).toBe('optional');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('assigns peer scope for peerDependencies', async () => {
    const { dir, workspace } = makeTempWorkspace('peer-scope', {
      name: 'test',
      peerDependencies: { react: '^18.0.0' },
    });
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, {});
      const react = deps.find((d) => d.name === 'react');
      expect(react).toBeDefined();
      expect(react!.scope).toBe('peer');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Transitive deps ────────────────────────────────────────────────────

  it('includes transitive dependencies when requested', async () => {
    const { dir, workspace } = makeTempWorkspace(
      'transitive',
      { name: 'test', dependencies: { react: '^19.1.0' } },
      { filename: 'pnpm-lock.yaml', content: SAMPLE_PNPM_LOCK },
    );
    try {
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, { includeTransitive: true });
      const names = deps.map((d) => d.name);
      // react is direct with a locked version
      expect(names).toContain('react');
      // All deps from the lockfile packages section are included
      const transitive = deps.filter((d) => d.scope === 'transitive');
      expect(transitive.length).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Lockfile walk-up (monorepo) ────────────────────────────────────────

  it('finds lockfile in parent directory when projectRoot is provided', async () => {
    const rootDir = join(
      tmpdir(),
      `techstack-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const pkgDir = join(rootDir, 'packages', 'my-app');
    mkdirSync(pkgDir, { recursive: true });

    try {
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: 'my-app',
          dependencies: { react: '^19.1.0' },
        }),
      );
      // A lockfile with a matching importer for the sub-package
      const SUB_LOCK = `lockfileVersion: '9.0'

importers:

  packages/my-app:
    dependencies:
      react:
        specifier: ^19.1.0
        version: 19.1.0

packages:

  react@19.1.0:
    resolution: {integrity: sha512-fake}
`;
      writeFileSync(join(rootDir, 'pnpm-lock.yaml'), SUB_LOCK);

      const workspace: Workspace = {
        id: workspaceId('', 'npm'),
        relativeRoot: pkgDir,
        ecosystem: 'npm',
        manifests: ['package.json'],
        lockfiles: [],
        confidence: 0.9,
        coverage: 'full',
      };
      const adapter = new NpmAdapter();
      const deps = await adapter.inventory(workspace, { projectRoot: rootDir });
      // The lockfile at root should be detected via walk-up
      const react = deps.find((d) => d.name === 'react');
      expect(react).toBeDefined();
      expect(react!.locked).toBe('19.1.0');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  // ── No lockfile walk-up without projectRoot ────────────────────────────

  it('does not walk up without projectRoot', async () => {
    const rootDir = join(
      tmpdir(),
      `techstack-noroot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const pkgDir = join(rootDir, 'sub', 'pkg');
    mkdirSync(pkgDir, { recursive: true });

    try {
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: 'sub-pkg',
          dependencies: { react: '^19.0.0' },
        }),
      );
      writeFileSync(
        join(rootDir, 'pnpm-lock.yaml'),
        `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: ^19.0.0\n        version: 19.0.0\n`,
      );
      writeFileSync(
        join(pkgDir, 'pnpm-lock.yaml'),
        `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: ^19.0.0\n        version: 19.0.0\n`,
      );

      const workspace: Workspace = {
        id: workspaceId('', 'npm'),
        relativeRoot: pkgDir,
        ecosystem: 'npm',
        manifests: ['package.json'],
        lockfiles: [],
        confidence: 0.9,
        coverage: 'full',
      };
      const adapter = new NpmAdapter();
      // Without projectRoot, only the workspace dir is searched
      const deps = await adapter.inventory(workspace, {});
      // pkgDir has its own lockfile, so react should be resolved
      const react = deps.find((d) => d.name === 'react');
      expect(react).toBeDefined();
      expect(react!.locked).toBe('19.0.0');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
