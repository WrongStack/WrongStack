import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECRET_FILE_MODE } from '../../src/security/file-permissions.js';
import { ToolAuditLog } from '../../src/storage/tool-audit-log.js';
import { atomicWrite } from '../../src/utils/atomic-write.js';

/**
 * F20 (WS-045 class): ToolAuditLog.record() appends the raw-tool-I/O sidecar
 * with `mode: 0o600`, which on Windows is a no-op — the file stayed readable by
 * other local accounts wherever inheritance was not already owner-only, while
 * comparable atomicWrite secret writes got icacls hardening. The writer now
 * hardens the sidecar once per session via restrictFilePermissions (best-effort,
 * warned not thrown; no per-call icacls spawn on the hot audit path).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps) and
 * capture icacls invocations — environment-independent (no real ACL needed).
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f20-'));
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

const hardened = (target: string) =>
  icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === target);
const hardenCount = (target: string) =>
  icaclsCalls.filter((c) => c.file === 'icacls' && c.args[0] === target).length;

async function record(audit: ToolAuditLog, sessionId: string) {
  return audit.record({
    sessionId,
    toolName: 'bash',
    toolUseId: 'tu',
    input: { command: 'echo SECRET=abc' },
    output: { stdout: 'SECRET=abc' },
    isError: false,
  });
}

describe('ToolAuditLog owner-only hardening (F20)', () => {
  it('control: a comparable atomicWrite secret write hardens its file', async () => {
    const sibling = path.join(dir, 'sibling.json');
    await atomicWrite(sibling, '{}\n', { mode: SECRET_FILE_MODE });
    expect(hardened(sibling)).toBe(true);
  });

  it('hardens the raw-tool-I/O sidecar on first record', async () => {
    const sessionsDir = path.join(dir, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    const audit = new ToolAuditLog({ dir: sessionsDir });
    await record(audit, 'sess_A');
    expect(hardened(path.join(sessionsDir, 'sess_A.audit.jsonl'))).toBe(true);
  });

  it('hardens ONCE per session — no per-call icacls spawn', async () => {
    const sessionsDir = path.join(dir, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    const audit = new ToolAuditLog({ dir: sessionsDir });
    await record(audit, 'sess_A');
    await record(audit, 'sess_A');
    await record(audit, 'sess_A');
    expect(hardenCount(path.join(sessionsDir, 'sess_A.audit.jsonl'))).toBe(1);
  });

  it('hardens each distinct session', async () => {
    const sessionsDir = path.join(dir, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    const audit = new ToolAuditLog({ dir: sessionsDir });
    await record(audit, 'sess_A');
    await record(audit, 'sess_B');
    expect(hardened(path.join(sessionsDir, 'sess_A.audit.jsonl'))).toBe(true);
    expect(hardened(path.join(sessionsDir, 'sess_B.audit.jsonl'))).toBe(true);
  });

  it('hardens a pre-existing (legacy unhardened) sidecar on first contact', async () => {
    const sessionsDir = path.join(dir, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    const fp = path.join(sessionsDir, 'sess_OLD.audit.jsonl');
    await fs.writeFile(fp, '');
    const audit = new ToolAuditLog({ dir: sessionsDir });
    await record(audit, 'sess_OLD');
    expect(hardened(fp)).toBe(true);
  });

  it('POSIX: applies chmod 0o600 instead of icacls', async () => {
    _filePermOps.platform = 'linux';
    _filePermOps.execFileAsync = undefined;
    _filePermOps.chmod = async (p, mode) => {
      chmodCalls.push({ path: p, mode });
    };
    const sessionsDir = path.join(dir, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    const audit = new ToolAuditLog({ dir: sessionsDir });
    await record(audit, 'sess_P');
    const fp = path.join(sessionsDir, 'sess_P.audit.jsonl');
    expect(chmodCalls.some((c) => c.path === fp && c.mode === SECRET_FILE_MODE)).toBe(true);
    expect(icaclsCalls.length).toBe(0);
  });

  it('hardening failure is best-effort: the record still persists', async () => {
    win32Seam(async () => {
      throw new Error('icacls unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionsDir = path.join(dir, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    const audit = new ToolAuditLog({ dir: sessionsDir });
    const entry = await record(audit, 'sess_F');
    expect(entry.toolName).toBe('bash');
    const content = await fs.readFile(path.join(sessionsDir, 'sess_F.audit.jsonl'), 'utf8');
    expect(content).toContain('SECRET=abc');
    warn.mockRestore();
  });
});
