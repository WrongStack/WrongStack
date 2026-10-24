import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { SAGE_SURFACE_CAPABILITY } from '@wrongstack/sage';
import { afterEach, describe, expect, it } from 'vitest';
import { subscribeVectorMemoryToSage } from '../src/sage-event-mirror.js';
import { encodeVector } from '../src/schema.js';
import { VectorMemoryStore } from '../src/store.js';

const roots = new Set<string>();

function projectRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `wrongstack-vm-audit-${label}-`));
  roots.add(root);
  return root;
}

function provider(
  dimensions = 3,
  embed: () => Float32Array[] = () => [new Float32Array([1, 0, 0])],
) {
  return {
    id: `audit-${dimensions}`,
    dimensions,
    async embed() {
      return embed();
    },
  };
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe('high-risk audit regressions', () => {
  it('F212 keeps the database filename inside the configured data directory', () => {
    const root = projectRoot('filename');
    expect(
      () =>
        new VectorMemoryStore({
          projectRoot: root,
          filename: '../../escaped.db',
          provider: provider(),
        }),
    ).toThrow(/file name without path segments/i);
    expect(fs.existsSync(path.resolve(root, '..', '..', 'escaped.db'))).toBe(false);
  });

  it('F251 removes a shared mirror when its SAGE memory becomes session-scoped', async () => {
    const events = new EventBus();
    let forgotten = 0;
    const store = {
      findBySageId: () => ({ id: 'vector-entry' }),
      forget: async () => {
        forgotten++;
        return true;
      },
      remember: async () => {
        throw new Error('session memory must not be mirrored');
      },
    } as unknown as VectorMemoryStore;
    const memoryStore = {
      events,
      getCapability: (capability: { id: string }) =>
        capability.id === SAGE_SURFACE_CAPABILITY.id
          ? { getSage: async () => ({ id: 'sage', scope: 'session', status: 'active' }) }
          : undefined,
    } as never;
    const handle = subscribeVectorMemoryToSage({ store, memoryStore });
    events.emit('memory.updated', { memoryId: 'sage', status: 'updated' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.dispose();
    expect(forgotten).toBe(1);
  });

  it('F262/F268 skips malformed and dimension-mismatched vectors during search', async () => {
    const store = new VectorMemoryStore({
      projectRoot: projectRoot('search'),
      provider: provider(),
    });
    const malformed = await store.remember({ text: 'malformed' });
    const wrongSize = await store.remember({ text: 'wrong-size' });
    await store.remember({ text: 'good' });
    const db = (store as unknown as { db: any }).db;
    db.prepare('UPDATE vectors SET vector = ? WHERE entry_id = ?').run(
      Buffer.from([1, 2, 3]),
      malformed.id,
    );
    db.prepare('UPDATE vectors SET vector = ? WHERE entry_id = ?').run(
      encodeVector(new Float32Array([1, 0])),
      wrongSize.id,
    );
    await expect(store.search('query')).resolves.toMatchObject([{ entry: { text: 'good' } }]);
    store.close();
  });

  it('F263/F267 treats corrupt or wrong-sized embedding cache rows as misses', async () => {
    let calls = 0;
    const store = new VectorMemoryStore({
      projectRoot: projectRoot('cache'),
      provider: provider(3, () => {
        calls++;
        return [new Float32Array([1, 0, 0])];
      }),
    });
    await store.remember({ text: 'cached' });
    const db = (store as unknown as { db: any }).db;
    db.prepare('UPDATE embedding_cache SET vector = ?').run(encodeVector(new Float32Array([1, 0])));
    await store.search('cached');
    expect(calls).toBe(2);
    expect(db.prepare('SELECT length(vector) AS n FROM embedding_cache').get()).toMatchObject({
      n: 12,
    });
    store.close();
  });

  it('F264 does not persist non-finite provider embeddings', async () => {
    const store = new VectorMemoryStore({
      projectRoot: projectRoot('remember-nonfinite'),
      provider: provider(3, () => [new Float32Array([1, Number.NaN, 0])]),
    });
    const entry = await store.remember({ text: 'bad vector' });
    expect(entry).toMatchObject({ dimensions: 0, providerId: '' });
    expect(entry.vector).toBeUndefined();
    store.close();
  });

  it('F265 preserves the prior vector when reindex returns non-finite data', async () => {
    let bad = false;
    const store = new VectorMemoryStore({
      projectRoot: projectRoot('reindex-nonfinite'),
      provider: provider(3, () => [
        bad ? new Float32Array([1, Infinity, 0]) : new Float32Array([1, 0, 0]),
      ]),
    });
    const entry = await store.remember({ text: 'stable vector' });
    bad = true;
    await expect(store.reindexAll()).resolves.toEqual({ processed: 0, errors: 1 });
    expect(Array.from(store.get(entry.id)?.vector ?? [])).toEqual([1, 0, 0]);
    store.close();
  });

  it('F266 rejects blank SAGE ids without indexing a row', async () => {
    const store = new VectorMemoryStore({
      projectRoot: projectRoot('sage-id'),
      provider: provider(),
    });
    const report = await store.syncFromSage({
      listActiveMemories: async () => [{ id: '   ', text: 'invalid source row' }],
    });
    expect(report).toMatchObject({ scanned: 1, indexed: 0, failed: 1 });
    expect(store.list()).toEqual([]);
    store.close();
  });

  it('F269 omits a point-read vector whose blob length disagrees with dimensions', async () => {
    const store = new VectorMemoryStore({
      projectRoot: projectRoot('point-read'),
      provider: provider(),
    });
    const entry = await store.remember({ text: 'corrupt point read' });
    (store as unknown as { db: any }).db
      .prepare('UPDATE vectors SET vector = ? WHERE entry_id = ?')
      .run(encodeVector(new Float32Array([1, 0])), entry.id);
    expect(store.get(entry.id)).toMatchObject({ dimensions: 0, providerId: '' });
    expect(store.get(entry.id)?.vector).toBeUndefined();
    store.close();
  });

  it('distinguishes -0 from +0 in jsonValuesEqual and rejects lossy -0 metadata', async () => {
    const { cloneJsonMetadata, jsonValuesEqual } = await import('../src/store-values.js');
    expect(jsonValuesEqual(-0, 0)).toBe(false);
    expect(() => cloneJsonMetadata({ direction: -0 })).toThrow(/lossless JSON values/);
  });
});
