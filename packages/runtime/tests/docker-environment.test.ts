import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EnvironmentProfile, EnvironmentReceipt } from '@wrongstack/webui-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateJobSpec } from '../src/automation/contracts.js';
import { verifyAutomationPatch } from '../src/automation/verification.js';
import { type DockerCommandRunner, runDockerWorkspace } from '../src/docker-workspace.js';

const roots: string[] = [];
const image = `sha256:${'c'.repeat(64)}`;
const profile = (): EnvironmentProfile => ({
  version: 1,
  name: 'project',
  image: 'trusted:1',
  setupTimeoutMs: 30_000,
  setupCommands: [['setup-test']],
  services: [
    {
      name: 'db',
      image: 'db:1',
      command: [],
      healthCommand: ['health-test'],
      envNames: ['DB_TEST_PASSWORD'],
    },
  ],
  caches: [{ name: 'bun', target: '/home/node/.bun/install/cache' }],
  ports: [{ name: 'preview', port: 3000, protocol: 'http' }],
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-env-test-'));
  roots.push(root);
  await writeFile(path.join(root, 'source.txt'), 'host unchanged');
  const calls: Array<{ args: string[]; env: Readonly<Record<string, string>> | undefined }> = [];
  const owners = new Map<string, string>();
  const volumes = new Map<
    string,
    { Name: string; Driver: string; Labels: Record<string, string>; Options: null }
  >();
  let owner = '';
  const runner: DockerCommandRunner = async (args, options) => {
    calls.push({ args, env: options.env });
    let stdout = '';
    if (args[0] === 'network' && args[1] === 'create') {
      owner = args[args.indexOf('--label') + 1]!.split('=')[1]!;
      stdout = 'd'.repeat(64);
    }
    if (args[0] === 'network' && args[1] === 'inspect') stdout = `${'d'.repeat(64)} ${owner}`;
    if (args[0] === 'volume' && args[1] === 'create') {
      const [key, value] = args[args.indexOf('--label') + 1]!.split('=');
      volumes.set(args.at(-1)!, {
        Name: args.at(-1)!,
        Driver: 'local',
        Labels: { [key!]: value! },
        Options: null,
      });
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const volume = volumes.get(args.at(-1)!)!;
      stdout = args.includes('{{json .}}')
        ? JSON.stringify(volume)
        : volume.Labels['dev.wrongstack.workspace-owner']!;
    }
    if (args[0] === 'create') {
      owner = args[args.indexOf('--label') + 1]!.split('=')[1]!;
      stdout = args.includes('--network-alias') ? 'b'.repeat(64) : 'a'.repeat(64);
      owners.set(stdout, owner);
    }
    if (args[0] === 'inspect')
      stdout = args.includes('{{.Image}}')
        ? image
        : args.includes('{{json .NetworkSettings.Ports}}')
          ? JSON.stringify({ '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '43123' }] })
          : `${args.at(-1)} ${owners.get(args.at(-1)!)}`;
    if (args.at(-1)?.includes('git rev-parse')) stdout = 'e'.repeat(40);
    if (args.at(-1) === 'write-tree') stdout = 'f'.repeat(40);
    if (args.at(-1) === 'setup-test') stdout = 'setup ready';
    return { code: 0, stdout, stderr: '' };
  };
  vi.stubEnv('DB_TEST_PASSWORD', 'service-secret');
  vi.stubEnv('AGENT_TEST_TOKEN', 'agent-secret');
  return { root, calls, runner };
}
describe('workspace environment lifecycle', () => {
  it('cleans owned sidecars after service readiness fails before creating the workspace', async () => {
    const { root, runner, calls } = await fixture();
    const failing: DockerCommandRunner = async (args, opts) => {
      if (args.at(-1) === 'health-test') throw new Error('health command timed out');
      return runner(args, opts);
    };
    await expect(
      runDockerWorkspace({
        projectRoot: root,
        image: 'trusted:1',
        command: 'agent-test',
        environment: profile(),
        runner: failing,
      }),
    ).rejects.toThrow('health command timed out');
    expect(
      calls.some((call) => call.args[0] === 'create' && !call.args.includes('--network-alias')),
    ).toBe(false);
    expect(calls.some((call) => call.args[0] === 'rm' && call.args.at(-1) === 'b'.repeat(64))).toBe(
      true,
    );
    expect(calls.some((call) => call.args[0] === 'network' && call.args[1] === 'rm')).toBe(true);
  });
  it('refuses a cache with a foreign scope label before mounting it', async () => {
    const { root, runner, calls } = await fixture();
    const foreign: DockerCommandRunner = async (args, opts) =>
      args[0] === 'volume' && args[1] === 'inspect' && args.includes('{{json .}}')
        ? {
            code: 0,
            stdout: JSON.stringify({
              Name: args.at(-1),
              Driver: 'local',
              Options: null,
              Labels: { 'dev.wrongstack.cache-scope': 'foreign' },
            }),
            stderr: '',
          }
        : runner(args, opts);
    await expect(
      runDockerWorkspace({
        projectRoot: root,
        image: 'trusted:1',
        command: 'agent-test',
        environment: profile(),
        runner: foreign,
      }),
    ).rejects.toThrow('ownership');
    expect(calls.some((call) => call.args[0] === 'create')).toBe(false);
    expect(calls.some((call) => call.args[0] === 'volume' && call.args[1] === 'rm')).toBe(false);
  });
  it('refuses published ports that Docker reports on a non-loopback address', async () => {
    const { root, runner } = await fixture();
    const exposed: DockerCommandRunner = async (args, opts) =>
      args.includes('{{json .NetworkSettings.Ports}}')
        ? {
            code: 0,
            stdout: JSON.stringify({ '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '43123' }] }),
            stderr: '',
          }
        : runner(args, opts);
    const result = await runDockerWorkspace({
      projectRoot: root,
      image: 'trusted:1',
      command: 'agent-test',
      environment: profile(),
      runner: exposed,
    });
    expect(result).toMatchObject({
      exitCode: 1,
      patch: null,
      cleanup: 'retained',
      failure: 'Preview port binding cannot be verified',
    });
  });
  it('sets up owned services and caches, records loopback ports and preserves host files', async () => {
    const { root, runner, calls } = await fixture();
    const updates: EnvironmentReceipt[] = [];
    const result = await runDockerWorkspace({
      projectRoot: root,
      image: 'trusted:1',
      command: 'agent-test',
      envNames: ['AGENT_TEST_TOKEN'],
      environment: profile(),
      captureTreeIdentity: true,
      runner,
      onEnvironmentUpdate: async (value) => {
        updates.push(value);
      },
    });
    expect(result).toMatchObject({
      cleanup: 'removed',
      environment: {
        status: 'removed',
        imageId: image,
        setup: [{ exitCode: 0, output: 'setup ready' }],
        ports: [{ hostPort: 43123 }],
        caches: [{ persistent: true }],
      },
    });
    expect(updates.map((value) => value.status)).toEqual(['preparing', 'ready', 'removed']);
    const service = calls.find(
      (call) => call.args[0] === 'create' && call.args.includes('--network-alias'),
    )!;
    expect(service.env).toEqual({ DB_TEST_PASSWORD: 'service-secret' });
    expect(service.args).not.toContain('service-secret');
    expect(service.args).not.toContain('AGENT_TEST_TOKEN');
    const main = calls.find(
      (call) => call.args[0] === 'create' && !call.args.includes('--network-alias'),
    )!;
    expect(main.args).toContain('127.0.0.1::3000/tcp');
    expect(main.args.join(' ')).not.toContain('type=bind');
    expect(calls.findIndex((call) => call.args.at(-1) === 'setup-test')).toBeLessThan(
      calls.findIndex((call) => call.args.at(-1) === 'agent-test'),
    );
    expect(calls.some((call) => call.args[0] === 'network' && call.args[1] === 'rm')).toBe(true);
    expect(calls.some((call) => call.args[0] === 'volume' && call.args[1] === 'rm')).toBe(false);
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('host unchanged');
  });
  it('prevents agent execution after setup failure and retains partial workspace for recovery', async () => {
    const { root, calls, runner } = await fixture();
    const failing: DockerCommandRunner = async (args, opts) =>
      args.at(-1) === 'setup-test'
        ? { code: 7, stdout: 'dependency failed', stderr: '' }
        : runner(args, opts);
    const result = await runDockerWorkspace({
      projectRoot: root,
      image: 'trusted:1',
      command: 'agent-test',
      environment: profile(),
      runner: failing,
    });
    expect(result).toMatchObject({
      exitCode: 1,
      patch: null,
      cleanup: 'retained',
      environment: { status: 'retained', setup: [{ exitCode: 7 }] },
    });
    expect(calls.some((call) => call.args.includes('agent-test'))).toBe(false);
    expect(
      calls.some((call) => call.args[0] === 'stop' && call.args.at(-1) === 'a'.repeat(64)),
    ).toBe(true);
    // The service received DB_TEST_PASSWORD, which its configuration keeps: it is removed,
    // not kept beside the workspace.
    expect(calls.some((call) => call.args[0] === 'rm' && call.args.at(-1) === 'b'.repeat(64))).toBe(
      true,
    );
    expect(
      calls.some((call) => call.args[0] === 'stop' && call.args.at(-1) === 'b'.repeat(64)),
    ).toBe(false);
  });
  it('refuses cleanup of a service replaced by another owner', async () => {
    const { root, calls, runner } = await fixture();
    const foreign: DockerCommandRunner = async (args, opts) =>
      args[0] === 'inspect' && args.at(-1) === 'b'.repeat(64) && !args.includes('{{.Image}}')
        ? { code: 0, stdout: `${'b'.repeat(64)} foreign`, stderr: '' }
        : runner(args, opts);
    const result = await runDockerWorkspace({
      projectRoot: root,
      image: 'trusted:1',
      command: 'agent-test',
      environment: profile(),
      runner: foreign,
    });
    expect(result.cleanup).toBe('unverified');
    expect(result.environment?.status).toBe('unverified');
    expect(calls.some((call) => call.args[0] === 'rm' && call.args.at(-1) === 'b'.repeat(64))).toBe(
      false,
    );
  });
  it('reuses scoped candidate caches but verifies with fresh caches and pinned service images', async () => {
    const { root, calls, runner } = await fixture();
    const environment = profile();
    const candidate = await runDockerWorkspace({
      projectRoot: root,
      image: 'trusted:1',
      command: 'agent-test',
      environment,
      captureTreeIdentity: true,
      runner,
    });
    const result = await verifyAutomationPatch(
      {
        projectRoot: root,
        image: 'trusted:1',
        environment,
        verification: { commands: [['check-test']], timeoutMs: 30_000 },
      },
      candidate,
      new AbortController().signal,
      (options) => runDockerWorkspace({ ...options, runner }),
    );
    expect(result.validation.status).toBe('passed');
    const mains = calls.filter(
      (call) => call.args[0] === 'create' && !call.args.includes('--network-alias'),
    );
    expect(mains[0]!.args.join(' ')).toContain('source=wrongstack-cache-');
    expect(mains[1]!.args.join(' ')).toContain('source=wrongstack-check-cache-');
    expect(mains[1]!.args).not.toContain('--publish');
    expect(
      calls.filter((call) => call.args[0] === 'create' && call.args.includes('--network-alias'))[1]!
        .args,
    ).toContain(image);
    expect(calls.some((call) => call.args[0] === 'volume' && call.args[1] === 'rm')).toBe(true);
  });
  it('rejects mismatched images, dangerous service env references and network-none conflicts before Docker', async () => {
    const { root, calls, runner } = await fixture();
    for (const environment of [
      { ...profile(), image: 'other:1' },
      { ...profile(), services: [{ ...profile().services[0]!, envNames: ['DOCKER_HOST'] }] },
    ]) {
      await expect(
        runDockerWorkspace({
          projectRoot: root,
          image: 'trusted:1',
          command: 'agent-test',
          environment,
          runner,
        }),
      ).rejects.toThrow();
      expect(() =>
        validateJobSpec({
          name: 'job',
          projectRoot: root,
          image: 'trusted:1',
          prompt: 'task',
          envNames: [],
          yolo: false,
          enabled: true,
          timeoutMs: 10_000,
          environment,
        }),
      ).toThrow();
    }
    await expect(
      runDockerWorkspace({
        projectRoot: root,
        image: 'trusted:1',
        command: 'agent-test',
        environment: profile(),
        network: 'none',
        runner,
      }),
    ).rejects.toThrow('networking');
    expect(calls).toHaveLength(0);
  });
});
