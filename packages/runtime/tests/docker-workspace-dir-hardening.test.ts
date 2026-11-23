import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { type DockerCommandRunner, runDockerWorkspace } from '../src/docker-workspace.js';

/**
 * F63 (WS-045 directory-hardening-on-creation class): runDockerWorkspace
 * creates the project snapshot dir (mkdtemp), the conversation-capture parent
 * (mkdir mode 0o700 — a Windows no-op) and the staged capture dir (mkdtemp)
 * with no owner-only hardening. The snapshot later holds provider API keys and
 * patches; the capture dir receives the container's session state (transcripts,
 * config). On Windows everything created inside inherited whatever the temp
 * tree grants. Hardening each directory AT CREATION (icacls (OI)(CI)
 * inheritance) makes every child — copied or written later — land owner-only.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the three directories; the injectable DockerCommandRunner harness.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ws-f63-'));
  dirs.push(dir);
  await writeFile(path.join(dir, 'original.txt'), 'unchanged');
  let owner = '';
  const runner: DockerCommandRunner = vi.fn(async (args) => {
    if (args[0] === 'create') owner = args[args.indexOf('--label') + 1]!.split('=')[1]!;
    let stdout = '';
    if (args[0] === 'create') stdout = `${'a'.repeat(64)}\n`;
    if (args[0] === 'inspect') stdout = `${'a'.repeat(64)} ${owner}\n`;
    if (args[0] === 'inspect' && args[2] === '{{.Image}}') stdout = `sha256:${'c'.repeat(64)}\n`;
    if (args.at(-1)?.includes('git rev-parse')) stdout = `${'a'.repeat(40)}\n`;
    if (args.at(-1)?.includes('git diff')) stdout = 'diff --git a/original.txt b/original.txt\n';
    if (args.at(-1) === 'write-tree') stdout = `${'b'.repeat(40)}\n`;
    return { code: 0, stdout, stderr: '' };
  });
  return { dir, runner };
}

describe('docker workspace directory-hardening-on-creation (F63)', () => {
  it('hardens the snapshot, capture parent and staged capture directories', async () => {
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
    const { dir, runner } = await fixture();
    const conversationDirectory = path.join(dir, 'conv', 'session');
    const result = await runDockerWorkspace({
      projectRoot: dir,
      image: 'trusted:1',
      command: 'check-pass',
      runner,
      conversationDirectory,
    });
    // Valid-input control: the run still completes.
    expect(result.exitCode).toBe(0);
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0] ?? '');
    expect(
      targets.some((t) => t.includes('wrongstack-docker-')),
      'snapshot dir is hardened',
    ).toBe(true);
    expect(
      targets.some((t) => t === path.join(dir, 'conv')),
      'capture parent is hardened',
    ).toBe(true);
    expect(
      targets.some((t) => t.includes('.wrongstack-conversation-')),
      'staged capture dir is hardened',
    ).toBe(true);
  }, 60_000);
});
