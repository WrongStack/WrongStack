import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { npmAdapter } from '../../src/adapters/npm.js';
import { parseNpmLockVersions } from '../../src/adapters/npm-lockfile-parse.js';
import type { Workspace } from '../../src/types.js';

/**
 * Regression: an npm lockfile v1 `dependencies` map is RECURSIVE. A dependency
 * that npm could not hoist (a version conflict, and everything beneath it)
 * appears only under its parent's own `dependencies`; walking the top-level map
 * alone dropped those instances from `parseNpmLockVersions().versions`, so the
 * adapter's `includeTransitive` pass never emitted them — and OSV is queried
 * per purl, so the nested version was silently unaudited.
 */
const LOCK_V1 = {
  lockfileVersion: 1,
  dependencies: {
    parent: {
      version: '1.0.0',
      dependencies: {
        // Conflict instance: `conflict@1.0.0` is hoisted, `2.0.0` is nested.
        conflict: { version: '2.0.0' },
        // A chain only reachable through nesting.
        deep: {
          version: '3.1.0',
          dependencies: { leaf: { version: '4.0.0' } },
        },
      },
    },
    conflict: { version: '1.0.0' },
  },
};

describe('npm lockfile v1 nested dependency instances', () => {
  it('records instances that exist only under a parent dependencies map', () => {
    const { versions } = parseNpmLockVersions(JSON.stringify(LOCK_V1));

    expect(versions.get('parent')).toEqual(['1.0.0']);
    expect(versions.get('deep')).toEqual(['3.1.0']);
    expect(versions.get('leaf')).toEqual(['4.0.0']);
    // Both instances of the conflicting package, not just the hoisted one.
    expect([...(versions.get('conflict') ?? [])].sort()).toEqual(['1.0.0', '2.0.0']);
  });

  it('still records a top-level alias spelled in the version', () => {
    const { aliases } = parseNpmLockVersions(
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: { 'types-node': { version: 'npm:@types/node@20.1.0' } },
      }),
    );
    expect(aliases.get('types-node')).toBe('@types/node');
  });

  it('records a nested alias instead of the alias install name', () => {
    const { aliases, versions } = parseNpmLockVersions(
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          parent: {
            version: '1.0.0',
            dependencies: { typescript5: { version: 'npm:typescript@5.9.3' } },
          },
        },
      }),
    );
    expect(aliases.get('typescript5')).toBe('typescript');
    expect(versions.get('typescript5')).toEqual(['5.9.3']);
  });

  it('survives a deeply nested map without exhausting the stack', () => {
    let nested: Record<string, unknown> = { leaf: { version: '9.9.9' } };
    for (let depth = 0; depth < 5_000; depth++)
      nested = { [`p${depth}`]: { dependencies: nested } };
    const { versions } = parseNpmLockVersions(
      JSON.stringify({ lockfileVersion: 1, dependencies: nested }),
    );
    expect(versions.get('leaf')).toEqual(['9.9.9']);
  });
});

describe('npm adapter inventories nested v1 instances transitively', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('reports every instance of a package, including the nested conflict', async () => {
    const root = mkdtempSync(join(tmpdir(), 'techstack-npm-v1-nested-'));
    roots.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { parent: '^1.0.0' } }),
      'utf8',
    );
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify(LOCK_V1), 'utf8');

    const workspace: Workspace = {
      id: 'ws-npm-v1',
      relativeRoot: '.',
      ecosystem: 'npm',
      manifests: [join(root, 'package.json')],
      lockfiles: [],
      confidence: 1,
      coverage: 'full',
    };

    const deps = await npmAdapter.inventory(workspace, {
      projectRoot: root,
      includeTransitive: true,
    });

    expect(
      deps
        .filter((dep) => dep.name === 'conflict')
        .map((dep) => dep.locked)
        .sort(),
    ).toEqual(['1.0.0', '2.0.0']);
    expect(deps.find((dep) => dep.name === 'leaf')).toMatchObject({
      direct: false,
      scope: 'transitive',
      locked: '4.0.0',
      purl: 'pkg:npm/leaf@4.0.0',
    });
  });
});
