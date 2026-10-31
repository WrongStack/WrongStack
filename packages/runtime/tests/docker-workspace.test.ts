import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DockerCommandRunner, runDockerWorkspace } from '../src/docker-workspace.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'docker-workspace-test-'));
  dirs.push(dir);
  await writeFile(path.join(dir, 'original.txt'), 'unchanged');
  let owner = '';
  const calls: string[][] = [];
  const runner: DockerCommandRunner = vi.fn(async (args) => {
    calls.push(args);
    if (args[0] === 'create') owner = args[args.indexOf('--label') + 1]!.split('=')[1]!;
    let stdout = '';
    if (args[0] === 'create') stdout = `${'a'.repeat(64)}\n`;
    if (args[0] === 'inspect') stdout = `${'a'.repeat(64)} ${owner}\n`;
    if (args[0] === 'inspect' && args[2] === '{{.Image}}') stdout = `sha256:${'c'.repeat(64)}\n`;
    if (args.at(-1)?.includes('git rev-parse')) stdout = `${'a'.repeat(40)}\n`;
    if (args.at(-1)?.includes('git diff')) stdout = 'diff --git a/original.txt b/original.txt\n';
    return { code: 0, stdout, stderr: '' };
  });
  return { dir, runner, calls };
}
describe('Docker workspace ownership', () => {
  it('hashes the full collected command output before clipping its metadata preview', async () => {
    const { dir, runner } = await fixture();
    const output = 'x'.repeat(65_000);
    const wrapped: DockerCommandRunner = async (args, opts) => {
      if (args.at(-1) === 'write-tree')
        return { code: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' };
      if (args.at(-1) === 'large-output') return { code: 0, stdout: output, stderr: '' };
      return runner(args, opts);
    };
    const result = await runDockerWorkspace({
      projectRoot: dir,
      image: 'trusted:1',
      command: 'large-output',
      captureTreeIdentity: true,
      runner: wrapped,
    });
    expect(result.stepResults?.[0]).toMatchObject({
      outputTruncated: true,
      outputSha256: createHash('sha256').update(output).digest('hex'),
    });
    expect(result.stepResults?.[0]?.output.length).toBe(64_000);
  });
  it('captures source and candidate identities and stops a verification sequence on failure', async () => {
    const { dir, runner, calls } = await fixture();
    const wrapped: DockerCommandRunner = async (args, opts) => {
      if (args.at(-1) === 'write-tree')
        return { code: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' };
      if (args.includes('check-fail')) return { code: 2, stdout: 'failed check', stderr: '' };
      return runner(args, opts);
    };
    const result = await runDockerWorkspace({
      projectRoot: dir,
      image: 'trusted:1',
      command: 'check-pass',
      followupCommands: [['check-fail'], ['must-not-run']],
      captureTreeIdentity: true,
      runner: wrapped,
    });
    expect(result).toMatchObject({
      exitCode: 2,
      sourceTree: 'b'.repeat(40),
      inputTree: 'b'.repeat(40),
      outputTree: 'b'.repeat(40),
    });
    expect(result.stepResults?.map((step) => step.exitCode)).toEqual([0, 2]);
    expect(calls.some((args) => args.includes('must-not-run'))).toBe(false);
  });
  it('uses immutable Docker IDs for execution and removal', async () => {
    const { dir, runner, calls } = await fixture();
    await runDockerWorkspace({ projectRoot: dir, image: 'trusted:1', command: 'wstack', runner });
    expect(calls.find((a) => a[0] === 'start')?.[1]).toBe('a'.repeat(64));
    expect(calls.find((a) => a[0] === 'rm')?.at(-1)).toBe('a'.repeat(64));
  });
  it('stops and retains partial work after an interrupted agent command', async () => {
    const { dir, runner, calls } = await fixture();
    const wrapped: DockerCommandRunner = async (args, opts) => {
      if (args[0] === 'exec' && args.includes('wstack')) throw new Error('command timed out');
      return runner(args, opts);
    };
    const result = await runDockerWorkspace({
      projectRoot: dir,
      image: 'trusted:1',
      command: 'wstack',
      runner: wrapped,
    });
    expect(result).toMatchObject({
      patch: null,
      cleanup: 'retained',
      failure: 'command timed out',
    });
    expect(calls.some((a) => a[0] === 'stop')).toBe(true);
    expect(calls.some((a) => a[0] === 'rm')).toBe(false);
  });
  it('does not remove a prior generation after a stable run name collision', async () => {
    const { dir, runner, calls } = await fixture();
    const wrapped: DockerCommandRunner = async (args, opts) => {
      if (args[0] === 'create') return { code: 1, stdout: '', stderr: 'name already exists' };
      if (args[0] === 'inspect')
        return { code: 0, stdout: `${'b'.repeat(64)} foreign-generation`, stderr: '' };
      return runner(args, opts);
    };
    await expect(
      runDockerWorkspace({
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        projectRoot: dir,
        image: 'trusted:1',
        command: 'wstack',
        runner: wrapped,
      }),
    ).rejects.toThrow('name already exists');
    expect(calls.some((a) => a[0] === 'rm' || a[0] === 'stop')).toBe(false);
  });
  it('runs argv in a copied workspace, forwards only named env and returns a snapshot patch', async () => {
    const { dir, runner, calls } = await fixture();
    const result = await runDockerWorkspace({
      projectRoot: dir,
      image: 'trusted:1',
      command: 'wstack',
      args: ['--prompt', 'literal $(danger); text'],
      envNames: ['OPENAI_API_KEY'],
      network: 'none',
      runner,
    });
    const create = calls.find((a) => a[0] === 'create')!;
    expect(create).not.toContain('--mount');
    expect(create).not.toContain('--privileged');
    expect(create).toContain('OPENAI_API_KEY');
    expect(create).toContain('none');
    expect(calls.some((a) => a.includes('literal $(danger); text'))).toBe(true);
    expect(result).toMatchObject({
      exitCode: 0,
      cleanup: 'removed',
      snapshotRevision: 'a'.repeat(40),
    });
    expect(result.patch).toContain('diff --git');
    expect(await readFile(path.join(dir, 'original.txt'), 'utf8')).toBe('unchanged');
  });
  it('injects profile credentials as the workspace user, never re-owning that 0700 home as root', async () => {
    // Real Docker: the container drops every capability but CHOWN, so root cannot read the
    // 0700 credential home that the workspace user (1000) creates. A root `chown -R` there
    // fails with "Permission denied", which stopped every --credential job before it ran.
    const { dir, runner, calls } = await fixture();
    let homeOwnedBy1000 = false;
    const wrapped: DockerCommandRunner = async (args, opts) => {
      const asRoot = args[0] === 'exec' && args[1] === '--user' && args[2] === '0:0';
      if (args[0] === 'exec' && !asRoot && args.includes('node')) homeOwnedBy1000 = true;
      if (asRoot && homeOwnedBy1000 && args.includes('chown') && args.includes('-R'))
        return {
          code: 1,
          stdout: '',
          stderr: "chown: cannot read directory '/home/node/.wrongstack': Permission denied",
        };
      return runner(args, opts);
    };
    const result = await runDockerWorkspace({
      projectRoot: dir,
      image: 'trusted:1',
      command: 'wstack',
      providerConfigs: { 'zai-coding-plan': { type: 'zai-coding-plan', apiKey: 'test-key' } },
      runner: wrapped,
    });
    expect(result.exitCode).toBe(0);
    const inject = calls.find((a) => a[0] === 'exec' && a.includes('node'))!;
    expect(inject.slice(0, 3)).not.toEqual(['exec', '--user', '0:0']);
    // The key travels through a container file, never the command line.
    expect(calls.some((a) => a.join(' ').includes('test-key'))).toBe(false);
  });
  it('records the snapshot without executable bits a Windows host never had', async () => {
    // `docker cp` from NTFS marks every file 0755. Recorded as 100755, the source tree never
    // matched the host's committed tree, so no run from a Windows host could prepare a PR.
    // A POSIX host keeps real executable bits, so only a Windows host turns modes off.
    const { dir, runner, calls } = await fixture();
    await runDockerWorkspace({ projectRoot: dir, image: 'trusted:1', command: 'wstack', runner });
    const setup = calls.map((a) => a.at(-1) ?? '').find((cmd) => cmd.startsWith('git init'))!;
    if (process.platform === 'win32') {
      expect(setup).toContain('git config core.fileMode false');
      expect(setup.indexOf('core.fileMode false')).toBeLessThan(setup.indexOf('git add -A'));
    } else {
      expect(setup).not.toContain('core.fileMode');
    }
  });
  it('forwards only explicitly selected host environment values to Docker', async () => {
    vi.stubEnv('BUGHUNT_SELECTED_TOKEN', 'selected-value');
    vi.stubEnv('BUGHUNT_UNSELECTED_TOKEN', 'must-not-leak');
    const { dir, runner } = await fixture();
    let createEnv: Readonly<Record<string, string>> | undefined;
    const wrapped: DockerCommandRunner = async (args, opts) => {
      if (args[0] === 'create') createEnv = opts.env;
      return runner(args, opts);
    };

    await runDockerWorkspace({
      projectRoot: dir,
      image: 'trusted:1',
      command: 'wstack',
      envNames: ['BUGHUNT_SELECTED_TOKEN'],
      runner: wrapped,
    });

    expect(createEnv?.BUGHUNT_SELECTED_TOKEN).toBe('selected-value');
    expect(createEnv?.BUGHUNT_UNSELECTED_TOKEN).toBeUndefined();
  });
  it('does not remove a container whose ownership probe fails', async () => {
    const { dir, runner, calls } = await fixture();
    const wrapped: DockerCommandRunner = async (args, opts) =>
      args[0] === 'inspect' ? { code: 1, stdout: '', stderr: 'unreachable' } : runner(args, opts);
    const result = await runDockerWorkspace({
      projectRoot: dir,
      image: 'trusted:1',
      command: 'wstack',
      runner: wrapped,
    });
    expect(result.cleanup).toBe('unverified');
    expect(calls.some((a) => a[0] === 'rm')).toBe(false);
  });
  it('does not remove a replacement container with another owner label', async () => {
    const { dir, runner, calls } = await fixture();
    const wrapped: DockerCommandRunner = async (args, opts) =>
      args[0] === 'inspect' ? { code: 0, stdout: 'another-owner', stderr: '' } : runner(args, opts);
    await runDockerWorkspace({
      projectRoot: dir,
      image: 'trusted:1',
      command: 'wstack',
      runner: wrapped,
    });
    expect(calls.some((a) => a[0] === 'rm')).toBe(false);
  });
  it('cleans only the proven owner after a provisioning error', async () => {
    const { dir, runner, calls } = await fixture();
    const wrapped: DockerCommandRunner = async (args, opts) =>
      args[0] === 'cp' ? { code: 1, stdout: '', stderr: 'copy failed' } : runner(args, opts);
    await expect(
      runDockerWorkspace({
        projectRoot: dir,
        image: 'trusted:1',
        command: 'wstack',
        runner: wrapped,
      }),
    ).rejects.toThrow('copy failed');
    expect(calls.filter((a) => a[0] === 'rm')).toHaveLength(1);
  });
  it.each(['HOME', 'NODE_OPTIONS', 'DOCKER_HOST', 'WRONGSTACK_HOME', 'x=y'])(
    'refuses ambient authority through %s',
    async (env) => {
      const { dir, runner, calls } = await fixture();
      await expect(
        runDockerWorkspace({
          projectRoot: dir,
          image: 'trusted:1',
          command: 'wstack',
          envNames: [env],
          runner,
        }),
      ).rejects.toThrow('cannot be forwarded');
      expect(calls).toHaveLength(0);
    },
  );
  it('keeps the conversation checkpoint but not the injected profile credential', async () => {
    // The container's home holds the injected provider key (encrypted) next to the vault key
    // that decrypts it. A continuation re-injects credentials, so the checkpoint must not keep
    // a decryptable copy of the profile key on the host.
    const { dir, runner } = await fixture();
    const conversationDir = path.join(dir, 'conversations', 'subject-1');
    const { mkdir, readdir } = await import('node:fs/promises');
    const wrapped: DockerCommandRunner = async (args, opts) => {
      if (args[0] === 'cp' && String(args[1]).includes(':/home/node/.wrongstack/.')) {
        const home = args[2]!;
        await mkdir(path.join(home, 'profiles', 'default'), { recursive: true });
        await mkdir(path.join(home, 'config-history'), { recursive: true });
        await mkdir(path.join(home, 'projects', 'p'), { recursive: true });
        await writeFile(path.join(home, '.key'), 'vault-key');
        await writeFile(path.join(home, 'profiles', 'default', 'config.json'), '{"k":"enc:x"}');
        await writeFile(path.join(home, 'profiles', 'default', 'statusline.json'), '{}');
        await writeFile(path.join(home, 'config-history', 'profiles-default.json'), '{}');
        await writeFile(path.join(home, 'projects', 'p', 'session.jsonl'), '{"turn":1}\n');
        return { code: 0, stdout: '', stderr: '' };
      }
      return runner(args, opts);
    };
    const result = await runDockerWorkspace({
      projectRoot: dir,
      image: 'trusted:1',
      command: 'wstack',
      providerConfigs: { 'zai-coding-plan': { type: 'zai-coding-plan', apiKey: 'test-key' } },
      conversationDirectory: conversationDir,
      runner: wrapped,
    });
    expect(result.exitCode).toBe(0);
    expect(
      await readFile(path.join(conversationDir, 'projects', 'p', 'session.jsonl'), 'utf8'),
    ).toBe('{"turn":1}\n');
    expect((await readdir(conversationDir)).sort()).toEqual(['profiles', 'projects']);
    expect(await readdir(path.join(conversationDir, 'profiles', 'default'))).toEqual([
      'statusline.json',
    ]);
  });
  it('atomically replaces an existing non-empty conversationDirectory on subsequent runs', async () => {
    const { dir, runner } = await fixture();
    const conversationDir = path.join(dir, 'conversations', 'pr-42');
    await rm(conversationDir, { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(conversationDir, { recursive: true });
    await writeFile(path.join(conversationDir, 'checkpoint.json'), '{"turn":1}');

    const wrapped: DockerCommandRunner = async (args, opts) => {
      if (args[0] === 'cp' && String(args[1]).includes(':/home/node/.wrongstack/.')) {
        await writeFile(path.join(args[2]!, 'checkpoint.json'), '{"turn":2}');
        return { code: 0, stdout: '', stderr: '' };
      }
      return runner(args, opts);
    };

    const result = await runDockerWorkspace({
      projectRoot: dir,
      image: 'trusted:1',
      command: 'wstack',
      conversationDirectory: conversationDir,
      runner: wrapped,
    });
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(conversationDir, 'checkpoint.json'), 'utf8')).toBe(
      '{"turn":2}',
    );
  });
});
