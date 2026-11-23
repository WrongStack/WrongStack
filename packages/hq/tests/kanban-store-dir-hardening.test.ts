import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { HqKanbanStore } from '../src/kanban-store.js';

/**
 * F69 (WS-045 directory-hardening-on-creation class): HqKanbanStore's writer
 * creates the HQ kanban directory via fs.mkdir with no mode and no owner-only
 * hardening (the snapshot file itself uses atomicWrite, which hardens). Board
 * snapshots carry task content. On Windows anything else created inside
 * inherits whatever the HQ dataDir grants. Hardening the directory AT
 * CREATION (icacls (OI)(CI) inheritance) covers future children.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the kanban directory.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f69-'));
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

describe('HQ kanban directory-hardening-on-creation (F69)', () => {
  it('hardens the kanban directory when the writer prepares it', async () => {
    const store = new HqKanbanStore(dir);
    await store.merge({
      projectId: 'project-1',
      generatedAt: '2026-07-22T12:00:00.000Z',
      boards: [
        {
          boardId: 'board-1',
          revision: 1,
          updatedAt: '2026-07-22T12:00:00Z',
          board: { id: 'board-1', title: 't' },
        },
      ],
      tombstones: [],
    } as never);
    await store.drain();
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'kanban dir is hardened').toContain(path.join(dir, 'kanban'));
  });
});
