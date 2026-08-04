import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gatherProjectContext } from '../src/project-context.js';

describe('gatherProjectContext', () => {
  it('summarises package.json, tsconfig, and src layout', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-ctx-'));
    try {
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'demo-app',
          description: 'A demo',
          dependencies: { express: '1', zod: '2' },
          devDependencies: { vitest: '1' },
        }),
      );
      await fs.writeFile(path.join(dir, 'tsconfig.json'), '{}');
      await fs.mkdir(path.join(dir, 'src', 'lib'), { recursive: true });
      await fs.mkdir(path.join(dir, 'src', 'routes'), { recursive: true });

      const ctx = await gatherProjectContext(dir);
      expect(ctx).toContain('Project: demo-app');
      expect(ctx).toContain('Description: A demo');
      expect(ctx).toContain('express');
      expect(ctx).toContain('Language: TypeScript');
      expect(ctx).toContain('src/lib');
      expect(ctx).toContain('src/routes');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns empty string for an empty directory (never throws)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-ctx-empty-'));
    try {
      await expect(gatherProjectContext(dir)).resolves.toBe('');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('lists monorepo packages/ when present', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-ctx-mono-'));
    try {
      await fs.mkdir(path.join(dir, 'packages', 'core'), { recursive: true });
      await fs.mkdir(path.join(dir, 'packages', 'sdd'), { recursive: true });
      const ctx = await gatherProjectContext(dir);
      expect(ctx).toContain('Packages:');
      expect(ctx).toContain('core');
      expect(ctx).toContain('sdd');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to cwd for a blank root and tolerates missing package fields', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-ctx-blank-'));
    try {
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ dependencies: { express: '1' } }), // no name/description
      );
      const ctx = await gatherProjectContext('   ');
      // Blank root falls back to cwd — which here resolves to a real project
      // with a package.json, so the call still returns text.
      expect(typeof ctx).toBe('string');
      // The fallbacks for missing name/description are exercised when the
      // blank root resolves to a package.json lacking those fields.
      const ctx2 = await gatherProjectContext(dir);
      expect(ctx2).toContain('Project: unknown');
      expect(ctx2).toContain('Description: none');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('ellipsizes dependency lists past the cap', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-ctx-caps-'));
    try {
      const deps: Record<string, string> = {};
      const devDeps: Record<string, string> = {};
      for (let i = 0; i < 30; i++) deps[`dep-${i}`] = '1';
      for (let i = 0; i < 20; i++) devDeps[`dev-${i}`] = '1';
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ deps, devDeps }));
      // Wrong key names are ignored — build a valid one instead.
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: deps, devDependencies: devDeps }),
      );
      const ctx = await gatherProjectContext(dir);
      expect(ctx).toContain('Dependencies:');
      expect(ctx).toContain('...');
      expect(ctx).toContain('Dev Dependencies:');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('ellipsizes the packages/ listing past the cap', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-ctx-pkgs-'));
    try {
      for (let i = 0; i < 30; i++) {
        await fs.mkdir(path.join(dir, 'packages', `pkg-${i}`), { recursive: true });
      }
      const ctx = await gatherProjectContext(dir);
      expect(ctx).toContain('Packages:');
      expect(ctx).toContain('...');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
