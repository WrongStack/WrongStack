import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withFileLock } from '../src/atomic-write.js';

const names = [
  { label: 'short-name control', name: 'control.json' },
  { label: 'last unshortened lock name', name: `${'a'.repeat(244)}.json` },
  { label: 'first oversized lock name', name: `${'a'.repeat(245)}.json` },
  { label: '255-byte target', name: `${'a'.repeat(250)}.json` },
  { label: 'multibyte target', name: `${'é'.repeat(125)}.json` },
];

describe('file locks for filesystem-valid long names', () => {
  it.each(names)('acquires and releases a $label', async ({ name }) => {
    const dir = await mkdtemp(join(tmpdir(), 'lock-long-'));
    const target = join(dir, name);
    try {
      await writeFile(target, 'original');
      await expect(readFile(target, 'utf8')).resolves.toBe('original');
      await expect(
        withFileLock(
          target,
          async () => {
            await writeFile(target, 'updated');
            return 'callback-result';
          },
          { timeoutMs: 200 },
        ),
      ).resolves.toBe('callback-result');
      await expect(readFile(target, 'utf8')).resolves.toBe('updated');
      await expect(readdir(dir)).resolves.toEqual([name]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reclaims a stale lock whose recovery filename would exceed the component limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lock-long-stale-'));
    const name = `${'a'.repeat(244)}.json`;
    const target = join(dir, name);
    const lock = join(dir, `.${name}.lock`);
    try {
      await writeFile(target, 'original');
      await writeFile(lock, 'abandoned:token');
      const past = new Date(Date.now() - 60_000);
      await utimes(lock, past, past);
      await expect(
        withFileLock(target, async () => 'recovered', { timeoutMs: 200, staleMs: 1_000 }),
      ).resolves.toBe('recovered');
      await expect(readdir(dir)).resolves.toEqual([name]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('releases a shortened lock after a failed callback so the next caller can acquire it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lock-long-failure-'));
    const target = join(dir, `${'a'.repeat(250)}.json`);
    const failure = new Error('callback failed');
    try {
      await expect(
        withFileLock(
          target,
          async () => {
            throw failure;
          },
          { timeoutMs: 200 },
        ),
      ).rejects.toBe(failure);
      await expect(readdir(dir)).resolves.toEqual([]);
      await expect(withFileLock(target, async () => 'next', { timeoutMs: 200 })).resolves.toBe(
        'next',
      );
      await expect(readdir(dir)).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses the same shortened lock for contenders while keeping distinct long targets independent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lock-long-contenders-'));
    const target = join(dir, `${'a'.repeat(250)}.json`);
    const other = join(dir, `${'b'.repeat(250)}.json`);
    try {
      await withFileLock(
        target,
        async () => {
          await expect(
            withFileLock(target, async () => 'must not enter', { timeoutMs: 0 }),
          ).rejects.toMatchObject({ code: 'FS_ATOMIC_WRITE_FAILED' });
          if (process.platform === 'win32') {
            await expect(
              withFileLock(target.toUpperCase(), async () => 'must not enter via case alias', {
                timeoutMs: 0,
              }),
            ).rejects.toMatchObject({ code: 'FS_ATOMIC_WRITE_FAILED' });
          }
          await expect(
            withFileLock(other, async () => 'independent', { timeoutMs: 0 }),
          ).resolves.toBe('independent');
        },
        { timeoutMs: 200 },
      );
      await expect(withFileLock(target, async () => 'released', { timeoutMs: 200 })).resolves.toBe(
        'released',
      );
      await expect(readdir(dir)).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
