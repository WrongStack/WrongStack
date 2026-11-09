import { describe, expect, it } from 'vitest';
import { DurableFormDraft } from '../src/durable-form-draft';

type Value = { a: number };
const codec = {
  parse: (value: unknown) => value as Value | null,
  serialize: (value: Value | null) => value,
};

function memoryStorage(initial: { revision: number; value: unknown }) {
  const stored = { ...initial };
  const calls: { value: unknown; expectedRevision: number }[] = [];
  return {
    stored,
    calls,
    async get() {
      return { ...stored };
    },
    async save(value: unknown, expectedRevision: number) {
      calls.push({ value, expectedRevision });
      if (expectedRevision !== stored.revision) throw new Error('DRAFT_CONFLICT: stale');
      stored.revision++;
      stored.value = value;
      return stored.revision;
    },
  };
}

describe('durable form draft recovery', () => {
  it('retries a transient save failure on the next edit', async () => {
    const storage = memoryStorage({ revision: 0, value: null });
    const save = storage.save;
    let failed = false;
    storage.save = async (value, expectedRevision) => {
      if (!failed) {
        failed = true;
        storage.calls.push({ value, expectedRevision });
        throw new Error('EPIPE: native draft write failed');
      }
      return save(value, expectedRevision);
    };
    const draft = new DurableFormDraft<Value>(storage, codec);
    await draft.load();
    draft.edit({ a: 1 });
    await draft.flush();
    expect(draft.snapshot().dirty).toBe(true);
    expect(draft.snapshot().error).toContain('not saved yet');
    expect(draft.snapshot().review).toBeNull();

    draft.edit({ a: 2 });
    await draft.flush();
    expect(storage.stored).toEqual({ revision: 1, value: { a: 2 } });
    expect(draft.snapshot().dirty).toBe(false);
    expect(draft.snapshot().error).toBe('');
  });

  it('does not retry a persistent failure without a new edit', async () => {
    const storage = memoryStorage({ revision: 0, value: null });
    storage.save = async (value, expectedRevision) => {
      storage.calls.push({ value, expectedRevision });
      throw new Error('EPIPE: native draft write failed');
    };
    const draft = new DurableFormDraft<Value>(storage, codec);
    await draft.load();
    draft.edit({ a: 1 });
    await draft.flush();
    expect(storage.calls).toHaveLength(1);
    for (let i = 0; i < 5; i++) await draft.flush();
    expect(storage.calls).toHaveLength(1);
  });

  it('still stops on a revision conflict and never overwrites the other window', async () => {
    let reads = 0;
    let saves = 0;
    const stored = { revision: 0, value: null as unknown };
    const storage = {
      calls: [] as { value: unknown; expectedRevision: number }[],
      async get() {
        reads++;
        return reads === 1 ? { revision: 0, value: null } : { revision: 2, value: { a: 99 } };
      },
      async save(value: unknown, expectedRevision: number) {
        storage.calls.push({ value, expectedRevision });
        saves++;
        if (saves === 1) throw new Error('DRAFT_CONFLICT: changed in another window');
        stored.revision = expectedRevision + 1;
        stored.value = value;
        return stored.revision;
      },
    };
    const draft = new DurableFormDraft<Value>(storage, codec);
    await draft.load();
    draft.edit({ a: 1 });
    await draft.flush();
    expect(draft.snapshot().review).toEqual({ value: { a: 99 }, revision: 2 });

    draft.edit({ a: 2 });
    await draft.flush();
    expect(storage.calls).toHaveLength(1);
    expect(stored.value).not.toEqual({ a: 2 });

    expect(await draft.resolve('local')).toBe(true);
    expect(stored).toEqual({ revision: 3, value: { a: 2 } });
  });

  it('persists an edit made while the previous save is in flight', async () => {
    const storage = memoryStorage({ revision: 0, value: null });
    const save = storage.save;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    storage.save = async (value, expectedRevision) => {
      calls++;
      if (calls === 1) await gate;
      return save(value, expectedRevision);
    };
    const draft = new DurableFormDraft<Value>(storage, codec);
    await draft.load();
    draft.edit({ a: 1 });
    const inFlight = draft.flush();
    draft.edit({ a: 2 });
    release();
    await inFlight;
    await draft.flush();
    expect(storage.stored).toEqual({ revision: 2, value: { a: 2 } });
    expect(draft.snapshot().dirty).toBe(false);
  });
});
