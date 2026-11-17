import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readManifest, writeManifest } from '../src/manifest-cache.js';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-long-name-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const tools = [{ name: 'control', inputSchema: { type: 'object' } }];

describe('manifest cache long server names', () => {
  it('round-trips a normal lowercase name', async () => {
    await writeManifest(tmp, 'normal-server', 'hash', tools);
    await expect(readManifest(tmp, 'normal-server', 'hash')).resolves.toEqual(tools);
  });

  it.each([222, 223, 240, 300])('round-trips a %i-character lowercase name', async (length) => {
    const name = 'a'.repeat(length);
    await writeManifest(tmp, name, 'hash', tools);
    await expect(readManifest(tmp, name, 'hash')).resolves.toEqual(tools);
  });

  it('keeps long names that share a prefix independent', async () => {
    const first = `${'a'.repeat(300)}-first`;
    const second = `${'a'.repeat(300)}-second`;
    const otherTools = [{ name: 'other', inputSchema: {} }];
    await writeManifest(tmp, first, 'hash', tools);
    await writeManifest(tmp, second, 'hash', otherTools);
    await expect(readManifest(tmp, first, 'hash')).resolves.toEqual(tools);
    await expect(readManifest(tmp, second, 'hash')).resolves.toEqual(otherTools);
  });
});
