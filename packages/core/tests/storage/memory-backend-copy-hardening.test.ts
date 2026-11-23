import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryEntry } from '@wrongstack/contracts/types/memory';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileMemoryBackend } from '../../src/storage/memory-backend.js';

/**
 * F58 (WS-045 copy-time class): FileMemoryBackend.consolidate backs the memory
 * file up via fs.copyFile before the dedup rewrite. On Windows copyFile gives
 * the backup the destination's inherited ACL — NOT the source's owner-only ACL
 * — so the backup of user memory content stayed readable by other local
 * accounts. The backup is hardened right after the copy (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the .bak.* path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;
let file: string;
let backend: FileMemoryBackend;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f58-'));
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

const entry = (text: string): MemoryEntry => ({
  scope: 'project-memory',
  text,
  ts: '2026-01-01T00:00:00Z',
});

describe('memory consolidate backup copy-time hardening (F58)', () => {
  it('hardens the .bak backup of the memory file', async () => {
    await backend.remember('project-memory', entry('duplicate note'), file);
    await backend.remember('project-memory', entry('duplicate note'), file);
    icaclsCalls.length = 0; // only count the consolidate backup hardening
    const removed = await backend.consolidate('project-memory', file);
    // Valid-input control: dedup still works.
    expect(removed).toBe(1);
    expect(await backend.list('project-memory', file)).toHaveLength(1);
    const backupCalls = icaclsCalls.filter(
      (c) => c.file === 'icacls' && (c.args[0] ?? '').startsWith(`${file}.bak.`),
    );
    expect(backupCalls.length, 'consolidate issues icacls for the backup').toBe(1);
  });
});
