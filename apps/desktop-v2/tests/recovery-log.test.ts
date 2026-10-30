import { describe, expect, it } from 'vitest';
import { DurableSessionLog } from '../src/durable-session-log';
import {
  MAX_RECOVERY_RECORDS,
  mergeRecoveryRecords,
  parseRecoveryLog,
  type RecoveryRecord,
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

function store() {
  return new DurableSessionLog<RecoveryRecord>({
    label: 'Recovery records',
    parse: parseRecoveryLog,
    merge: mergeRecoveryRecords,
    serialize: (entries) => ({ version: 1, entries }),
  });
}
function memoryStorage() {
  const slot = { revision: 0, value: null as SavedRecoveryLog | null };
  return {
    slot,
    storage: {
      get: async () => ({ revision: slot.revision, value: structuredClone(slot.value) }),
      save: async (value: SavedRecoveryLog | null, expected: number) => {
        if (expected !== slot.revision)
          throw Error('DRAFT_CONFLICT: This draft changed in another window');
        slot.value = structuredClone(value);
        return ++slot.revision;
      },
    },
  };
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
  it('keeps the full file count while bounding the stored paths', () => {
    const files = Array.from({ length: 150 }, (_, index) => `f${index}.ts`);
    const item = rewindRecord(observed({ files }), 'rewind');
    expect(item.files).toHaveLength(100);
    expect(item.fileCount).toBe(150);
    expect(parseRecoveryLog({ version: 1, entries: [item] })).toHaveLength(1);
  });
  it('rejects malformed saved records', () => {
    const item = rewindRecord(observed(), 'rewind');
    expect(() => parseRecoveryLog({ version: 2, entries: [] })).toThrow('unsupported');
    expect(() =>
      parseRecoveryLog({ version: 1, entries: [{ ...item, operation: 'delete' }] }),
    ).toThrow('unsupported');
    expect(() => parseRecoveryLog({ version: 1, entries: [{ ...item, fileCount: 1 }] })).toThrow(
      'unsupported',
    );
    expect(parseRecoveryLog(null)).toEqual([]);
  });
  it('merges newest first, once per id, within the bound', () => {
    const items = Array.from({ length: MAX_RECOVERY_RECORDS + 5 }, (_, index) =>
      unfinishedRecord('rewind', 'refused', index, 'changed', index + 1),
    );
    const merged = mergeRecoveryRecords(items, items.slice(0, 3));
    expect(merged).toHaveLength(MAX_RECOVERY_RECORDS);
    expect(merged[0]?.at).toBe(MAX_RECOVERY_RECORDS + 5);
  });
  it('survive a restart and merge with another window', async () => {
    const { storage, slot } = memoryStorage();
    const mine = store(),
      peer = store();
    await mine.attach('s1', storage);
    await peer.attach('s1', storage);
    await peer.record('s1', unfinishedRecord('redo', 'failed', null, 'peer', 1));
    await mine.record('s1', rewindRecord(observed(), 'rewind', '', 2));
    expect(slot.value?.entries.map((item) => item.at)).toEqual([2, 1]);
    const restarted = store();
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
