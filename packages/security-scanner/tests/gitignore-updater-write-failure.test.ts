import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({
  failWrite: false,
}));

vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/utils')>();
  return {
    ...actual,
    atomicWrite: async (target: string, content: string | Uint8Array, opts?: unknown) => {
      if (seam.failWrite) throw new Error('ENOSPC: no space left on device');
      return actual.atomicWrite(target, content, opts as never);
    },
  };
});

import { GitignoreUpdater } from '../src/gitignore-updater.js';

const dirs: string[] = [];

afterEach(async () => {
  seam.failWrite = false;
  for (const d of dirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

describe('GitignoreUpdater write-failure reporting', () => {
  it('does not report entries as added when atomicWrite fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitignore-fail-'));
    dirs.push(dir);
    const file = path.join(dir, '.gitignore');
    await fs.writeFile(file, 'node_modules/\n', 'utf8');

    seam.failWrite = true;
    const res = await new GitignoreUpdater({
      gitignorePath: file,
      entries: ['security-reports/', 'node_modules/'],
    }).update();

    expect(res.errors).toHaveLength(1);
    expect(res.added).toEqual([]);
    expect(res.existing).toEqual(['node_modules/']);
  });
});
