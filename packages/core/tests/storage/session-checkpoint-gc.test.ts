import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectReachableManifestHashes,
  sweepCheckpointCas,
} from '../../src/storage/session-checkpoint-gc.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('checkpoint CAS garbage collection', () => {
  let store: string;
  let cas: string;

  beforeEach(async () => {
    store = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cas-gc-'));
    cas = path.join(store, '_cas');
    await fs.mkdir(path.join(cas, 'manifests'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(store, { recursive: true, force: true });
  });

  /** Write a manifest plus its blobs, exactly as SessionCheckpointCas lays them out. */
  async function writeCheckpoint(id: string, contents: string[]): Promise<string> {
    const entries = [];
    for (const content of contents) {
      const blobHash = sha(content);
      const shard = path.join(cas, 'objects', blobHash.slice(0, 2));
      await fs.mkdir(shard, { recursive: true });
      await fs.writeFile(path.join(shard, blobHash.slice(2)), content);
      entries.push({ path: `${id}.txt`, state: 'file', blobHash, mode: 0o644 });
    }
    const manifest = JSON.stringify({
      version: 1,
      baseHead: 'a'.repeat(40),
      coverage: 'git-head-plus-dirty',
      entries,
      unresolved: [],
    });
    const manifestHash = sha(manifest);
    await fs.writeFile(path.join(cas, 'manifests', `${manifestHash}.json`), manifest);
    return manifestHash;
  }

  async function writeTranscript(
    name: string,
    manifestHashes: string[],
    opts: { gzip?: boolean } = {},
  ): Promise<void> {
    const lines = manifestHashes.map((manifestHash) =>
      JSON.stringify({
        type: 'checkpoint',
        ts: '2020-01-01T00:00:00.000Z',
        promptIndex: 0,
        workspaceCheckpoint: {
          manifestHash,
          baseHead: 'a'.repeat(40),
          entryCount: 1,
          unresolvedCount: 0,
          capturedAt: '2020-01-01T00:00:00.000Z',
          coverage: 'git-head-plus-dirty',
        },
      }),
    );
    const body = `${lines.join('\n')}\n`;
    const file = path.join(store, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (opts.gzip) await fs.writeFile(file, gzipSync(Buffer.from(body)));
    else await fs.writeFile(file, body);
  }

  /** Backdate everything so the age floor does not protect it. */
  async function age(dir: string): Promise<void> {
    const old = new Date('2020-01-01T00:00:00.000Z');
    const walk = async (d: string): Promise<void> => {
      for (const entry of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) await walk(p);
        else await fs.utimes(p, old, old);
      }
    };
    await walk(dir);
  }

  const floorNow = () => Date.now();

  it('finds referenced manifests in plain and gzipped transcripts', async () => {
    const hot = await writeCheckpoint('hot', ['hot content']);
    const cold = await writeCheckpoint('cold', ['cold content']);
    await writeTranscript('2020-01-01/hot.jsonl', [hot]);
    await writeTranscript('2020-01-01/cold.jsonl.gz', [cold], { gzip: true });

    const reachable = await collectReachableManifestHashes(store);
    expect(reachable).toEqual(new Set([hot, cold]));
  });

  it('never walks into the CAS itself when collecting references', async () => {
    // The manifests under `_cas` contain hashes too; treating them as
    // references would make every object reachable from itself and the sweep
    // would reclaim nothing, forever.
    const orphan = await writeCheckpoint('orphan', ['orphan content']);
    const reachable = await collectReachableManifestHashes(store);
    expect(reachable.has(orphan)).toBe(false);
  });

  it('deletes an unreferenced manifest and its blobs', async () => {
    const kept = await writeCheckpoint('kept', ['kept content']);
    const orphan = await writeCheckpoint('orphan', ['orphan content']);
    await writeTranscript('2020-01-01/kept.jsonl', [kept]);
    await age(store);

    const result = await sweepCheckpointCas({
      casRoot: cas,
      reachableManifestHashes: await collectReachableManifestHashes(store),
      keepNewerThanMs: floorNow(),
    });

    expect(result.manifestsDeleted).toBe(1);
    expect(result.objectsDeleted).toBe(1);
    expect(result.bytesReclaimed).toBeGreaterThan(0);
    await expect(fs.stat(path.join(cas, 'manifests', `${orphan}.json`))).rejects.toBeDefined();
    await expect(fs.stat(path.join(cas, 'manifests', `${kept}.json`))).resolves.toBeDefined();
  });

  it('keeps a blob that any surviving manifest still references', async () => {
    // Deduplication is the whole point of a CAS: two checkpoints of the same
    // file share one blob. Sweeping the orphan must not take the shared blob
    // with it.
    const shared = 'shared content';
    const kept = await writeCheckpoint('kept', [shared]);
    await writeCheckpoint('orphan', [shared]);
    await writeTranscript('2020-01-01/kept.jsonl', [kept]);
    await age(store);

    const result = await sweepCheckpointCas({
      casRoot: cas,
      reachableManifestHashes: await collectReachableManifestHashes(store),
      keepNewerThanMs: floorNow(),
    });

    expect(result.manifestsDeleted).toBe(1);
    expect(result.objectsDeleted).toBe(0);
    const blob = sha(shared);
    await expect(
      fs.stat(path.join(cas, 'objects', blob.slice(0, 2), blob.slice(2))),
    ).resolves.toBeDefined();
  });

  it('protects anything newer than the age floor even when unreferenced', async () => {
    // The floor is the safety net for a checkpoint captured mid-sweep, or one
    // referenced from a transcript the scan could not read.
    await writeCheckpoint('fresh', ['fresh content']);

    const result = await sweepCheckpointCas({
      casRoot: cas,
      reachableManifestHashes: new Set(),
      keepNewerThanMs: Date.now() - 60_000,
    });

    expect(result.manifestsDeleted).toBe(0);
    expect(result.objectsDeleted).toBe(0);
    expect(result.manifestsScanned).toBe(1);
  });

  it('reports a store with no checkpoints as empty rather than failing', async () => {
    await fs.rm(cas, { recursive: true, force: true });
    const result = await sweepCheckpointCas({
      casRoot: cas,
      reachableManifestHashes: new Set(),
      keepNewerThanMs: floorNow(),
    });
    expect(result).toMatchObject({ manifestsScanned: 0, objectsScanned: 0, errors: [] });
  });

  it('surfaces a kept manifest whose blob list could not be read', async () => {
    // A manifest that survives but cannot be parsed is the dangerous case: its
    // blobs are unknown, so they are not marked live and the object pass could
    // delete data a live checkpoint needs. The sweep cannot prevent that on its
    // own, so it must at least say so instead of reporting a clean run.
    const badHash = sha('bad');
    await fs.writeFile(path.join(cas, 'manifests', `${badHash}.json`), '{ not json');
    await writeTranscript('2020-01-01/bad.jsonl', [badHash]);
    await age(store);

    const result = await sweepCheckpointCas({
      casRoot: cas,
      reachableManifestHashes: await collectReachableManifestHashes(store),
      keepNewerThanMs: floorNow(),
    });

    expect(result.manifestsDeleted).toBe(0);
    expect(result.errors.join(' ')).toContain(badHash);
  });

  it('deletes an unreadable manifest that nothing references', async () => {
    await fs.writeFile(path.join(cas, 'manifests', `${sha('bad')}.json`), '{ not json');
    await age(store);

    const result = await sweepCheckpointCas({
      casRoot: cas,
      reachableManifestHashes: new Set(),
      keepNewerThanMs: floorNow(),
    });

    // Nothing points at it and it is past the floor, so its contents never
    // needed parsing: it goes without an error.
    expect(result.manifestsDeleted).toBe(1);
    expect(result.errors).toEqual([]);
  });
});
