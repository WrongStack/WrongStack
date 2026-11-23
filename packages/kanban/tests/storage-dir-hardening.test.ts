import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { appendKanbanEvent, getKanbanEventsPath } from '../src/storage.js';

/**
 * F74 (WS-045 directory-hardening-on-creation class): appendKanbanEvent /
 * appendBoardHistory create the board directory via fs.mkdir with no
 * owner-only hardening (the event files themselves are hardened, F37). Board
 * events carry task content. On Windows anything else created inside inherits
 * whatever the parent grants. Hardening the directory once (icacls (OI)(CI)
 * inheritance) covers future children (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the board directory.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f74-'));
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

describe('kanban directory-hardening-on-creation (F74)', () => {
  it('hardens the board directory when it is created', async () => {
    await appendKanbanEvent(dir, 'board1', { sessionId: 's1', type: 'task_created' } as never);
    const boardDir = path.dirname(getKanbanEventsPath(dir, 'board1'));
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'board dir is hardened').toContain(boardDir);
  });
});
