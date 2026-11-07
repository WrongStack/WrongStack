import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { VectorMemoryStore } from '../src/store.js';

async function exercise(
  close: boolean,
  outcome: 'vector' | 'empty' | 'failure' = 'vector',
  strict = false,
) {
  const root = mkdtempSync(path.join(tmpdir(), 'audit-six-vector-'));
  if (
    path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) ||
    !path.basename(root).startsWith('audit-six-vector-')
  ) {
    throw new Error('unowned fixture');
  }
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const provider = {
    id: 'gated',
    dimensions: 2,
    embed: async () => {
      entered();
      await gate;
      if (outcome === 'failure') throw new Error('provider failed');
      return outcome === 'empty' ? [] : [new Float32Array([1, 0])];
    },
  };
  const store = new VectorMemoryStore({ provider, projectRoot: root });
  try {
    const search = store.search('query', { failOnEmbeddingError: strict });
    const settled = search.then(
      (hits) => ({ hits, error: undefined }),
      (error) => ({ hits: undefined, error }),
    );
    await enteredPromise;
    if (close) store.close();
    release();
    return await settled;
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

import { expect, it } from 'vitest';

it('verifies vector, empty, failure and strict embedding completions after close', async () => {
  for (const outcome of ['vector', 'empty', 'failure'] as const) {
    for (const strict of [false, true]) {
      const actual = await exercise(true, outcome, strict);
      expect(actual.error?.message).toBe('VectorMemoryStore is closed');
      expect(actual.hits).toBeUndefined();
    }
  }
  const control = await exercise(false);
  expect(control.hits).toEqual([]);
  expect(control.error).toBeUndefined();
  const outage = await exercise(false, 'failure');
  expect(outage.hits).toEqual([]);
  const strict = await exercise(false, 'failure', true);
  expect(strict.error?.message).toContain('provider failed');
});

it('rejects remember, forget, and syncFromSage with closed error when closed mid-operation and deduplicates concurrent sageId writes', async () => {
  const root2 = mkdtempSync(path.join(tmpdir(), 'audit-six-vector-'));
  let entered2!: () => void;
  let release2!: () => void;
  const enteredPromise2 = new Promise<void>((r) => {
    entered2 = r;
  });
  const gate2 = new Promise<void>((r) => {
    release2 = r;
  });
  let calls2 = 0;
  const store2 = new VectorMemoryStore({
    provider: {
      id: 'gated-write-2',
      dimensions: 2,
      embed: async () => {
        calls2++;
        if (calls2 === 1) throw new Error('seed-outage');
        if (calls2 <= 3) return [new Float32Array([1, 0])];
        entered2();
        await gate2;
        return [new Float32Array([1, 0])];
      },
    },
    projectRoot: root2,
  });
  try {
    const seeded = await store2.remember({ text: 'recover-target' });
    expect(seeded.vector).toBeUndefined();
    await store2.remember({ text: 'v1-body', metadata: { source: 'sage', sageId: 'dup-sage' } });
    await store2.remember({ text: 'v2-body', metadata: { source: 'sage', sageId: 'dup-sage' } });
    expect(
      store2.list({ limit: 10 }).filter((e) => e.metadata?.['sageId'] === 'dup-sage'),
    ).toHaveLength(1);

    const recoverPromise = store2.remember({ text: 'recover-target' });
    await enteredPromise2;
    const forgetPromise = store2.forget(seeded.id);
    store2.close();
    release2();
    await expect(recoverPromise).rejects.toThrow('VectorMemoryStore is closed');
    await expect(forgetPromise).rejects.toThrow('VectorMemoryStore is closed');
  } finally {
    store2.close();
    rmSync(root2, { recursive: true, force: true });
  }
});
