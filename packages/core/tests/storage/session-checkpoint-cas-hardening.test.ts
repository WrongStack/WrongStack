import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionCheckpointCas } from '../../src/storage/session-checkpoint-cas.js';
import type { VcsRunResult } from '../../src/vcs/vcs-runner.js';

/**
 * F50 (WS-045 class): SessionCheckpointCas.putBlob writes checkpoint blobs —
 * verbatim workspace file content — via fsp.open(temp, 'wx', 0o600) +
 * handle.writeFile, then hard-links the temp into place. The mode is a Windows
 * no-op and neither the temp nor the published object was owner-only hardened.
 * On Windows the blobs stayed readable by other local accounts where
 * inheritance was not owner-only. The temp is hardened before the link (a
 * hard link shares the file's ACL, so the published object is covered too).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls under the CAS objects dir; the existing injected-VCS-runner harness
 * (no real git needed).
 */
const HEAD = 'a'.repeat(40);
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let tmp: string;
let project: string;
let casRoot: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ws-f50-'));
  project = path.join(tmp, 'project');
  casRoot = path.join(tmp, 'cas');
  await fsp.mkdir(path.join(project, 'src'), { recursive: true });
  await fsp.mkdir(path.join(project, '.git'), { recursive: true });
  await fsp.writeFile(path.join(project, 'src', 'a.ts'), 'checkpoint version', 'utf8');
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
  vi.restoreAllMocks();
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  await fsp.rm(tmp, { recursive: true, force: true });
});

function makeCas() {
  const runGit = vi.fn(async (args: string[]): Promise<VcsRunResult> => {
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${HEAD}\n`, stderr: '' };
    if (args[0] === 'diff') return { code: 0, stdout: 'src/a.ts\0', stderr: '' };
    if (args[0] === 'ls-files') return { code: 0, stdout: '\0', stderr: '' };
    if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected git invocation' };
  });
  return new SessionCheckpointCas({
    rootDir: casRoot,
    projectRoot: project,
    vcs: {
      runner: (_binary: string, args: readonly string[], cwd: string) => runGit([...args], cwd),
    },
  });
}

const objectHardeningCount = () =>
  icaclsCalls.filter(
    (c) => c.file === 'icacls' && c.args[0].startsWith(path.join(casRoot, 'objects')),
  ).length;

describe('checkpoint CAS owner-only hardening (F50)', () => {
  it('hardens the blob before publishing it via hard link', async () => {
    const ref = await makeCas().capture('s1', 0);
    expect(ref, 'capture produces a checkpoint ref').toBeTruthy();
    expect(objectHardeningCount(), 'putBlob issues icacls under objects/').toBeGreaterThan(0);
  });

  it('does not re-harden an already-published identical blob', async () => {
    const cas = makeCas();
    await cas.capture('s1', 0);
    const first = objectHardeningCount();
    await cas.capture('s1', 1);
    expect(objectHardeningCount(), 'dedup path writes nothing new').toBe(first);
  });
});
