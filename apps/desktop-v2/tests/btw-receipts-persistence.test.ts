import { describe, expect, it } from 'vitest';
import {
  BtwReceiptStore,
  btwReceiptKey,
  parseBtwReceipts,
  type SavedBtwReceipts,
} from '../src/btw-receipts';

function memoryStorage() {
  const slot = { revision: 0, value: null as SavedBtwReceipts | null, saves: 0 };
  return {
    slot,
    storage: {
      get: async () => ({ revision: slot.revision, value: structuredClone(slot.value) }),
      save: async (value: SavedBtwReceipts | null, expected: number) => {
        if (expected !== slot.revision)
          throw Error('DRAFT_CONFLICT: This draft changed in another window');
        slot.value = structuredClone(value);
        slot.saves++;
        return ++slot.revision;
      },
    },
  };
}

describe('BTW receipt persistence', () => {
  it('restores notes in a new store after a restart', async () => {
    const { storage } = memoryStorage();
    const first = new BtwReceiptStore();
    await first.attach('s1', storage);
    await first.record('s1', { messageId: 'a', text: 'one', sentAt: 1 });
    await first.record('s1', { messageId: 'b', text: 'two', sentAt: 2 });
    const restarted = new BtwReceiptStore();
    await restarted.attach('s1', storage);
    expect(restarted.list('s1').map((note) => note.messageId)).toEqual(['b', 'a']);
    expect(restarted.error('s1')).toBe('');
  });
  it('keeps a note recorded before the saved list loaded', async () => {
    const { storage, slot } = memoryStorage();
    slot.value = { version: 1, notes: [{ messageId: 'old', text: 'saved', sentAt: 1 }] };
    slot.revision = 1;
    const store = new BtwReceiptStore();
    const loading = store.attach('s1', storage);
    const recorded = store.record('s1', { messageId: 'new', text: 'early', sentAt: 2 });
    await Promise.all([loading, recorded]);
    expect(store.list('s1').map((note) => note.messageId)).toEqual(['new', 'old']);
    expect(slot.value?.notes.map((note) => note.messageId)).toEqual(['new', 'old']);
  });
  it('merges with another window instead of overwriting it', async () => {
    const { storage, slot } = memoryStorage();
    const mine = new BtwReceiptStore(),
      peer = new BtwReceiptStore();
    await mine.attach('s1', storage);
    await peer.attach('s1', storage);
    await peer.record('s1', { messageId: 'peer', text: 'from the other window', sentAt: 1 });
    await mine.record('s1', { messageId: 'mine', text: 'from here', sentAt: 2 });
    expect(slot.value?.notes.map((note) => note.messageId)).toEqual(['mine', 'peer']);
    expect(mine.list('s1').map((note) => note.messageId)).toEqual(['mine', 'peer']);
    expect(mine.error('s1')).toBe('');
  });
  it('shows a save failure and keeps the note in this window', async () => {
    const store = new BtwReceiptStore();
    await store.attach('s1', {
      get: async () => ({ revision: 0, value: null }),
      save: async () => {
        throw Error('database unavailable');
      },
    });
    await store.record('s1', { messageId: 'a', text: 'one', sentAt: 1 });
    expect(store.list('s1')).toHaveLength(1);
    expect(store.error('s1')).toContain('database unavailable');
  });
  it('rejects malformed saved receipts and keys sessions apart', async () => {
    expect(() =>
      parseBtwReceipts({ version: 1, notes: [{ messageId: '', text: 'x', sentAt: 1 }] }),
    ).toThrow('unsupported');
    expect(() => parseBtwReceipts({ version: 2, notes: [] })).toThrow('unsupported');
    const a = await btwReceiptKey('p1', 's1'),
      b = await btwReceiptKey('p1', 's2');
    expect(a).toMatch(/^btw-receipts:[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
