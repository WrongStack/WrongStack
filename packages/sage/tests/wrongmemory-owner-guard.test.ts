import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertStoreNotOwnedByWrongMemory,
  readWrongMemoryAdoptionMarker,
  SageStoreOwnedByWrongMemoryError,
  WRONGMEMORY_ADOPTION_MARKER_FILE,
  WRONGMEMORY_OWNER_LOCK_FILE,
  wrongMemoryOwnsStore,
} from '../src/wrongmemory-owner-guard.js';

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'wm-guard-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('WrongMemory owner guard (WM-107)', () => {
  it('a store without an owner lock is free', () => {
    const d = dir();
    expect(wrongMemoryOwnsStore(d)).toBe(false);
    expect(() => assertStoreNotOwnedByWrongMemory(d)).not.toThrow();
  });

  it('a readable (released) lock file does not block on Windows', () => {
    const d = dir();
    writeFileSync(
      path.join(d, WRONGMEMORY_OWNER_LOCK_FILE),
      '{"pid":1,"instanceId":"d_x","epoch":1}\n',
    );
    expect(wrongMemoryOwnsStore(d, 'win32')).toBe(false);
  });

  it('with advisory locks, a live owner pid blocks and a dead one does not', () => {
    const d = dir();
    const lock = path.join(d, WRONGMEMORY_OWNER_LOCK_FILE);
    // The parent process is alive and is not this process.
    writeFileSync(lock, `{"pid":${process.ppid},"instanceId":"d_x","epoch":1}\n`);
    expect(wrongMemoryOwnsStore(d, 'linux')).toBe(true);
    expect(() => {
      if (wrongMemoryOwnsStore(d, 'linux')) throw new Error('owned');
    }).toThrow('owned');
    writeFileSync(lock, '{"pid":2147483646,"instanceId":"d_x","epoch":1}\n');
    expect(wrongMemoryOwnsStore(d, 'linux')).toBe(false);
    writeFileSync(lock, 'not json');
    expect(wrongMemoryOwnsStore(d, 'linux')).toBe(false);
  });

  it('an adoption marker owns the store with no daemon and no lock', () => {
    const d = dir();
    const marker = path.join(d, WRONGMEMORY_ADOPTION_MARKER_FILE);
    expect(readWrongMemoryAdoptionMarker(d)).toBeUndefined();
    writeFileSync(
      marker,
      `${JSON.stringify({ schemaVersion: 1, projectId: 'p_1', dataRoot: 'D:/wm-data' })}\n`,
    );
    expect(readWrongMemoryAdoptionMarker(d)).toEqual({ projectId: 'p_1', dataRoot: 'D:/wm-data' });
    for (const platform of ['win32', 'linux'] as const) {
      expect(wrongMemoryOwnsStore(d, platform)).toBe(true);
    }
    expect(() => assertStoreNotOwnedByWrongMemory(d)).toThrow(SageStoreOwnedByWrongMemoryError);
    // Damaged content still marks the store as adopted; JSON without a schema does not.
    writeFileSync(marker, 'not json');
    expect(readWrongMemoryAdoptionMarker(d)).toEqual({});
    expect(wrongMemoryOwnsStore(d, 'win32')).toBe(true);
    writeFileSync(marker, '{"authToken":"x"}');
    expect(readWrongMemoryAdoptionMarker(d)).toBeUndefined();
    expect(wrongMemoryOwnsStore(d, 'win32')).toBe(false);
  });
});
