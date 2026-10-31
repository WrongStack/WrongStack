import * as os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const docker = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('../src/docker-workspace.js', async (original) => ({
  ...(await original<typeof import('../src/docker-workspace.js')>()),
  systemDocker: vi.fn(async (args: string[]) => {
    docker.calls.push(args);
    return args[0] === 'inspect'
      ? { code: 0, stdout: `${'a'.repeat(64)} lease-1\n`, stderr: '' }
      : { code: 0, stdout: '', stderr: '' };
  }),
}));

import { AutomationService } from '../src/automation/service.js';

afterEach(() => {
  vi.restoreAllMocks();
  docker.calls.length = 0;
});

/** A run whose worker crashed: lease expired and the recorded process no longer exists. */
async function recover(job: Record<string, unknown>) {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  });
  const run = {
    id: 'run-1',
    status: 'running',
    leaseId: 'lease-1',
    workerId: `${os.hostname()}/424242/worker`,
    leaseExpiresAt: 1,
    job,
  };
  const store = {
    directory: '/fixture',
    snapshot: vi.fn(async () => ({ runs: [run], jobs: [] })),
    finish: vi.fn(async (..._args: unknown[]) => true),
  };
  const service = new AutomationService(store as never);
  await (
    service as unknown as { recoverAbsentWorkers(now: number): Promise<void> }
  ).recoverAbsentWorkers(10_000);
  return store.finish.mock.calls;
}

describe('automation recovery after a worker crash', () => {
  it('removes, never keeps, the container of a run that received a credential', async () => {
    // A real crash left the container stopped and kept, with the provider key readable in its
    // configuration (`docker inspect`) and the encrypted key beside the vault key in its home.
    const finished = await recover({
      credentials: [
        { envName: 'ZHIPU_API_KEY', profile: 'default', provider: 'zai', keyLabel: 'default' },
      ],
      envNames: [],
    });
    expect(docker.calls.find((args) => args[0] !== 'inspect')).toEqual([
      'rm',
      '--force',
      '--volumes',
      'a'.repeat(64),
    ]);
    expect(finished).toEqual([
      [
        'run-1',
        'lease-1',
        {
          status: 'interrupted',
          error: 'Worker process exited. The Docker workspace held a credential and was removed.',
        },
        10_000,
      ],
    ]);
  });
  it('treats a forwarded environment variable as a credential', async () => {
    await recover({ envNames: ['GITHUB_TOKEN'] });
    expect(docker.calls.find((args) => args[0] !== 'inspect')?.[0]).toBe('rm');
  });
  it('still stops and keeps partial work when no credential reached the container', async () => {
    const finished = await recover({ envNames: [] });
    expect(docker.calls.find((args) => args[0] !== 'inspect')).toEqual([
      'stop',
      '--time',
      '2',
      'a'.repeat(64),
    ]);
    expect(finished[0]?.[2]).toMatchObject({
      status: 'interrupted',
      error: expect.stringContaining('retained'),
    });
  });
});
