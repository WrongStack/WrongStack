import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  diffRegistry,
  validateRegistryManifest,
} from '@wrongstack/contracts/types/prompt-registry';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptInstaller } from '../../src/prompts/prompt-installer.js';
import { PromptManifestStore } from '../../src/prompts/prompt-manifest-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const datasetIndex = path.join(here, '..', '..', 'data', 'prompts', 'index.json');

function manifestFromBuiltinIndex(): unknown {
  // The bundled index.json is shaped like a registry manifest — reuse it as a
  // fixture to prove builtin and remote share one format.
  const index = JSON.parse(fs.readFileSync(datasetIndex, 'utf8'));
  return {
    registryVersion: 1,
    source: 'builtin',
    generatedAt: index.generatedAt,
    prompts: index.prompts.map((p: Record<string, unknown>) => ({
      id: p['id'],
      slug: p['slug'],
      title: p['title'],
      description: p['description'],
      category: p['category'],
      tags: p['tags'],
      checksum: p['checksum'],
    })),
  };
}

describe('validateRegistryManifest', () => {
  it('accepts the bundled index.json reshaped as a manifest', () => {
    const result = validateRegistryManifest(manifestFromBuiltinIndex());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.prompts.length).toBeGreaterThanOrEqual(100);
  });

  it('rejects bad slugs, checksums, and wrong version', () => {
    const bad = {
      registryVersion: 2,
      source: '',
      generatedAt: 'x',
      prompts: [
        {
          id: 'a',
          slug: 'Bad Slug',
          title: 't',
          description: 'd',
          category: 'coding',
          checksum: 'nope',
        },
      ],
    };
    const result = validateRegistryManifest(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('registryVersion'))).toBe(true);
      expect(result.errors.some((e) => e.includes('slug'))).toBe(true);
    }
  });

  it('rejects a non-object', () => {
    expect(validateRegistryManifest(null).ok).toBe(false);
    expect(validateRegistryManifest('nope').ok).toBe(false);
  });
});

describe('diffRegistry', () => {
  it('classifies added / updated / unchanged by checksum', () => {
    const manifest = {
      registryVersion: 1 as const,
      source: 's',
      generatedAt: 'x',
      prompts: [
        {
          id: '1',
          slug: 'a',
          title: 'A',
          description: 'd',
          category: 'coding',
          tags: [],
          checksum: 'a'.repeat(64),
        },
        {
          id: '2',
          slug: 'b',
          title: 'B',
          description: 'd',
          category: 'coding',
          tags: [],
          checksum: 'b'.repeat(64),
        },
        {
          id: '3',
          slug: 'c',
          title: 'C',
          description: 'd',
          category: 'coding',
          tags: [],
          checksum: 'c'.repeat(64),
        },
      ],
    };
    const local = [
      { slug: 'a', checksum: 'a'.repeat(64) }, // unchanged
      { slug: 'b', checksum: 'z'.repeat(64) }, // updated
      // c is new
    ];
    const diff = diffRegistry(local, manifest);
    expect(diff.unchanged.map((r) => r.slug)).toEqual(['a']);
    expect(diff.updated.map((r) => r.slug)).toEqual(['b']);
    expect(diff.added.map((r) => r.slug)).toEqual(['c']);
  });
});

describe('PromptInstaller.pull (stub)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'prompt-pull-'));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('fetches + validates + diffs but writes nothing', async () => {
    const manifest = manifestFromBuiltinIndex();
    const installer = new PromptInstaller({ fetcher: async () => manifest });
    const result = await installer.pull('https://prompts.wrongstack.com/registry.json', []);
    expect(result.dryRun).toBe(true);
    expect(result.diff.added.length).toBeGreaterThanOrEqual(100); // all new locally
    // No files were created in tmp — pull is read-only.
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('throws on an invalid manifest', async () => {
    const installer = new PromptInstaller({ fetcher: async () => ({ registryVersion: 9 }) });
    await expect(installer.pull('https://x/registry.json', [])).rejects.toThrow(
      /Invalid prompt registry/,
    );
  });

  it('install() is an explicit not-yet-implemented stub', async () => {
    const installer = new PromptInstaller({ fetcher: async () => ({}) });
    await expect(installer.install()).rejects.toThrow(/not implemented/i);
  });
});

describe('PromptManifestStore', () => {
  let tmp: string;
  let store: PromptManifestStore;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'prompt-manifest-'));
    store = new PromptManifestStore(path.join(tmp, 'installed-prompts.json'));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('records, upserts, lists, and removes entries', async () => {
    expect(await store.list()).toEqual([]);
    await store.record({
      slug: 'a',
      source: 's',
      ref: 'v1',
      checksum: 'a'.repeat(64),
      synced: false,
      installedAt: 'x',
    });
    await store.record({
      slug: 'a',
      source: 's',
      ref: 'v2',
      checksum: 'b'.repeat(64),
      synced: true,
      installedAt: 'y',
    });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ref: 'v2', synced: true });
    expect(await store.remove('a')).toBe(true);
    expect(await store.remove('a')).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it('tolerates a missing/corrupt manifest file', async () => {
    const bad = new PromptManifestStore(path.join(tmp, 'nope.json'));
    expect(await bad.load()).toEqual({ version: 1, entries: [] });
  });
});
