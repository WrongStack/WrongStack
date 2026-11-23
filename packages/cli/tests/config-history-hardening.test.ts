import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendHistory } from '../src/config-history.js';

/**
 * F30 (WS-045 class): appendHistory writes config-history entry files (masked
 * config snapshot + diff summary) via fs.writeFile + mode 0o600 (a Windows
 * no-op) with no owner-only hardening. On Windows the entries stayed readable by
 * other local accounts where inheritance was not owner-only. Each entry is a new
 * file; it is hardened after its write.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the written entry file.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

async function findById(root: string, name: string): Promise<string | undefined> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findById(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return undefined;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f30-'));
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

describe('config-history entry owner-only hardening (F30)', () => {
  it('hardens the history entry it writes', async () => {
    const id = await appendHistory({}, { apiKey: 'SECRET-KEY' }, 'test change', () => dir);
    const entryFile = await findById(dir, `${id}.json`);
    expect(entryFile, 'entry file written').toBeTruthy();
    expect(
      icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === entryFile),
      'appendHistory issues icacls for the entry',
    ).toBe(true);
  });
});
