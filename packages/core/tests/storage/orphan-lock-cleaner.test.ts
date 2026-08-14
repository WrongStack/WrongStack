import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanOrphanLocks } from '../../src/storage/orphan-lock-cleaner.js';

describe('cleanOrphanLocks', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orphan-locks-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('never deletes .git/index.lock — age is not a liveness signal', async () => {
    const gitDir = path.join(tmpDir, '.git');
    await fsp.mkdir(gitDir, { recursive: true });
    const lockFile = path.join(gitDir, 'index.lock');
    await fsp.writeFile(lockFile, 'test lock content');

    const pastTime = (Date.now() - 3600 * 1000) / 1000;
    await fsp.utimes(lockFile, pastTime, pastTime);

    const res = await cleanOrphanLocks(tmpDir, { maxLockAgeMs: 60 * 1000 });
    expect(res.cleanedGitLocks).toHaveLength(0);
    const stat = await fsp.stat(lockFile);
    expect(stat.isFile()).toBe(true);
  });

  it('keeps fresh .git/index.lock if newer than maxLockAgeMs', async () => {
    const gitDir = path.join(tmpDir, '.git');
    await fsp.mkdir(gitDir, { recursive: true });
    const lockFile = path.join(gitDir, 'index.lock');
    await fsp.writeFile(lockFile, 'fresh lock content');

    const res = await cleanOrphanLocks(tmpDir, { maxLockAgeMs: 60 * 1000 });
    expect(res.cleanedGitLocks).toHaveLength(0);
    const stat = await fsp.stat(lockFile);
    expect(stat.isFile()).toBe(true);
  });

  it('cleans up worktree lock when owning pid is dead', async () => {
    const wtDir = path.join(tmpDir, '.wrongstack', 'worktrees', 'subagent-1');
    await fsp.mkdir(wtDir, { recursive: true });
    const lockFile = path.join(wtDir, '.lock');
    await fsp.writeFile(lockFile, '99999999'); // Non-existent PID

    const res = await cleanOrphanLocks(tmpDir, {
      isPidAlive: (pid) => pid === 1234, // 99999999 is dead
    });

    expect(res.cleanedWorktrees).toContain(wtDir);
    await expect(fsp.stat(lockFile)).rejects.toThrow();
  });
});
