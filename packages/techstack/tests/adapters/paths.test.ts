/**
 * TechStack — adapter path resolution.
 *
 * Regression cover for the defect that silently emptied the inventory: every
 * adapter resolved `Workspace.relativeRoot` against `process.cwd()`, and npm,
 * Go, and Rust additionally `join`ed that relative root onto the *absolute*
 * manifest paths discovery hands them. Every read threw, the engine's
 * `catch { deps = [] }` swallowed it, and the UI showed a clean empty table.
 *
 * @see packages/techstack/src/adapters/paths.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NpmAdapter } from '../../src/adapters/npm.js';
import { resolveIn, workspaceRoot } from '../../src/adapters/paths.js';
import type { Workspace } from '../../src/types.js';

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    relativeRoot: 'packages/app',
    ecosystem: 'npm',
    manifests: ['package.json'],
    lockfiles: [],
    confidence: 0.9,
    coverage: 'full',
    ...overrides,
  };
}

describe('workspaceRoot', () => {
  it('resolves the workspace against the project root', () => {
    const root = workspaceRoot(makeWorkspace(), { projectRoot: `${sep}projects${sep}repo` });
    expect(root).toBe(resolve(`${sep}projects${sep}repo`, 'packages/app'));
  });

  it('maps the root workspace onto the project root itself', () => {
    const root = workspaceRoot(makeWorkspace({ relativeRoot: '.' }), {
      projectRoot: `${sep}projects${sep}repo`,
    });
    expect(root).toBe(resolve(`${sep}projects${sep}repo`));
  });

  it('does not depend on the process working directory', () => {
    const options = { projectRoot: resolve(`${sep}projects${sep}repo`) };
    const before = workspaceRoot(makeWorkspace(), options);
    const cwd = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(workspaceRoot(makeWorkspace(), options)).toBe(before);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('resolveIn', () => {
  it('returns an already-absolute candidate unchanged', () => {
    const absolute = resolve(`${sep}projects${sep}repo${sep}packages${sep}app${sep}package.json`);
    expect(resolveIn(resolve(`${sep}projects${sep}repo`), absolute)).toBe(absolute);
  });

  it('resolves a bare filename against the root', () => {
    const root = resolve(`${sep}projects${sep}repo`);
    expect(resolveIn(root, 'package.json')).toBe(join(root, 'package.json'));
  });
});

// ── End-to-end: the shape that actually broke ─────────────────────────────

describe('NpmAdapter path handling', () => {
  let dir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'techstack-paths-'));
    mkdirSync(join(dir, 'packages', 'app'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'app', 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { react: '^19.1.0' } }),
    );
    writeFileSync(
      join(dir, 'pnpm-lock.yaml'),
      [
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '',
        '  packages/app:',
        '    dependencies:',
        '      react:',
        '        specifier: ^19.1.0',
        '        version: 19.1.0',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('inventories a nested workspace given absolute manifest paths from discovery', async () => {
    // Discovery reports absolute manifests alongside a project-relative root.
    // `join`ing the two produced `packages/app/D:/…/package.json` and the read
    // threw — this is the exact combination that returned [] for all 54 npm
    // workspaces in this repo.
    const workspace = makeWorkspace({
      relativeRoot: join('packages', 'app'),
      manifests: [join(dir, 'packages', 'app', 'package.json')],
    });

    const deps = await new NpmAdapter().inventory(workspace, { projectRoot: dir });

    expect(deps.map((d) => d.name)).toEqual(['react']);
  });

  it('inventories the same workspace from an unrelated working directory', async () => {
    const workspace = makeWorkspace({
      relativeRoot: join('packages', 'app'),
      manifests: [join(dir, 'packages', 'app', 'package.json')],
    });

    process.chdir(tmpdir());
    const deps = await new NpmAdapter().inventory(workspace, { projectRoot: dir });

    expect(deps.map((d) => d.name)).toEqual(['react']);
  });

  it('finds the workspace-root lockfile from a nested package that has none', async () => {
    // pnpm keeps one lockfile at the repo root; `packages/app` has no lockfile
    // of its own, so looking only in the workspace directory leaves every
    // nested package with no resolved version.
    const workspace = makeWorkspace({
      relativeRoot: join('packages', 'app'),
      manifests: [join(dir, 'packages', 'app', 'package.json')],
    });

    const deps = await new NpmAdapter().inventory(workspace, { projectRoot: dir });

    expect(deps[0]?.locked).toBe('19.1.0');
    expect(deps[0]?.evidence.some((e) => e.kind === 'lockfile')).toBe(true);
  });

  it('picks package.json rather than whichever manifest sorts first', async () => {
    // Discovery reports tsconfig.json as a manifest too, and sorts them —
    // `manifests[0]` is not a contract.
    const workspace = makeWorkspace({
      relativeRoot: join('packages', 'app'),
      manifests: [
        join(dir, 'packages', 'app', 'jsconfig.json'),
        join(dir, 'packages', 'app', 'package.json'),
      ],
    });

    const deps = await new NpmAdapter().inventory(workspace, { projectRoot: dir });

    expect(deps.map((d) => d.name)).toEqual(['react']);
  });
});
