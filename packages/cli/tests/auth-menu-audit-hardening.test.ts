import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileAuditSink } from '../src/auth-menu/auth-menu-audit.js';

/**
 * F31 (WS-045 class): fileAuditSink appends the authentication audit trail — who
 * signed in, against which provider, when — via appendFileSync + mode 0o600 (a
 * Windows no-op, applied only on create) with no owner-only hardening. On Windows
 * the audit log stayed readable by other local accounts where inheritance was not
 * owner-only. The sink hardens once (best-effort, fire-and-forget after the first
 * synchronous append, so the sync sink contract is preserved).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the audit path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f31-'));
  icaclsCalls.length = 0;
  _filePermOps.platform = 'win32';
  _filePermOps.userInfo = (() => ({
    username: 'tester',
    uid: -1,
    gid: -1,
    homedir: 'C:\\Users\\tester',
    shell: null,
  })) as typeof _filePermOps.userInfo;
  _filePermOps.execFileAsync = async (file, args) => {
    icaclsCalls.push({ file, args });
    return { stdout: '', stderr: '' };
  };
});

afterEach(async () => {
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('auth audit file sink owner-only hardening (F31)', () => {
  it('hardens the audit log on first write', async () => {
    const filePath = path.join(dir, 'auth-audit.jsonl');
    const sink = fileAuditSink(filePath);
    sink.write(JSON.stringify({ event: 'signin', provider: 'openai' }));
    await sleep(20); // let the best-effort async hardening settle
    expect(hardened(filePath), 'fileAuditSink issues icacls for the audit log').toBe(true);
  });

  it('hardens ONCE across multiple writes', async () => {
    const filePath = path.join(dir, 'auth-audit.jsonl');
    const sink = fileAuditSink(filePath);
    sink.write('a');
    sink.write('b');
    sink.write('c');
    await sleep(20);
    const count = icaclsCalls.filter((c) => c.file === 'icacls' && c.args[0] === filePath).length;
    expect(count).toBe(1);
  });
});
