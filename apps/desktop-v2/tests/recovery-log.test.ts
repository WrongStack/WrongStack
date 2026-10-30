import { describe, expect, it } from 'vitest';
import {
  createRecoveryLog,
  recoveryLogKey,
  redoRecord,
  rewindRecord,
  type SavedRecoveryLog,
  unfinishedRecord,
} from '../src/recovery-log';

const observed = (over: Partial<Parameters<typeof rewindRecord>[0]> = {}) => ({
  checkpoint: 2,
  files: ['src/a.ts', 'src/b.ts'],
  errors: [],
  removedEvents: 14,
  messageCount: 6,
  promptText: 'Do the thing',
  promptHasAttachments: false,
  ...over,
});

function memoryStorage(value: unknown = null) {
  const slot = { revision: value === null ? 0 : 1, value: value as SavedRecoveryLog | null };
  return {
    slot,
    storage: {
      get: async () => ({ revision: slot.revision, value: structuredClone(slot.value) }),
      save: async (next: SavedRecoveryLog | null, expected: number) => {
        if (expected !== slot.revision)
          throw Error('DRAFT_CONFLICT: This draft changed in another window');
        slot.value = structuredClone(next);
        return ++slot.revision;
      },
    },
  };
}
async function loadError(value: unknown) {
  const log = createRecoveryLog();
  await log.attach('s1', memoryStorage(value).storage);
  return log.error('s1');
}

describe('recovery records', () => {
  it('describe engine results without inventing what was not reported', () => {
    const done = rewindRecord(observed(), 'rewind', '', 10);
    expect(done).toMatchObject({
      operation: 'rewind',
      outcome: 'completed',
      checkpoint: 2,
      fileCount: 2,
      removedEvents: 14,
    });
    const partial = rewindRecord(observed({ errors: ['src/b.ts: EBUSY'] }), 'retry', 'Not sent');
    expect(partial).toMatchObject({ outcome: 'partial', operation: 'retry', note: 'Not sent' });
    const redo = redoRecord({ checkpoint: 2, files: ['src/a.ts'], messageCount: 9 });
    expect(redo).toMatchObject({ outcome: 'completed', removedEvents: null, fileCount: 1 });
    const failed = unfinishedRecord('redo', 'failed', null, 'timeout');
    expect(failed).toMatchObject({ checkpoint: null, fileCount: 0, note: 'timeout' });
  });
  it('keep the full file count while bounding the stored paths', async () => {
    const files = Array.from({ length: 150 }, (_, index) => `f${index}.ts`);
    const item = rewindRecord(observed({ files }), 'rewind');
    expect(item.files).toHaveLength(100);
    expect(item.fileCount).toBe(150);
    expect(await loadError({ version: 1, entries: [item] })).toBe('');
  });
  it('report malformed saved records instead of loading them', async () => {
    const item = rewindRecord(observed(), 'rewind');
    expect(await loadError({ version: 2, entries: [] })).toContain('unsupported format');
    expect(await loadError({ version: 1, entries: [{ ...item, operation: 'delete' }] })).toContain(
      'unsupported format',
    );
    expect(await loadError({ version: 1, entries: [{ ...item, fileCount: 1 }] })).toContain(
      'unsupported format',
    );
  });
  it('keep the newest 50, once per id', async () => {
    const { storage, slot } = memoryStorage();
    const log = createRecoveryLog();
    await log.attach('s1', storage);
    const items = Array.from({ length: 55 }, (_, index) =>
      unfinishedRecord('rewind', 'refused', index, 'changed', index + 1),
    );
    for (const item of items) await log.record('s1', item);
    await log.record('s1', items[54]!);
    expect(log.list('s1')).toHaveLength(50);
    expect(log.list('s1')[0]?.at).toBe(55);
    expect(slot.value?.entries.at(-1)?.at).toBe(6);
  });
  it('survive a restart and merge with another window', async () => {
    const { storage, slot } = memoryStorage();
    const mine = createRecoveryLog(),
      peer = createRecoveryLog();
    await mine.attach('s1', storage);
    await peer.attach('s1', storage);
    await peer.record('s1', unfinishedRecord('redo', 'failed', null, 'peer', 1));
    await mine.record('s1', rewindRecord(observed(), 'rewind', '', 2));
    expect(slot.value?.entries.map((item) => item.at)).toEqual([2, 1]);
    const restarted = createRecoveryLog();
    await restarted.attach('s1', storage);
    expect(restarted.list('s1').map((item) => item.operation)).toEqual(['rewind', 'redo']);
    expect(restarted.error('s1')).toBe('');
  });
  it('key sessions apart', async () => {
    const a = await recoveryLogKey('p1', 's1'),
      b = await recoveryLogKey('p1', 's2');
    expect(a).toMatch(/^session-recovery-log:[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
