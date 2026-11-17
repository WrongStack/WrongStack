import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicReplaceWithWriter, atomicWrite } from '../src/atomic-write.js';

const names = [
  { label: 'a short name', baseName: 'control.txt' },
  { label: 'the 237-byte unshortened-prefix boundary', baseName: `${'a'.repeat(233)}.txt` },
  { label: 'the first oversized temporary name', baseName: `${'a'.repeat(234)}.txt` },
  { label: 'a 244-byte name', baseName: `${'a'.repeat(240)}.txt` },
  { label: 'the 255-byte component limit', baseName: `${'a'.repeat(251)}.txt` },
  { label: 'a multibyte UTF-8 name', baseName: `${'é'.repeat(118)}.txt` },
  { label: 'a supplementary-Unicode name', baseName: `${'😀'.repeat(59)}.txt` },
];

describe.each(['buffered', 'streamed'] as const)('%s atomic replacement', (kind) => {
  it.each(names)('supports $label', async ({ baseName }) => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-long-name-'));
    const target = join(dir, baseName);
    try {
      // Prove the target component and full path are accepted by the filesystem.
      await writeFile(target, 'original');
      await expect(readFile(target, 'utf8')).resolves.toBe('original');
      if (kind === 'buffered') {
        await expect(atomicWrite(target, 'replacement')).resolves.toBeUndefined();
      } else {
        await expect(
          atomicReplaceWithWriter(target, async (handle) => {
            await handle.writeFile('replacement');
            return 'writer-result';
          }),
        ).resolves.toBe('writer-result');
      }
      await expect(readFile(target, 'utf8')).resolves.toBe('replacement');
      await expect(readdir(dir)).resolves.toEqual([baseName]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it('preserves a long-named target and removes its temp when the streaming writer fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-long-failure-'));
  const baseName = `${'a'.repeat(240)}.txt`;
  const target = join(dir, baseName);
  const failure = new Error('streaming writer failed');
  try {
    await writeFile(target, 'original');
    await expect(
      atomicReplaceWithWriter(target, async (handle) => {
        await handle.writeFile('partial');
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(readFile(target, 'utf8')).resolves.toBe('original');
    await expect(readdir(dir)).resolves.toEqual([baseName]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
