import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubcommandDeps } from '../../src/subcommands/contracts.js';
import { automationCmd } from '../../src/subcommands/handlers/automation.js';
import { runSandboxCommand } from '../../src/subcommands/handlers/sandbox.js';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) {
    if (
      path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) ||
      !/^wrongstack-(?:preview|sandbox-preview)-/.test(path.basename(dir))
    )
      throw new Error('Refusing cleanup outside the owned fixture');
    await rm(dir, { recursive: true, force: true });
  }
});
describe('headless dry run commands', () => {
  it('inspects PR state locally and refuses a run owned by another project', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-preview-'));
    directories.push(dir);
    const { AutomationStore } = await import('@wrongstack/runtime');
    const store = new AutomationStore(path.join(dir, 'state'));
    const job = await store.add({
      name: 'review',
      projectRoot: dir,
      image: 'trusted:1',
      prompt: 'Fix',
      envNames: [],
      yolo: false,
      enabled: true,
      timeoutMs: 1000,
    });
    const run = await store.enqueue(job.id);
    const write = vi.fn();
    const deps = {
      renderer: { write },
      projectRoot: dir,
      flags: { 'data-dir': store.directory },
    } as unknown as SubcommandDeps;
    expect(await automationCmd(['pr-view', run.id], deps)).toBe(0);
    expect(JSON.parse(write.mock.calls[0]![0])).toEqual({ plan: null, receipt: null, ci: null });
    expect(await automationCmd(['pr-prepare', run.id], deps)).toBe(1);
    expect(await automationCmd(['pr-follow-up', run.id], deps)).toBe(1);
    deps.projectRoot = path.join(dir, 'another-project');
    expect(await automationCmd(['pr-view', run.id], deps)).toBe(1);
    expect(write.mock.calls.flat().join('')).toContain('not found in this project');
  });
  it('publishes with the fingerprint given as `--plan <fingerprint>`', async () => {
    // `--plan` is also a global boolean switch (modeldiag), so the parser leaves the
    // fingerprint as a positional; the documented form must still reach the publish check.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-preview-'));
    directories.push(dir);
    const runtime = await import('@wrongstack/runtime');
    const store = new runtime.AutomationStore(path.join(dir, 'state'));
    const job = await store.add({
      name: 'review',
      projectRoot: dir,
      image: 'trusted:1',
      prompt: 'Fix',
      envNames: [],
      yolo: false,
      enabled: true,
      timeoutMs: 1000,
    });
    const run = await store.enqueue(job.id);
    const fingerprint = 'f'.repeat(64);
    const publish = vi
      .spyOn(runtime.AutomationPullRequests.prototype, 'publish')
      .mockResolvedValue({ plan: null, receipt: null, ci: null });
    try {
      const { parseArgs } = await import('../../src/arg-parser.js');
      const parsed = parseArgs([
        'automation',
        'pr-publish',
        run.id,
        '--plan',
        fingerprint,
        '--data-dir',
        store.directory,
      ]);
      const deps = {
        renderer: { write: vi.fn() },
        projectRoot: dir,
        flags: parsed.flags,
      } as unknown as SubcommandDeps;
      expect(await automationCmd(parsed.positional.slice(1), deps)).toBe(0);
      expect(publish).toHaveBeenCalledWith(run.id, fingerprint);
    } finally {
      publish.mockRestore();
    }
  });
  it.runIf(process.platform === 'win32')(
    'finds the run when the shell spells the same project root in another case',
    async () => {
      // The store records the real path; a shell cwd of `d:\...` vs `D:\...` (or any differently
      // cased segment) is the same project and must not hide its runs.
      const dir = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-preview-'));
      directories.push(dir);
      const { AutomationStore } = await import('@wrongstack/runtime');
      const store = new AutomationStore(path.join(dir, 'state'));
      const job = await store.add({
        name: 'review',
        projectRoot: dir,
        image: 'trusted:1',
        prompt: 'Fix',
        envNames: [],
        yolo: false,
        enabled: true,
        timeoutMs: 1000,
      });
      const run = await store.enqueue(job.id);
      const write = vi.fn();
      const deps = {
        renderer: { write },
        projectRoot: dir.toUpperCase(),
        flags: { 'data-dir': store.directory },
      } as unknown as SubcommandDeps;
      expect(await automationCmd(['pr-view', run.id], deps)).toBe(0);
      expect(write.mock.calls.flat().join('')).not.toContain('not found in this project');
    },
  );
  it.each([true, ''])(
    'refuses --verify=%j instead of silently creating an unverified job',
    async (verify) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-preview-'));
      directories.push(dir);
      const write = vi.fn();
      const deps = {
        renderer: { write },
        projectRoot: dir,
        flags: { verify, 'data-dir': path.join(dir, 'state') },
      } as unknown as SubcommandDeps;
      expect(await automationCmd(['add'], deps)).toBe(1);
      expect(write.mock.calls.flat().join('')).toContain('--verify requires');
      await expect(readFile(path.join(dir, 'state', 'jobs.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );
  it('previews an existing encrypted profile reference without decrypting or persisting a job', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-preview-'));
    directories.push(dir);
    const profile = path.join(dir, 'profile.json');
    await writeFile(
      profile,
      JSON.stringify({
        providers: {
          team: {
            type: 'openai',
            apiKeys: [{ label: 'work', apiKey: 'encrypted-fixture-private-value' }],
          },
        },
      }),
    );
    const write = vi.fn();
    const decrypt = vi.fn();
    const deps = {
      renderer: { write },
      projectRoot: dir,
      paths: { profileName: 'default', profileConfig: () => profile },
      vault: { decrypt },
      flags: {
        name: 'fixture',
        image: 'trusted:1',
        prompt: 'Review',
        credential: 'OPENAI_API_KEY=team/work',
        'data-dir': path.join(dir, 'state'),
        cron: '0 9 * * 1-5',
        timezone: 'Europe/Istanbul',
        verify: 'bun install --frozen-lockfile\nbun run test',
        'verify-timeout': '120',
      },
    } as unknown as SubcommandDeps;
    expect(await automationCmd(['preview'], deps)).toBe(0);
    const output = write.mock.calls.map(([text]) => text).join('');
    expect(output).toContain('read-at-use');
    expect(output).toContain('nextRunTimes');
    expect(JSON.parse(output).verification).toEqual({
      commands: [
        ['bun', 'install', '--frozen-lockfile'],
        ['bun', 'run', 'test'],
      ],
      timeoutMs: 120_000,
    });
    expect(output).not.toContain('encrypted-fixture-private-value');
    expect(decrypt).not.toHaveBeenCalled();
    await expect(readFile(path.join(dir, 'state', 'jobs.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('previews a sandbox without exporting a patch or creating an output directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-sandbox-preview-'));
    directories.push(dir);
    const write = vi.fn();
    expect(
      await runSandboxCommand(
        ['docker'],
        { image: 'trusted:1', prompt: 'Review', out: path.join(dir, 'out'), 'dry-run': true },
        { write } as never,
      ),
    ).toBe(0);
    expect(write.mock.calls.map(([text]) => text).join('')).toContain('--max-iterations');
    await expect(readFile(path.join(dir, 'out', 'run.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

import { exportEnvironmentProfile } from '@wrongstack/webui-protocol';

describe('environment profile CLI', () => {
  it('loads a reusable profile without starting Docker or persisting preview state', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-preview-'));
    directories.push(dir);
    const file = path.join(dir, 'environment.json');
    const environment = {
      version: 1 as const,
      name: 'team',
      image: 'trusted:1',
      setupCommands: [['bun', 'install']],
      setupTimeoutMs: 30_000,
      services: [
        {
          name: 'db',
          image: 'db:1',
          command: [],
          healthCommand: ['check-db'],
          envNames: ['WRONGSTACK_MISSING_ENV_PROFILE_TEST'],
        },
      ],
      caches: [],
      ports: [],
    };
    await writeFile(file, exportEnvironmentProfile(environment));
    const write = vi.fn();
    const deps = {
      renderer: { write },
      cwd: dir,
      projectRoot: dir,
      flags: {
        name: 'profile job',
        prompt: 'Review',
        'environment-file': file,
        'data-dir': path.join(dir, 'state'),
      },
    } as unknown as SubcommandDeps;
    expect(await automationCmd(['preview'], deps)).toBe(0);
    const result = JSON.parse(write.mock.calls[0]![0]);
    expect(result.environment).toEqual(environment);
    expect(result.image).toBe('trusted:1');
    expect(result.missingReferences).toContain('WRONGSTACK_MISSING_ENV_PROFILE_TEST');
    await expect(readFile(path.join(dir, 'state', 'jobs.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    deps.flags = { ...deps.flags, image: 'other:1' };
    expect(await automationCmd(['add'], deps)).toBe(1);
    expect(write.mock.calls.flat().join('')).toContain('must match');
  });
  it('prints a valid environment template and rejects a valueless profile flag', async () => {
    const write = vi.fn();
    const deps = {
      renderer: { write },
      flags: { image: 'trusted:1' },
    } as unknown as SubcommandDeps;
    expect(await automationCmd(['environment-template'], deps)).toBe(0);
    expect(JSON.parse(write.mock.calls[0]![0])).toMatchObject({
      type: 'wrongstack.environment',
      version: 1,
      profile: { image: 'trusted:1' },
    });
    deps.flags = { 'environment-file': true };
    expect(await automationCmd(['preview'], deps)).toBe(1);
    expect(write.mock.calls.flat().join('')).toContain('--environment-file requires a file');
  });
});
