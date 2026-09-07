/**
 * Regression for S7 (RACE-002 / G5): the previous `withFileLock` wrote
 * `${pid}:${mtime}` and the `finally` block unconditionally unlinked
 * the file. After a stale-break, a process whose heartbeat missed the
 * staleMs window could have its lock re-acquired by a second holder;
 * the first holder's release would then delete the *second* holder's
 * live lock and admit a third. The fix writes a 16-byte random token
 * alongside the pid; both the release and the stale-break paths read
 * it back and only unlink on a match.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileLock } from '../src/atomic-write.js';
import { _projectEndpointOps as ops } from '../src/project-endpoint.js';

// We need the persistence-side lock file path. `withFileLock` derives
// it as `${targetPath}.lock` next to the target.
const lockPath = (target: string): string => `${target}.lock`;

describe('S7 / withFileLock — ownership-token release', () => {
  it('does not unlink a lock that a different process re-acquired', async () => {
    ops.platform = 'linux';
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 's7-token-'));
    try {
      const target = path.join(tmp, 'state.json');
      await fs.writeFile(target, 'init');

      // 1. First holder acquires, runs a long section, and is asked to
      //    release — but we corrupt its lock to look like a different
      //    pid mid-run.
      let releaseObserved = false;
      const held = withFileLock(target, async () => {
        // Simulate the stale-break scenario: the lock file gets
        // re-acquired by another actor (we overwrite the contents
        // with a foreign pid+token). The first holder's release
        // MUST NOT unlink that new lock.
        await fs.writeFile(
          lockPath(target),
          `${process.pid + 1}:foreign-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
        );
        await new Promise((r) => setTimeout(r, 50));
        releaseObserved = true;
        return 'first';
      });

      // 2. Second holder waits, then acquires after the file's mtime
      //    is older than `staleMs`. We can simulate that with a
      //    short-staleMs call here, or simply wait for the first
      //    holder to finish and then assert the file content is
      //    unchanged.
      const result = await held;
      expect(result).toBe('first');
      expect(releaseObserved).toBe(true);

      // The lock file must still exist (a foreign pid+token lives
      // there) and must NOT have been deleted by the first holder's
      // release.
      const after = await fs.readFile(lockPath(target), 'utf8');
      expect(after).toContain('foreign-token');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('unlinks its own lock when the file still names this pid+token', async () => {
    ops.platform = 'linux';
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 's7-self-'));
    try {
      const target = path.join(tmp, 'state.json');
      await fs.writeFile(target, 'init');
      const result = await withFileLock(target, async () => 'ok');
      expect(result).toBe('ok');
      // The happy path: the lock file was released and is gone.
      await expect(fs.access(lockPath(target))).rejects.toThrow();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
