import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SECRET_FILE_MODE } from '@wrongstack/core/security';
import { atomicWrite } from '@wrongstack/core/utils';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChronicleJournal, createChronicleContext } from '../src/index.js';
import { rotatedPath } from '../src/journal-partitions.js';

/**
 * F21 (WS-045 class, F20 sibling): ChronicleJournal.persistBatch() appends the
 * event journal — which carries tool inputs/outputs — with `mode: 0o600`, a
 * no-op on Windows, and never called the owner-only hardening that comparable
 * atomicWrite secret writes get. The journal now hardens each partition once
 * (first batch) via restrictFilePermissions: best-effort (warned, never thrown),
 * idempotent, rotation-aware, no per-batch icacls spawn on the hot append path.
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f21-'));
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
const context = createChronicleContext(
  { installationId: 'i1', machineId: 'm1', projectId: 'p1', sessionId: 's1' },
  'trace-1',
);
const event = { eventType: 'tool.completed', ...context, outcome: 'success' as const };

describe('ChronicleJournal owner-only hardening (F21)', () => {
  it('control: a comparable atomicWrite secret write hardens', async () => {
    const sibling = path.join(dir, 'sibling.json');
    await atomicWrite(sibling, '{}\n', { mode: SECRET_FILE_MODE });
    expect(hardened(sibling)).toBe(true);
  });

  it('hardens the partition on first batch', async () => {
    const filePath = path.join(dir, 'events.jsonl');
    const journal = new ChronicleJournal({ filePath });
    await journal.append(event);
    await journal.flush();
    expect(hardened(filePath)).toBe(true);
  });

  it('hardens ONCE per partition — no per-batch icacls spawn', async () => {
    const filePath = path.join(dir, 'events.jsonl');
    const journal = new ChronicleJournal({ filePath, batchWindowMs: 0 });
    await journal.append(event);
    await journal.append(event);
    await journal.append(event);
    await journal.flush();
    expect(hardenCount(filePath)).toBe(1);
  });

  it('hardens each rotated partition', async () => {
    const filePath = path.join(dir, 'events.jsonl');
    const journal = new ChronicleJournal({ filePath, maxPartitionSizeBytes: 1, batchWindowMs: 0 });
    await journal.append(event);
    await journal.flush();
    await journal.append(event);
    await journal.flush();
    expect(hardened(filePath)).toBe(true);
    expect(hardened(rotatedPath(filePath, 1))).toBe(true);
  });

  it('hardens a pre-existing (legacy unhardened) partition on first contact', async () => {
    const filePath = path.join(dir, 'events.jsonl');
    await fs.writeFile(filePath, '');
    const journal = new ChronicleJournal({ filePath });
    await journal.append(event);
    await journal.flush();
    expect(hardened(filePath)).toBe(true);
  });

  it('POSIX: applies chmod 0o600 instead of icacls', async () => {
    _filePermOps.platform = 'linux';
    _filePermOps.execFileAsync = undefined;
    _filePermOps.chmod = async (p, mode) => {
      chmodCalls.push({ path: p, mode });
    };
    const filePath = path.join(dir, 'events.jsonl');
    const journal = new ChronicleJournal({ filePath });
    await journal.append(event);
    await journal.flush();
    expect(chmodCalls.some((c) => c.path === filePath && c.mode === SECRET_FILE_MODE)).toBe(true);
    expect(icaclsCalls.length).toBe(0);
  });

  it('hardening failure is best-effort: the event still persists', async () => {
    win32Seam(async () => {
      throw new Error('icacls unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const filePath = path.join(dir, 'events.jsonl');
    const journal = new ChronicleJournal({ filePath });
    const persisted = await journal.append(event);
    await journal.flush();
    expect(persisted.sequence).toBe(1);
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toContain('tool.completed');
    warn.mockRestore();
  });
});
