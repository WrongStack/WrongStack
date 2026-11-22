import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInteractiveTrustRepinCallback } from '../src/plugin-host/external-plugins.js';

// The [diff] summary the operator reads before re-pinning a changed plugin must
// count every file it summed, even though it lists only the first few names.
describe('TOFU re-pin [diff] closure summary', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wstack-repin-diff-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports the number of files in the closure, not the number of names listed', async () => {
    const discovery = join(root, 'plugins');
    const dir = join(discovery, 'wide');
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 12; i++)
      await writeFile(join(dir, `f${i}.ts`), `export const v${i} = ${i};`);
    const notes: string[] = [];
    let calls = 0;
    const callback = createInteractiveTrustRepinCallback(
      {
        prompt: async () => (calls++ === 0 ? 'diff' : false),
        notify: (_owner, message) => notes.push(message),
      },
      [discovery],
    );

    const approved = await callback({
      label: 'wide',
      entryPath: join(dir, 'f0.ts'),
      previousIntegrity: 'sha256:11112222',
      nextIntegrity: 'sha256:aaaabbbb',
      pinnedAt: '2026-11-01T00:00:00.000Z',
    });

    expect(approved).toBe(false);
    expect(notes[0]).toContain('Directory closure (12 files, 12 total lines)');
  });
});
