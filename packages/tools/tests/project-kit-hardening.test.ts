import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KIT_HISTORY_DIRECTORY, loadKit } from '../src/project-kit/catalog.js';
import { executeKit } from '../src/project-kit/service.js';
import { projectKitTool } from '../src/project-kit.js';

/**
 * F54 (WS-045 class): executeKit snapshots the exact kit source bytes it is
 * about to run via writeFile(flag 'wx') + mode 0o600 (a Windows no-op) with no
 * owner-only hardening. Kit sources are project content (and may embed local
 * fixtures/credentials). On Windows the snapshot stayed readable by other
 * local accounts where inheritance was not owner-only. Every snapshot file is
 * hardened right after its exclusive create (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls under the run's source snapshot dir; the real template-kit fixture.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ws-f54-'));
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
  await rm(root, { recursive: true, force: true });
});

describe('kit source snapshot owner-only hardening (F54)', () => {
  it('hardens every snapshot file before execution', async () => {
    const ctx = { projectRoot: root, agentId: 'test-agent' } as never;
    const opts = { signal: new AbortController().signal };
    const template = (await projectKitTool.execute(
      { action: 'template', name: 'strings.unique' },
      ctx,
      opts,
    )) as { files: Record<string, string> };
    for (const [file, text] of Object.entries(template.files)) {
      const absolute = path.join(root, file);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, text);
    }
    const revision = (await loadKit(root, 'strings.unique')).revision;
    icaclsCalls.length = 0; // only count the run's snapshot hardening
    await executeKit({
      root,
      name: 'strings.unique',
      revision,
      action: 'verify',
      input: {},
      agentId: 'test-agent',
      signal: opts.signal,
    });
    const historyRoot = path.join(root, KIT_HISTORY_DIRECTORY, 'strings.unique');
    const snapshotCalls = icaclsCalls.filter(
      (c) =>
        c.file === 'icacls' &&
        c.args[0].startsWith(historyRoot) &&
        c.args[0].includes(`${path.sep}source${path.sep}`),
    );
    expect(snapshotCalls.length, 'each snapshot file is hardened').toBeGreaterThanOrEqual(
      Object.keys(template.files).length,
    );
  }, 120_000);
});
