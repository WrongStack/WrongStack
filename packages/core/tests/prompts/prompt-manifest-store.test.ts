import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptManifestStore } from '../../src/prompts/prompt-manifest-store.js';

const entry = (slug: string) => ({
  slug,
  source: 'owner/repo',
  ref: 'v1',
  checksum: 'b'.repeat(64),
  synced: true,
  installedAt: '2026-11-04T00:00:00.000Z',
});
const manifest = (entries: unknown[]) => JSON.stringify({ version: 1, entries }, null, 2);

describe('PromptManifestStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'prompt-manifest-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('loads a UTF-8 BOM manifest the same way record() reads it (F975)', async () => {
    const file = path.join(dir, 'installed-prompts.json');
    await fsp.writeFile(file, `\uFEFF${manifest([entry('bom-prompt')])}`, 'utf8');
    const store = new PromptManifestStore(file);

    expect((await store.load()).entries.map((e) => e.slug)).toEqual(['bom-prompt']);
    expect((await store.list()).map((e) => e.slug)).toEqual(['bom-prompt']);

    // The locked update path must preserve the BOM-loaded entry and rewrite
    // the file without a BOM.
    await store.record(entry('second-prompt'));
    expect((await store.load()).entries.map((e) => e.slug).sort()).toEqual([
      'bom-prompt',
      'second-prompt',
    ]);
    expect((await fsp.readFile(file, 'utf8')).startsWith('\uFEFF')).toBe(false);
  });

  it('still degrades missing and corrupt manifests to an empty list', async () => {
    const missing = new PromptManifestStore(path.join(dir, 'missing.json'));
    expect((await missing.load()).entries).toEqual([]);

    const corrupt = path.join(dir, 'corrupt.json');
    await fsp.writeFile(corrupt, '\uFEFF{not json', 'utf8');
    expect((await new PromptManifestStore(corrupt).load()).entries).toEqual([]);

    const wrongShape = path.join(dir, 'wrong.json');
    await fsp.writeFile(wrongShape, '\uFEFF{"version":1,"entries":"nope"}', 'utf8');
    expect((await new PromptManifestStore(wrongShape).load()).entries).toEqual([]);
  });

  it('refuses to overwrite a structurally wrong manifest during record()', async () => {
    const file = path.join(dir, 'wrong.json');
    await fsp.writeFile(file, '\uFEFF{"version":1,"entries":"nope"}', 'utf8');
    await expect(new PromptManifestStore(file).record(entry('x'))).rejects.toThrow(
      /no entries list/,
    );
  });
});
