import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupRoot, undoDeadCodeFix, writeBackup } from '../src/dead-code/fix-backup.js';
import type { InternalPlan } from '../src/dead-code/fix-types.js';

describe('dead-code backup identity', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-code-backup-id-'));
    vi.stubEnv('WRONGSTACK_HOME', path.join(root, 'state'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('preserves the first backup when a gated second write lands on the same clock tick', async () => {
    const plan = (before: string) =>
      ({
        planned: ['finding'],
        internal: [{ file: 'a.txt', action: 'edit', before, after: 'fixed' }],
      }) as InternalPlan;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = (async () => {
      await gate;
      return writeBackup(root, plan('second'));
    })();
    const first = writeBackup(root, plan('first'));
    release();
    const second = await pending;
    expect(second.id).not.toBe(first.id);
    expect(fs.readFileSync(path.join(backupRoot(root), first.id, 'blobs', '0.txt'), 'utf8')).toBe(
      'first',
    );
    fs.writeFileSync(path.join(root, 'a.txt'), 'fixed');
    expect(undoDeadCodeFix(root, first.id).conflicts).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('first');
  });

  it('rejects dot-segment backupId traversal inputs (F251)', () => {
    expect(() => undoDeadCodeFix(root, '.')).toThrow(/invalid backup id/);
    expect(() => undoDeadCodeFix(root, '..')).toThrow(/invalid backup id/);
  });
});
