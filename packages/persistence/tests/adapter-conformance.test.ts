import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as coreAdapter from '../../core/src/utils/atomic-write.js';
import * as kanbanAdapter from '../../kanban/src/utils/atomic-write.js';
import * as persistence from '../src/index.js';

interface PersistenceAdapter {
  atomicWrite(
    targetPath: string,
    content: string | Uint8Array,
    opts?: persistence.AtomicWriteOptions,
  ): Promise<void>;
  ensureDir(dir: string): Promise<void>;
  withFileLock<T>(
    targetPath: string,
    fn: () => Promise<T>,
    opts?: persistence.FileLockOptions,
  ): Promise<T>;
}

const adapters: Array<[string, PersistenceAdapter]> = [
  ['persistence authority', persistence],
  ['Core compatibility adapter', coreAdapter],
  ['Kanban compatibility adapter', kanbanAdapter],
];

describe.each(adapters)('%s persistence conformance', (_label, adapter) => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-persistence-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('atomically writes strings and bytes into missing directories', async () => {
    const textPath = path.join(tempDir, 'nested', 'value.txt');
    const binaryPath = path.join(tempDir, 'nested', 'value.bin');
    await adapter.atomicWrite(textPath, 'first');
    await adapter.atomicWrite(textPath, 'second');
    await adapter.atomicWrite(binaryPath, new Uint8Array([0, 1, 127, 255]));

    await expect(fs.readFile(textPath, 'utf8')).resolves.toBe('second');
    expect([...(await fs.readFile(binaryPath))]).toEqual([0, 1, 127, 255]);
    expect(
      (await fs.readdir(path.dirname(textPath))).filter((entry) => entry.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('never widens an existing target mode and cleans a failed rename temp file', async () => {
    const modePath = path.join(tempDir, 'mode.txt');
    await fs.writeFile(modePath, 'old');
    if (process.platform !== 'win32') await fs.chmod(modePath, 0o600);
    await adapter.atomicWrite(modePath, 'new', { mode: 0o640 });
    if (process.platform !== 'win32') {
      expect((await fs.stat(modePath)).mode & 0o777).toBe(0o600);
    }

    const directoryTarget = path.join(tempDir, 'cannot-replace');
    await fs.mkdir(directoryTarget);
    await expect(adapter.atomicWrite(directoryTarget, 'failure')).rejects.toBeTruthy();
    expect((await fs.readdir(tempDir)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  // WS-045: the reverse direction was the bug. `commitTemp` stat'ed the target
  // first and used `opts.mode` ONLY when the target did not exist, so a file
  // that had once been created 0644 could never be tightened again: every
  // subsequent `atomicWrite(..., {mode: 0o600})` re-applied 0644. Secret files
  // (`auth.json`, `runtime.json`) go through exactly this path.
  it('tightens a pre-existing world-readable file to the requested mode', async () => {
    if (process.platform === 'win32') return; // POSIX bits are meaningless here
    const target = path.join(tempDir, 'was-0644.json');
    await fs.writeFile(target, '{}');
    await fs.chmod(target, 0o644);

    await adapter.atomicWrite(target, '{"secret":1}', { mode: 0o600 });

    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });

  it('applies the requested mode verbatim when the target does not exist', async () => {
    if (process.platform === 'win32') return;
    const target = path.join(tempDir, 'brand-new.json');
    await adapter.atomicWrite(target, '{}', { mode: 0o600 });
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });

  it('leaves the target mode untouched when no mode is requested', async () => {
    if (process.platform === 'win32') return;
    const target = path.join(tempDir, 'user-chmodded.txt');
    await fs.writeFile(target, 'a');
    await fs.chmod(target, 0o664);
    await adapter.atomicWrite(target, 'b');
    expect((await fs.stat(target)).mode & 0o777).toBe(0o664);
  });

  it('creates the lock directory lazily and always releases after callback failure', async () => {
    const target = path.join(tempDir, 'missing', 'deep', 'state.json');
    const lockPath = path.join(path.dirname(target), '.state.json.lock');
    await expect(
      adapter.withFileLock(target, async () => {
        throw new Error('expected callback failure');
      }),
    ).rejects.toThrow('expected callback failure');
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a stale lock without running the callback twice', async () => {
    const target = path.join(tempDir, 'stale.json');
    const lockPath = path.join(tempDir, '.stale.json.lock');
    await fs.writeFile(lockPath, 'stale-owner');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);
    let calls = 0;

    const result = await adapter.withFileLock(
      target,
      async () => {
        calls += 1;
        return 'recovered';
      },
      { timeoutMs: 1_000, staleMs: 50 },
    );

    expect(result).toBe('recovered');
    expect(calls).toBe(1);
  });

  it('keeps a long-held lock fresh so a concurrent holder cannot break in (heartbeat)', async () => {
    const target = path.join(tempDir, 'longheld.json');
    let inside = 0;
    let maxConcurrent = 0;
    const run = (label: string) =>
      adapter.withFileLock(
        target,
        async () => {
          inside += 1;
          maxConcurrent = Math.max(maxConcurrent, inside);
          // Hold well past staleMs. Without the heartbeat, the other caller
          // would deem this lock stale and steal it, overlapping the section.
          await new Promise((r) => setTimeout(r, 600));
          inside -= 1;
          return label;
        },
        { timeoutMs: 5_000, staleMs: 300 },
      );

    const [a, b] = await Promise.all([run('a'), run('b')]);
    expect(maxConcurrent).toBe(1); // ran sequentially — neither lock was stolen
    expect(new Set([a, b])).toEqual(new Set(['a', 'b']));
  });

  it('wakes when a contended lock is released', async () => {
    const target = path.join(tempDir, 'contended.json');
    const lockPath = path.join(tempDir, '.contended.json.lock');
    await fs.writeFile(lockPath, 'current-owner');
    const release = setTimeout(() => void fs.unlink(lockPath), 30);
    try {
      await expect(
        adapter.withFileLock(target, async () => 'acquired', {
          timeoutMs: 1_000,
          staleMs: 60_000,
        }),
      ).resolves.toBe('acquired');
    } finally {
      clearTimeout(release);
    }
  });

  it('returns a structured bounded-timeout error and never enters the callback', async () => {
    const target = path.join(tempDir, 'blocked.json');
    const lockPath = path.join(tempDir, '.blocked.json.lock');
    await fs.writeFile(lockPath, 'current-owner');
    let entered = false;

    const error = await adapter
      .withFileLock(
        target,
        async () => {
          entered = true;
        },
        { timeoutMs: 40, staleMs: 60_000 },
      )
      .catch((caught: unknown) => caught);

    expect(entered).toBe(false);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'FsError',
      code: 'FS_ATOMIC_WRITE_FAILED',
      path: target,
      context: { timeoutMs: 40 },
    });
  });
});
