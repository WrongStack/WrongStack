import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaemon } from '../src/client.js';
import { isWrongMemoryError } from '../src/errors.js';

// F1571: a daemonPath that exists but cannot be executed made spawn emit a
// ChildProcess 'error' with no listener (an uncaught exception that takes the
// host down) or throw a raw errno error, instead of the typed UNAVAILABLE the
// missing-executable branch already reports.
describe('startDaemon with an unusable daemon executable', () => {
  const dirs: string[] = [];
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => {
    uncaught.push(error);
  };

  afterEach(async () => {
    process.off('uncaughtException', onUncaught);
    uncaught.length = 0;
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  const flush = async (turns = 200) => {
    for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
  };

  async function attempt(daemonPath: (root: string) => Promise<string>) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongmem-start-'));
    dirs.push(root);
    const exe = await daemonPath(root);
    process.prependListener('uncaughtException', onUncaught);
    // startTimeoutMs 0 skips the readiness probes: only the spawn itself runs.
    const rejection = await startDaemon(root, { daemonPath: exe, startTimeoutMs: 0 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();
    return rejection;
  }

  it('reports a directory as UNAVAILABLE without an uncaught spawn error', async () => {
    const rejection = await attempt(async (root) => {
      const dir = path.join(root, 'wrongmemoryd-dir');
      await fs.mkdir(dir);
      return dir;
    });
    expect(isWrongMemoryError(rejection, 'UNAVAILABLE')).toBe(true);
    expect(uncaught).toEqual([]);
  });

  it('reports a non-executable file as UNAVAILABLE', async () => {
    const rejection = await attempt(async (root) => {
      const file = path.join(root, 'wrongmemoryd.txt');
      await fs.writeFile(file, 'not a program', { mode: 0o644 });
      return file;
    });
    expect(isWrongMemoryError(rejection, 'UNAVAILABLE')).toBe(true);
    expect(uncaught).toEqual([]);
  });
});
