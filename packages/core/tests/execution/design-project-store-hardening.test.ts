import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { designProjectDir, recordKitChoice } from '../../src/execution/design-project-store.js';

/**
 * F99 (WS-045 no-mode class): recordKitChoice writes the active design kit
 * record (active.json) and appends the decisions log (decisions.md) via
 * fs.writeFile/fs.appendFile with NO mode and no hardening. Design state is
 * user project content. On Windows both stayed readable by other local
 * accounts where inheritance was not owner-only. Both are hardened
 * (best-effort) and the writes request 0o600 for POSIX.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f99-'));
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

describe('design project store owner-only hardening (F99)', () => {
  it('hardens the active kit record and the decisions log', async () => {
    await recordKitChoice(dir, 'modern-kit', 'nodejs', 'test', '2026-01-01T00:00:00Z');
    const designDir = designProjectDir(dir);
    expect(hardened(path.join(designDir, 'active.json')), 'active.json is hardened').toBe(true);
    expect(hardened(path.join(designDir, 'decisions.md')), 'decisions.md is hardened').toBe(true);
  });
});
