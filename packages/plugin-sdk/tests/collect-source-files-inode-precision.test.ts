import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * NTFS file ids are 64-bit. As a Number, an `ino` above 2^53 loses its low
 * bits, so two different directories can report the same `dev:ino` (seen on
 * a real repo: packages/plugins/src/config-migration-assistant and
 * monorepo-change-planner). The sync collector took that for a symlink loop
 * and silently skipped the second directory (F1540). Simulated here so the
 * test is platform-independent: Number stats of the twins collide, BigInt
 * stats keep their real, distinct ids.
 */
const TWINS = new Set(['twin-a', 'twin-b']);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statSync = ((path: string, options?: { bigint?: boolean }) => {
    const real = actual.statSync(path, options as never);
    if (options?.bigint || !TWINS.has(basename(String(path)))) return real;
    return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      dev: 7,
      ino: 2 ** 53 + 2,
    });
  }) as typeof actual.statSync;
  return { ...actual, statSync, default: { ...actual, statSync } };
});

const { collectSourceFiles } = await import('../src/runtime/collect-source-files.js');

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sdk-inode-precision-'));
  for (const dir of TWINS) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, `${dir}.ts`), '');
  }
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('collectSourceFiles directory identity', () => {
  it('does not skip a directory whose Number inode collides with a visited one', () => {
    expect(collectSourceFiles(root, { extensions: ['.ts'] })).toEqual([
      join(root, 'twin-a', 'twin-a.ts'),
      join(root, 'twin-b', 'twin-b.ts'),
    ]);
  });
});
