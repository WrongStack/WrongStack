import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { npmAdapter } from '../../src/adapters/npm.js';
import { pythonAdapter } from '../../src/adapters/python.js';
import { rustAdapter } from '../../src/adapters/rust.js';
import type { EcosystemAdapter } from '../../src/adapters/interface.js';
import type { EcosystemId, Workspace } from '../../src/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(
  ecosystem: EcosystemId,
  adapter: EcosystemAdapter,
  files: Record<string, string>,
  manifest: string,
) {
  const root = mkdtempSync(join(tmpdir(), 'techstack-transitive-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(root, name), content, 'utf8');
  const workspace: Workspace = {
    id: `ws-${ecosystem}`,
    relativeRoot: '.',
    ecosystem,
    manifests: [join(root, manifest)],
    lockfiles: [],
    confidence: 1,
    coverage: 'full',
  };
  return adapter.inventory(workspace, { projectRoot: root, includeTransitive: true });
}

describe('includeTransitive', () => {
  it('adds npm lock-only packages', async () => {
    const deps = await run(
      'npm',
      npmAdapter,
      {
        'package.json': JSON.stringify({ dependencies: { direct: '^1.0.0' } }),
        'pnpm-lock.yaml':
          "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      direct:\n        specifier: ^1.0.0\n        version: 1.1.0\npackages:\n  direct@1.1.0: {}\n  transitive@2.0.0: {}\n",
      },
      'package.json',
    );
    expect(deps.find((dep) => dep.name === 'transitive')).toMatchObject({
      direct: false,
      scope: 'transitive',
      locked: '2.0.0',
    });
  });

  it('adds Cargo.lock-only crates', async () => {
    const deps = await run(
      'rust',
      rustAdapter,
      {
        'Cargo.toml': '[dependencies]\nserde = "1"\n',
        'Cargo.lock':
          '[[package]]\nname = "serde"\nversion = "1.0.0"\n[[package]]\nname = "syn"\nversion = "2.0.0"\n',
      },
      'Cargo.toml',
    );
    expect(deps.find((dep) => dep.name === 'syn')).toMatchObject({
      direct: false,
      scope: 'transitive',
    });
  });

  it('adds poetry.lock-only Python packages', async () => {
    const deps = await run(
      'python',
      pythonAdapter,
      {
        'pyproject.toml': '[project]\ndependencies = ["requests>=2"]\n',
        'poetry.lock':
          '[[package]]\nname = "requests"\nversion = "2.32.0"\n[[package]]\nname = "urllib3"\nversion = "2.2.2"\n',
      },
      'pyproject.toml',
    );
    expect(deps.find((dep) => dep.name === 'urllib3')).toMatchObject({
      direct: false,
      locked: '2.2.2',
    });
  });

  it('parses a 500-package pnpm lockfile within one second', async () => {
    const packages = Array.from(
      { length: 500 },
      (_, index) => `  package-${index}@1.0.${index}: {}`,
    ).join('\n');
    const started = performance.now();
    const deps = await run(
      'npm',
      npmAdapter,
      {
        'package.json': JSON.stringify({ dependencies: { direct: '^1.0.0' } }),
        'pnpm-lock.yaml': `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      direct:\n        specifier: ^1.0.0\n        version: 1.0.0\npackages:\n  direct@1.0.0: {}\n${packages}\n`,
      },
      'package.json',
    );
    expect(deps.filter((dep) => !dep.direct)).toHaveLength(500);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
