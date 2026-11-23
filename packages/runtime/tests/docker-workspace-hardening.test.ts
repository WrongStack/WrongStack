import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DockerCommandRunner, runDockerWorkspace } from '../src/docker-workspace.js';

/**
 * F55 (WS-045 class): runDockerWorkspace writes the provider configuration —
 * provider API keys — and the previous-run patch into the snapshot via
 * writeFile + mode 0o600 (a Windows no-op) with no owner-only hardening, before
 * docker cp carries them into the container. On Windows both files stayed
 * readable by other local accounts where inheritance was not owner-only. Each
 * file is hardened right after its write (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the two snapshot files; the existing injectable DockerCommandRunner
 * harness (no real docker needed).
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ws-f55-'));
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

const hardenedEnding = (suffix: string) =>
  icaclsCalls.some((c) => c.file === 'icacls' && c.args[0].endsWith(suffix));

describe('docker workspace credential/patch snapshot owner-only hardening (F55)', () => {
  it('hardens the provider config and previous patch before docker cp', async () => {
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
    const result = await runDockerWorkspace({
      projectRoot: dir,
      image: 'trusted:1',
      command: 'check-pass',
      runner,
      providerConfigs: { openai: { apiKey: 'sk-secret' } },
      initialPatch: '--- a/original.txt\n+++ b/original.txt\n@@ -1 +1 @@\n-unchanged\n+changed\n',
    });
    // Valid-input control: the workspace run still completes.
    expect(result.exitCode).toBe(0);
    expect(hardenedEnding('.wrongstack-provider-config.json'), 'provider config is hardened').toBe(
      true,
    );
    expect(hardenedEnding('.wrongstack-previous.patch'), 'previous patch is hardened').toBe(true);
  }, 60_000);
});
