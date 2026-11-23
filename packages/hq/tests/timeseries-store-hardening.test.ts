import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SECRET_FILE_MODE } from '@wrongstack/core/security';
import { atomicWrite } from '@wrongstack/core/utils';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HqTimeseriesStore } from '../src/persistence/timeseries-store.js';

/**
 * F24 (WS-045 class, F20 sibling): HqTimeseriesStore.flushInternal() appends the
 * cost-telemetry timeseries log with `mode: 0o600` (a Windows no-op) and never
 * hardened the common append path. Compaction rewrites via atomicWrite (which
 * hardens), but between compactions the log is only appended → readable by other
 * local accounts where inheritance was not owner-only. The store now hardens once
 * per active file via restrictFilePermissions (best-effort, warned not thrown, no
 * per-flush icacls spawn) and re-hardens the compacted file on the next flush.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps) and capture
 * icacls invocations — environment-independent.
 */

const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
const chmodCalls: Array<{ path: string; mode: number }> = [];
let dir: string;

function win32Seam(
  execImpl?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>,
) {
  _filePermOps.platform = 'win32';
  _filePermOps.userInfo = (() => ({
    username: 'tester',
    uid: -1,
    gid: -1,
    homedir: 'C:\\Users\\tester',
    shell: null,
  })) as unknown as typeof _filePermOps.userInfo;
  _filePermOps.execFileAsync =
    execImpl ??
    (async (file, args) => {
      icaclsCalls.push({ file, args });
      return { stdout: '', stderr: '' };
    });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f24-'));
  icaclsCalls.length = 0;
  chmodCalls.length = 0;
  win32Seam();
});

afterEach(async () => {
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  _filePermOps.chmod = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);
const hardenCount = (t: string) =>
  icaclsCalls.filter((c) => c.file === 'icacls' && c.args[0] === t).length;
const filePath = () => path.join(dir, 'timeseries.jsonl');

async function flushBucket(store: HqTimeseriesStore, n: number) {
  store.record({ ts: n * 1000, costUsd: 0.01 });
  store.flush();
  await store.drain();
}

describe('HqTimeseriesStore owner-only hardening (F24)', () => {
  it('control: a comparable atomicWrite secret write hardens', async () => {
    const sibling = path.join(dir, 'sibling.json');
    await atomicWrite(sibling, '{}\n', { mode: SECRET_FILE_MODE });
    expect(hardened(sibling)).toBe(true);
  });

  it('hardens the file on first flush', async () => {
    const store = new HqTimeseriesStore({ dataDir: dir, bucketMs: 1000 });
    await flushBucket(store, 1);
    expect(hardened(filePath())).toBe(true);
  });

  it('hardens ONCE between compactions — no per-flush icacls spawn', async () => {
    const store = new HqTimeseriesStore({ dataDir: dir, bucketMs: 1000 });
    await flushBucket(store, 1);
    await flushBucket(store, 2);
    await flushBucket(store, 3);
    expect(hardenCount(filePath())).toBe(1);
  });

  it('re-hardens the compacted file on the next flush', async () => {
    const store = new HqTimeseriesStore({ dataDir: dir, bucketMs: 1000, maxBuckets: 1 });
    for (let n = 1; n <= 4; n++) await flushBucket(store, n);
    const afterCompaction = hardenCount(filePath());
    await flushBucket(store, 5);
    expect(hardenCount(filePath())).toBeGreaterThan(afterCompaction);
    expect(hardened(filePath())).toBe(true);
  });

  it('POSIX: applies chmod 0o600 instead of icacls', async () => {
    _filePermOps.platform = 'linux';
    _filePermOps.execFileAsync = undefined;
    _filePermOps.chmod = async (p, mode) => {
      chmodCalls.push({ path: p, mode });
    };
    const store = new HqTimeseriesStore({ dataDir: dir, bucketMs: 1000 });
    await flushBucket(store, 1);
    expect(chmodCalls.some((c) => c.path === filePath() && c.mode === SECRET_FILE_MODE)).toBe(true);
    expect(icaclsCalls.length).toBe(0);
  });

  it('hardening failure is best-effort: the sample still persists', async () => {
    win32Seam(async () => {
      throw new Error('icacls unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new HqTimeseriesStore({ dataDir: dir, bucketMs: 1000 });
    await flushBucket(store, 1);
    const content = await fs.readFile(filePath(), 'utf8');
    expect(content).toContain('costUsd');
    warn.mockRestore();
  });
});
