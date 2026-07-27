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
});
