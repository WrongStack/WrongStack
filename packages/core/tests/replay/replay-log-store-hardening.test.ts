import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayLogStore } from '../../src/index.js';
import { SECRET_FILE_MODE } from '../../src/security/file-permissions.js';
import { atomicWrite } from '../../src/utils/atomic-write.js';

/**
 * F22 (WS-045 class, F20 sibling): ReplayLogStore.record() appends the raw
 * request/response replay sidecar with `mode: 0o600` (a Windows no-op) and never
 * hardened the common append path. A session under the entry cap is only ever
 * appended (the rare eviction path rewrites via atomicWrite, which hardens), so
 * its replay file stayed readable by other local accounts where inheritance was
 * not owner-only. The writer now hardens once per session via
 * restrictFilePermissions: best-effort (warned, never thrown), idempotent, no
 * per-call icacls spawn on the hot record path.
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f22-'));
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
const input = (sessionId: string, n: number) => ({
  sessionId,
  request: { model: 'm', messages: [], maxTokens: n },
  response: { content: [], stopReason: 'end_turn', usage: { input: 0, output: 0 }, model: 'm' },
});

describe('ReplayLogStore owner-only hardening (F22)', () => {
  it('control: a comparable atomicWrite secret write hardens', async () => {
    const sibling = path.join(dir, 'sibling.json');
    await atomicWrite(sibling, '{}\n', { mode: SECRET_FILE_MODE });
    expect(hardened(sibling)).toBe(true);
  });

  it('hardens the sidecar on first record', async () => {
    const store = new ReplayLogStore({ dir });
    await store.record(input('sess_R', 1) as never);
    expect(hardened(path.join(dir, 'sess_R.replay.jsonl'))).toBe(true);
  });

  it('hardens ONCE per session — no per-call icacls spawn', async () => {
    const store = new ReplayLogStore({ dir });
    await store.record(input('sess_R', 1) as never);
    await store.record(input('sess_R', 2) as never);
    await store.record(input('sess_R', 3) as never);
    expect(hardenCount(path.join(dir, 'sess_R.replay.jsonl'))).toBe(1);
  });

  it('hardens each distinct session', async () => {
    const store = new ReplayLogStore({ dir });
    await store.record(input('sess_A', 1) as never);
    await store.record(input('sess_B', 1) as never);
    expect(hardened(path.join(dir, 'sess_A.replay.jsonl'))).toBe(true);
    expect(hardened(path.join(dir, 'sess_B.replay.jsonl'))).toBe(true);
  });

  it('hardens a pre-existing (legacy unhardened) sidecar on first contact', async () => {
    const fp = path.join(dir, 'sess_OLD.replay.jsonl');
    await fs.writeFile(fp, '');
    const store = new ReplayLogStore({ dir });
    await store.record(input('sess_OLD', 1) as never);
    expect(hardened(fp)).toBe(true);
  });

  it('POSIX: applies chmod 0o600 instead of icacls', async () => {
    _filePermOps.platform = 'linux';
    _filePermOps.execFileAsync = undefined;
    _filePermOps.chmod = async (p, mode) => {
      chmodCalls.push({ path: p, mode });
    };
    const store = new ReplayLogStore({ dir });
    await store.record(input('sess_P', 1) as never);
    const fp = path.join(dir, 'sess_P.replay.jsonl');
    expect(chmodCalls.some((c) => c.path === fp && c.mode === SECRET_FILE_MODE)).toBe(true);
    expect(icaclsCalls.length).toBe(0);
  });

  it('hardening failure is best-effort: the record still persists', async () => {
    win32Seam(async () => {
      throw new Error('icacls unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new ReplayLogStore({ dir });
    const hash = await store.record(input('sess_F', 1) as never);
    expect(typeof hash).toBe('string');
    const content = await fs.readFile(path.join(dir, 'sess_F.replay.jsonl'), 'utf8');
    expect(content).toContain('"model":"m"');
    warn.mockRestore();
  });
});
