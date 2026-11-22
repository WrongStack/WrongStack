import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SECRET_FILE_MODE } from '@wrongstack/core/security';
import { atomicWrite } from '@wrongstack/core/utils';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HqEventLog } from '../src/persistence/event-log.js';
import { createHqEventEnvelope } from '../src/protocol/core.js';

/**
 * F23 (WS-045 class, F20 sibling): HqEventLog.appendInternal() appends the HQ
 * event log — session content — with `mode: 0o600` (a Windows no-op; WS-035
 * fixed POSIX only) and never hardened the common append path. Rotation rewrites
 * via atomicReplaceWithWriter (which hardens), but between rotations the log is
 * only appended → readable by other local accounts where inheritance was not
 * owner-only. The log now hardens once per active file via restrictFilePermissions
 * (best-effort, warned not thrown, no per-batch icacls spawn) and re-hardens the
 * rotated file on the next append.
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f23-'));
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
const envelope = (seq: number) =>
  createHqEventEnvelope({
    id: `e${seq}`,
    type: 'session.note',
    timestamp: '2026-11-22T00:00:00.000Z',
    clientId: 'c1',
    projectId: 'p1',
    seq,
    payload: { text: 'SECRET content' },
  });
const logPath = () => path.join(dir, 'events.jsonl');

describe('HqEventLog owner-only hardening (F23)', () => {
  it('control: a comparable atomicWrite secret write hardens', async () => {
    const sibling = path.join(dir, 'sibling.json');
    await atomicWrite(sibling, '{}\n', { mode: SECRET_FILE_MODE });
    expect(hardened(sibling)).toBe(true);
  });

  it('hardens the file on first append', async () => {
    const log = new HqEventLog({ dataDir: dir });
    log.append(envelope(1));
    await log.drain();
    expect(hardened(logPath())).toBe(true);
  });

  it('hardens ONCE between rotations — no per-batch icacls spawn', async () => {
    const log = new HqEventLog({ dataDir: dir });
    log.append(envelope(1));
    log.append(envelope(2));
    log.append(envelope(3));
    await log.drain();
    expect(hardenCount(logPath())).toBe(1);
  });

  it('re-hardens the rotated file on the next append', async () => {
    const log = new HqEventLog({ dataDir: dir, maxLines: 1, rotateKeep: 1 });
    log.append(envelope(1));
    await log.drain();
    const afterFirst = hardenCount(logPath());
    log.append(envelope(2));
    await log.drain();
    expect(hardenCount(logPath())).toBeGreaterThan(afterFirst);
    expect(hardened(logPath())).toBe(true);
  });

  it('POSIX: applies chmod 0o600 instead of icacls', async () => {
    _filePermOps.platform = 'linux';
    _filePermOps.execFileAsync = undefined;
    _filePermOps.chmod = async (p, mode) => {
      chmodCalls.push({ path: p, mode });
    };
    const log = new HqEventLog({ dataDir: dir });
    log.append(envelope(1));
    await log.drain();
    expect(chmodCalls.some((c) => c.path === logPath() && c.mode === SECRET_FILE_MODE)).toBe(true);
    expect(icaclsCalls.length).toBe(0);
  });

  it('hardening failure is best-effort: the event still persists', async () => {
    win32Seam(async () => {
      throw new Error('icacls unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = new HqEventLog({ dataDir: dir });
    log.append(envelope(1));
    await log.drain();
    const content = await fs.readFile(logPath(), 'utf8');
    expect(content).toContain('SECRET content');
    warn.mockRestore();
  });
});
