import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectScopedDistFiles,
  createBuildManifest,
  validateBuildManifest,
} from '../../../../scripts/lib/build-lineage.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('build lineage', () => {
  it('returns no files for absent workspace roots and ignores non-directory entries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wrongstack-lineage-empty-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'packages'), { recursive: true });
    await writeFile(path.join(root, 'packages', 'README.md'), 'not a package');
    await mkdir(path.join(root, 'external'), { recursive: true });
    await mkdir(path.join(root, 'packages', 'linked-package', 'dist'), { recursive: true });
    await symlink(
      path.join(root, 'external'),
      path.join(root, 'packages', 'linked-package', 'dist', 'linked-entry'),
      'junction',
    );
    await expect(collectScopedDistFiles(root, ['missing', 'packages'])).resolves.toEqual([]);
  });

  it('collects only immediate in-scope workspace dist artifacts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wrongstack-lineage-'));
    temporaryRoots.push(root);
    const packageDist = path.join(root, 'packages/core/dist');
    const appDist = path.join(root, 'apps/desktop/dist');
    const websiteDist = path.join(root, 'website/dist');
    await Promise.all([
      mkdir(packageDist, { recursive: true }),
      mkdir(appDist, { recursive: true }),
      mkdir(websiteDist, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(packageDist, 'index.js'), 'core'),
      writeFile(path.join(appDist, 'main.js'), 'desktop'),
      writeFile(path.join(websiteDist, 'index.html'), 'website'),
    ]);

    await expect(collectScopedDistFiles(root)).resolves.toEqual([
      'apps/desktop/dist/main.js',
      'packages/core/dist/index.js',
    ]);
  });

  it('detects missing, changed, and untracked artifacts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wrongstack-lineage-'));
    temporaryRoots.push(root);
    const coreDist = path.join(root, 'packages/core/dist');
    await mkdir(coreDist, { recursive: true });
    await writeFile(path.join(coreDist, 'index.js'), 'before');
    const manifest = await createBuildManifest(root, ['packages/core/dist/index.js']);

    await writeFile(path.join(coreDist, 'index.js'), 'after');
    await writeFile(path.join(coreDist, 'extra.js'), 'extra');
    await expect(
      validateBuildManifest(root, manifest, await collectScopedDistFiles(root)),
    ).resolves.toEqual([
      'packages/core/dist/index.js: build artifact differs from the lineage manifest',
      'packages/core/dist/extra.js: untracked build artifact',
    ]);

    await expect(validateBuildManifest(root, manifest, [])).resolves.toEqual([
      'packages/core/dist/index.js: missing build artifact',
    ]);
  });

  it('preserves metadata and accepts a matching manifest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wrongstack-lineage-valid-'));
    temporaryRoots.push(root);
    const dist = path.join(root, 'packages/core/dist');
    await mkdir(path.join(dist, 'nested'), { recursive: true });
    await writeFile(path.join(dist, 'nested/index.js'), 'same');
    const files = await collectScopedDistFiles(root);
    const manifest = await createBuildManifest(root, files, {
      commit: 'abc123',
      schemaVersion: 2,
    });

    expect(manifest).toMatchObject({
      schemaVersion: 2,
      commit: 'abc123',
      scope: ['packages', 'apps'],
      excludedPaths: ['website'],
    });
    await expect(validateBuildManifest(root, manifest, files)).resolves.toEqual([]);
    await expect(validateBuildManifest(root, { files: undefined } as never, [])).resolves.toEqual(
      [],
    );
  });

  it('handles unreadable or deleted files gracefully during validation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wrongstack-lineage-unreadable-'));
    temporaryRoots.push(root);
    const dist = path.join(root, 'packages/core/dist');
    await mkdir(dist, { recursive: true });
    const targetFile = path.join(dist, 'temp.js');
    await writeFile(targetFile, 'content');
    const relativePath = 'packages/core/dist/temp.js';
    const manifest = await createBuildManifest(root, [relativePath]);

    // Simulate file deletion right before fingerprinting during validation
    await rm(targetFile);

    await expect(validateBuildManifest(root, manifest, [relativePath])).resolves.toEqual([
      'packages/core/dist/temp.js: missing build artifact',
    ]);
  });
});
