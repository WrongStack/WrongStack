import { describe, expect, it } from 'vitest';
import {
  DurableFormDraft,
  type FormDraftCodec,
  type FormDraftSnapshot,
  type FormDraftStorage,
} from '../src/durable-form-draft';

type Value = { text: string };
const codec: FormDraftCodec<Value> = {
  parse(value) {
    if (value === null) return null;
    if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') {
      return { text: value.text };
    }
    throw new Error('Invalid fixture draft');
  },
  serialize: (value) => ({ ...value }),
};

/** A native CAS commit can complete before its IPC acknowledgement reaches the window. */
function fixture(commitBeforeAcknowledgement = true, failClear = false) {
  const stored: FormDraftSnapshot = { revision: 1, value: { text: 'original' } };
  const entered = Promise.withResolvers<void>();
  const acknowledge = Promise.withResolvers<void>();
  const storage: FormDraftStorage = {
    get: async () => structuredClone(stored),
    async save(value, expectedRevision) {
      const commit = () => {
        if (stored.revision !== expectedRevision) throw new Error('DRAFT_CONFLICT: stale revision');
        const revision = ++stored.revision;
        stored.value = structuredClone(value);
        return revision;
      };
      if (value !== null) return commit();
      const revision = commitBeforeAcknowledgement && !failClear ? commit() : undefined;
      entered.resolve();
      await acknowledge.promise;
      if (failClear) throw new Error('EPIPE: clear failed');
      return revision ?? commit();
    },
  };
  return { draft: new DurableFormDraft(storage, codec), stored, entered, acknowledge };
}

async function race(commitFirst: boolean, values: Value[]) {
  const test = fixture(commitFirst);
  await test.draft.load();
  const clearing = test.draft.clear();
  await test.entered.promise;
  try {
    for (const value of values) test.draft.edit(value);
    await test.draft.flush();
  } finally {
    test.acknowledge.resolve();
  }
  expect(await clearing).toBe(false);
  await test.draft.flush();
  expect(test.stored.value).toEqual(values.at(-1));
  expect(test.draft.snapshot()).toMatchObject({ dirty: false, review: null, error: '' });
}

describe('draft edits while clear is in flight', () => {
  it.each([true, false])('persists a newer edit with commit-first=%s', async (commitFirst) => {
    await race(commitFirst, [{ text: 'newer edit' }]);
  });

  it('persists the latest of several edits without a false other-window conflict', async () => {
    await race(true, [{ text: 'first edit' }, { text: 'latest edit' }]);
  });

  it('does not start a second clear against the first clear’s unacknowledged revision', async () => {
    const test = fixture();
    await test.draft.load();
    const first = test.draft.clear();
    await test.entered.promise;
    try {
      expect(await test.draft.clear()).toBe(false);
    } finally {
      test.acknowledge.resolve();
    }
    expect(await first).toBe(true);
    test.draft.edit({ text: 'edit after clearing' });
    await test.draft.flush();
    expect(test.stored.value).toEqual({ text: 'edit after clearing' });
    expect(test.draft.snapshot()).toMatchObject({ dirty: false, review: null, error: '' });
  });

  it('resumes autosave after the clear fails', async () => {
    const test = fixture(false, true);
    await test.draft.load();
    const clearing = test.draft.clear();
    await test.entered.promise;
    test.draft.edit({ text: 'newer edit' });
    test.acknowledge.resolve();
    expect(await clearing).toBe(false);
    await test.draft.flush();
    expect(test.stored.value).toEqual({ text: 'newer edit' });
    expect(test.draft.snapshot()).toMatchObject({ dirty: false, review: null, error: '' });
  });

  it('still stops on a real external change instead of overwriting the other window', async () => {
    const test = fixture();
    await test.draft.load();
    const clearing = test.draft.clear();
    await test.entered.promise;
    test.stored.revision++;
    test.stored.value = { text: 'other window' };
    test.draft.edit({ text: 'local edit' });
    test.acknowledge.resolve();
    expect(await clearing).toBe(false);
    await test.draft.flush();
    expect(test.stored.value).toEqual({ text: 'other window' });
    expect(test.draft.snapshot()).toMatchObject({
      value: { text: 'local edit' },
      dirty: true,
      review: { revision: 3, value: { text: 'other window' } },
    });
  });
});
