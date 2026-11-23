import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeAdoptMovedSession } from '../../src/storage/session-store/move-session.js';
import type { SessionArchiveHost } from '../../src/storage/session-store/session-archive.js';

/**
 * F44 (WS-045 class): executeAdoptMovedSession rewrites a moved session's
 * `.summary.json` (session metadata incl. the user-given name) via
 * fsp.writeFile + mode 0o600 (a Windows no-op) with no owner-only hardening.
 * On Windows the summary stayed readable by other local accounts where
 * inheritance was not owner-only. The rewritten summary is hardened
 * (best-effort); the no-name path writes nothing and hardens nothing.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the summary path; a minimal fake archive host over real temp files.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;
let host: SessionArchiveHost;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f44-'));
  await fs.writeFile(path.join(dir, 'sess1.jsonl'), '{"type":"prompt"}\n');
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
  host = {
    dir,
    sessionPath: (id: string, suffix: string) => path.join(dir, `${id}${suffix}`),
    invalidateShardManifestBySessionId: async () => {},
    summaryFor: async () => ({
      id: 'sess1',
      title: 't',
      startedAt: '2026-01-01',
      model: 'm',
      provider: 'p',
    }),
    catalogClient: undefined,
    appendToIndex: async () => {},
    clearLoadCache: () => {},
  } as unknown as SessionArchiveHost;
});

afterEach(async () => {
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);
const summaryPath = () => path.join(dir, 'sess1.summary.json');

describe('moved-session summary owner-only hardening (F44)', () => {
  it('hardens the rewritten summary when a name is carried over', async () => {
    const summary = await executeAdoptMovedSession(host, 'sess1', 'my session');
    expect(summary.name).toBe('my session');
    expect(hardened(summaryPath()), 'adopt issues icacls for .summary.json').toBe(true);
  });

  it('writes and hardens nothing when no name is carried over', async () => {
    await executeAdoptMovedSession(host, 'sess1', undefined);
    expect(hardened(summaryPath()), 'no summary write → no hardening').toBe(false);
    await expect(fs.stat(summaryPath())).rejects.toThrow();
  });
});
