import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendKanbanEvent, getKanbanEventsPath } from '../src/storage.js';

/**
 * F37 (WS-045 class): appendKanbanEvent appends board events — task content (its
 * own WS-035 comment) — via fs.appendFile + mode 0o600 (a Windows no-op) with no
 * owner-only hardening. On Windows the event log stayed readable by other local
 * accounts where inheritance was not owner-only. Each file is hardened once
 * (best-effort) and re-hardened after the trim rewrite.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the event log path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f37-'));
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

describe('kanban event log owner-only hardening (F37)', () => {
  it('hardens the event log on appendKanbanEvent', async () => {
    await appendKanbanEvent(dir, 'board1', { sessionId: 's1', type: 'task_created' } as never);
    const fp = getKanbanEventsPath(dir, 'board1');
    expect(hardened(fp), 'appendKanbanEvent issues icacls for the event log').toBe(true);
  });

  it('hardens ONCE across multiple appends', async () => {
    await appendKanbanEvent(dir, 'board1', { sessionId: 's1', type: 'a' } as never);
    await appendKanbanEvent(dir, 'board1', { sessionId: 's1', type: 'b' } as never);
    const fp = getKanbanEventsPath(dir, 'board1');
    const count = icaclsCalls.filter((c) => c.file === 'icacls' && c.args[0] === fp).length;
    expect(count).toBe(1);
  });
});
