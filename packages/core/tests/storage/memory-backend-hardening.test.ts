import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryEntry } from '@wrongstack/contracts/types/memory';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileMemoryBackend } from '../../src/storage/memory-backend.js';

/**
 * F42 (WS-045 class): FileMemoryBackend.remember appends memory notes — user
 * content (its own WS-035 comment) — via fs.open(…, 'a+', SECRET_FILE_MODE) +
 * handle.appendFile. The mode is a Windows no-op and the append path had no
 * owner-only hardening (the rewrite paths use atomicWrite, which hardens). On
 * Windows the memory file stayed readable by other local accounts where
 * inheritance was not owner-only. Each file is hardened once per backend
 * instance (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the memory path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;
let file: string;
let backend: FileMemoryBackend;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f42-'));
  file = path.join(dir, 'memory.md');
  backend = new FileMemoryBackend({ paths: {} as never });
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
const entry = (text: string): MemoryEntry => ({
  scope: 'project-memory',
  text,
  ts: '2026-01-01T00:00:00Z',
});

describe('memory append owner-only hardening (F42)', () => {
  it('hardens the memory file on remember', async () => {
    await backend.remember('project-memory', entry('private note'), file);
    expect(hardened(file), 'remember issues icacls for the memory file').toBe(true);
  });

  it('hardens ONCE across multiple appends', async () => {
    await backend.remember('project-memory', entry('first'), file);
    await backend.remember('project-memory', entry('second'), file);
    const count = icaclsCalls.filter((c) => c.file === 'icacls' && c.args[0] === file).length;
    expect(count).toBe(1);
  });
});
