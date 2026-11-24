import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { DefaultSessionStore } from '../../core/src/storage/session-store.js';
import { exportCmd } from '../src/subcommands/handlers/export.js';

/**
 * F95 (WS-045 no-mode class): `wstack export --out` writes the rendered
 * session transcript via fs.writeFile with NO mode and no hardening. The
 * export is verbatim conversation content. On Windows it stayed readable by
 * other local accounts where inheritance was not owner-only. The export file
 * is hardened (best-effort) and the write requests 0o600 for POSIX.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f95-'));
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

describe('session export owner-only hardening (F95)', () => {
  it('hardens the exported transcript file', async () => {
    const storeDir = path.join(dir, 'sessions');
    const store = new DefaultSessionStore({ dir: storeDir });
    const writer = await store.create({ id: 'sess1', model: 'm', provider: 'p', checkout: dir });
    await writer.append({
      type: 'user_input',
      ts: '2026-01-01T00:00:00Z',
      content: 'private question',
    });
    await writer.close();
    icaclsCalls.length = 0;
    const deps = {
      cwd: dir,
      sessionStore: store,
      renderer: { write: () => {}, writeError: () => {} },
    };
    const code = await exportCmd(['sess1', '--out', 'export.md'], deps as never);
    expect(code).toBe(0);
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'export file is hardened').toContain(path.join(dir, 'export.md'));
    expect(await fs.readFile(path.join(dir, 'export.md'), 'utf8')).toContain('private question');
  }, 60_000);
});
