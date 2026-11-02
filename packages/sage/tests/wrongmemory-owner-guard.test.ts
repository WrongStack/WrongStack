import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertStoreNotOwnedByWrongMemory,
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
});
