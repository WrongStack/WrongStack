import { createHash } from 'node:crypto';
import * as testNodeFsPromises from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    // blobs are unknown, so it must say so instead of reporting a clean run.
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

  it.each([{}, { entries: {} }, { entries: null }])(
    'does not sweep objects when a kept manifest has invalid entries: %j',
    async (manifest) => {
      const kept = await writeCheckpoint('kept', ['kept content']);
      await fs.writeFile(path.join(cas, 'manifests', `${kept}.json`), JSON.stringify(manifest));
      await age(store);
      const result = await sweepCheckpointCas({
        casRoot: cas,
        reachableManifestHashes: new Set([kept]),
        keepNewerThanMs: floorNow(),
      });
      expect(result.objectsDeleted).toBe(0);
      expect(result.errors.join(' ')).toContain('Object sweep skipped');
      const blob = sha('kept content');
      await expect(
        fs.stat(path.join(cas, 'objects', blob.slice(0, 2), blob.slice(2))),
      ).resolves.toBeDefined();
    },
  );

  it('sweeps no object while a kept manifest cannot be read', async () => {
    // Its blobs are live but unnamed, so no object can be proven garbage: an
    // unreadable live manifest (a transient EBUSY, say) must not cost its blobs.
    const badHash = sha('bad');
    await fs.writeFile(path.join(cas, 'manifests', `${badHash}.json`), '{ not json');
    await writeTranscript('2020-01-01/bad.jsonl', [badHash]);
    const orphan = await writeCheckpoint('orphan', ['orphan content']);
    await age(store);

    const result = await sweepCheckpointCas({
      casRoot: cas,
      reachableManifestHashes: await collectReachableManifestHashes(store),
      keepNewerThanMs: floorNow(),
    });

    expect(result.manifestsDeleted).toBe(1);
    expect(result.objectsDeleted).toBe(0);
    expect(result.errors.join(' ')).toContain('Object sweep skipped');
    await expect(fs.stat(path.join(cas, 'manifests', `${orphan}.json`))).rejects.toBeDefined();
    const blob = sha('orphan content');
    await expect(
      fs.stat(path.join(cas, 'objects', blob.slice(0, 2), blob.slice(2))),
    ).resolves.toBeDefined();
  });

  it('sweeps no object while the manifests directory cannot be listed', async () => {
    // An unlistable manifests dir hid every reference, so every live blob past
    // the floor looked like garbage and was deleted.
    const live = await writeCheckpoint('live', ['live content']);
    await writeTranscript('2020-01-01/live.jsonl', [live]);
    await age(store);
    const reachable = await collectReachableManifestHashes(store);

    const manifestsDir = path.join(cas, 'manifests');
    const fsp = testNodeFsPromises as typeof fs;
    let fsp_readdir_spy: { mockRestore(): void } | undefined;
    const realReaddir = fsp.readdir;
    fsp_readdir_spy = vi.spyOn(fsp, 'readdir').mockImplementation((async (
      p: Parameters<typeof realReaddir>[0],
      ...rest: unknown[]
    ) => {
      if (String(p) === manifestsDir) {
        throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      }
      return (realReaddir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as typeof realReaddir);

    let result: Awaited<ReturnType<typeof sweepCheckpointCas>>;
    try {
      result = await sweepCheckpointCas({
        casRoot: cas,
        reachableManifestHashes: reachable,
        keepNewerThanMs: floorNow(),
      });
    } finally {
      fsp_readdir_spy?.mockRestore();
    }

    expect(result.objectsDeleted).toBe(0);
    expect(result.errors.join(' ')).toContain('Object sweep skipped');
    const blob = sha('live content');
    await expect(
      fs.stat(path.join(cas, 'objects', blob.slice(0, 2), blob.slice(2))),
    ).resolves.toBeDefined();
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

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));
