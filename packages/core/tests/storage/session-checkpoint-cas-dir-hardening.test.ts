import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { SessionCheckpointCas } from '../../src/storage/session-checkpoint-cas.js';
import type { VcsRunResult } from '../../src/vcs/vcs-runner.js';

/**
 * F66 (WS-045 directory-hardening-on-creation class): putBlob creates the CAS
 * objects shard directory (objects/<hash-prefix>) via fsp.mkdir with no mode
 * and no owner-only hardening. The blobs are verbatim workspace content. On
 * Windows every object created inside inherits whatever the CAS root grants.
 * Hardening the shard directory AT CREATION (icacls (OI)(CI) inheritance)
 * covers every blob — including ones published by paths we do not control.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the shard directory; the injected-VCS-runner harness.
 */
const HEAD = 'a'.repeat(40);
const CONTENT = 'checkpoint version';
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let tmp: string;
let project: string;
let casRoot: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ws-f66-'));
  project = path.join(tmp, 'project');
  casRoot = path.join(tmp, 'cas');
  await fsp.mkdir(path.join(project, 'src'), { recursive: true });
  await fsp.mkdir(path.join(project, '.git'), { recursive: true });
  await fsp.writeFile(path.join(project, 'src', 'a.ts'), CONTENT, 'utf8');
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
      runner: (_binary: string, args: readonly string[]) => runGit([...args]),
    },
  });
}

describe('CAS objects directory-hardening-on-creation (F66)', () => {
  it('hardens the objects shard directory when it is created', async () => {
    await makeCas().capture('s1', 0);
    const hash = createHash('sha256').update(CONTENT).digest('hex');
    const shardDir = path.join(casRoot, 'objects', hash.slice(0, 2));
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'objects shard dir is hardened').toContain(shardDir);
  });
});
