import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationJobSpec } from '../src/automation/contracts.js';
import { ingestGitHubEvent, verifyGitHubSignature } from '../src/automation/github.js';
import { createAutomationServer } from '../src/automation/http.js';
import { AutomationService } from '../src/automation/service.js';
import { AutomationStore } from '../src/automation/store.js';
import type { DockerWorkspaceOptions } from '../src/docker-workspace.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-automation-'));
  dirs.push(dir);
  const project = path.join(dir, 'project');
  await mkdir(project);
  const store = new AutomationStore(path.join(dir, 'state'));
  const spec: AutomationJobSpec = {
    name: 'maintenance',
    projectRoot: project,
    image: 'trusted:1',
    prompt: 'Review changes',
    envNames: [],
    enabled: true,
    yolo: false,
    timeoutMs: 60_000,
  };
  return { dir, store, spec };
}
function completed(options: DockerWorkspaceOptions) {
  return {
    id: options.id!,
    ownerToken: options.ownerToken!,
    exitCode: 0,
    snapshotRevision: 'a'.repeat(40),
    patch: 'diff --git a/a b/a\n',
    output: 'done',
    cleanup: 'removed' as const,
  };
}
describe('persistent automation', () => {
  it('persists structured execution metadata without promoting final-text claims to test evidence', async () => {
    const { store, spec } = await fixture();
    const job = await store.add(spec);
    const queued = await store.enqueue(job.id);
    const service = new AutomationService(store, async (options) => ({
      ...completed(options),
      output: JSON.stringify({
        status: 'done',
        finalText: 'Tests passed',
        usage: { input: 123, output: 10, iterations: 2, cost: 0.1, costSource: 'catalog-estimate' },
      }),
      patch: '--- a/a.ts\n+++ b/a.ts\n',
    }));
    await service.tick();
    await service.idle();
    const run = (await store.snapshot()).runs.find((item) => item.id === queued.id)!;
    expect(run.result).toMatchObject({
      finalText: 'Tests passed',
      usage: { inputTokens: 123, costUsd: 0.1 },
      changedFiles: ['a.ts'],
      validation: { status: 'not-verified' },
    });
    expect(
      JSON.parse(await readFile(path.join(run.artifactDirectory!, 'run.json'), 'utf8')).result,
    ).toEqual(run.result);
  });
  it('refuses an idempotency key reused for a different subject or payload', async () => {
    const { store, spec } = await fixture();
    const job = await store.add(spec);
    await store.enqueue(job.id, 'github', 'd', 'repo#1', 'original');
    await expect(store.enqueue(job.id, 'github', 'd', 'repo#2', 'changed')).rejects.toThrow(
      'another payload',
    );
    expect((await store.snapshot()).runs).toHaveLength(1);
  });
  it('prunes terminal metadata while retaining active runs and the latest PR checkpoint', async () => {
    const { store, spec } = await fixture();
    const job = await store.add(spec, 0);
    await store.enqueue(job.id, 'github', 'd1', 'repo#1', '', 1);
    const first = (await store.claim('worker', 2))!;
    await store.finish(first.id, first.leaseId!, { status: 'completed' }, 3);
    await store.enqueue(job.id, 'github', 'd2', 'repo#1', '', 4);
    const second = (await store.claim('worker', 5))!;
    await store.finish(second.id, second.leaseId!, { status: 'completed' }, 6);
    const queued = await store.enqueue(job.id, 'manual', 'd3', 'default', '', 7);
    expect(await store.prune(10)).toBe(1);
    expect((await store.snapshot()).runs.map((run) => run.id)).toEqual([second.id, queued.id]);
  });
  it('preserves jobs and run history across store reconstruction', async () => {
    const { dir, store, spec } = await fixture();
    const job = await store.add(spec);
    const run = await store.enqueue(job.id);
    const reloaded = new AutomationStore(path.join(dir, 'state'));
    expect((await reloaded.snapshot()).runs[0]?.id).toBe(run.id);
    expect((await reloaded.snapshot()).jobs[0]?.prompt).toBe(spec.prompt);
  });
  it('deduplicates concurrent delivery ingestion and job scheduling', async () => {
    const { store, spec } = await fixture();
    const job = await store.add({ ...spec, intervalMs: 60_000 }, 0);
    const deliveries = await Promise.all([
      store.enqueue(job.id, 'github', 'delivery-1', 'repo#1'),
      store.enqueue(job.id, 'github', 'delivery-1', 'repo#1'),
    ]);
    expect(deliveries[0]?.id).toBe(deliveries[1]?.id);
    await Promise.all([store.scheduleDue(180_000), store.scheduleDue(180_000)]);
    const state = await store.snapshot();
    expect(state.runs).toHaveLength(2);
    expect(state.jobs[0]?.nextRunAt).toBe(240_000);
  });
  it('allows only one worker to claim a queued run', async () => {
    const { store, spec } = await fixture();
    const job = await store.add(spec);
    await store.enqueue(job.id);
    const claims = await Promise.all([store.claim('worker-a'), store.claim('worker-b')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it('serializes one subject without blocking another subject', async () => {
    const { store, spec } = await fixture();
    const job = await store.add(spec);
    await store.enqueue(job.id, 'github', 'd1', 'repo#1');
    await store.enqueue(job.id, 'github', 'd2', 'repo#1');
    await store.enqueue(job.id, 'github', 'd3', 'repo#2');
    const first = await store.claim('worker-a');
    const second = await store.claim('worker-b');
    expect(first?.subjectKey).toBe('repo#1');
    expect(second?.subjectKey).toBe('repo#2');
  });
  it('fences stale completion and heartbeat writes', async () => {
    const { store, spec } = await fixture();
    const job = await store.add(spec);
    await store.enqueue(job.id);
    const run = (await store.claim('worker'))!;
    expect(await store.finish(run.id, 'wrong-lease', { status: 'completed' })).toBe(false);
    expect(await store.finish(run.id, run.leaseId!, { status: 'failed', error: 'test' })).toBe(
      true,
    );
    expect(await store.heartbeat(run.id, run.leaseId!)).toBe(false);
    expect(await store.finish(run.id, run.leaseId!, { status: 'completed' })).toBe(false);
  });
  it('skips disabled queued jobs instead of starving enabled jobs', async () => {
    const { store, spec } = await fixture();
    const disabled = await store.add(spec);
    const enabled = await store.add({ ...spec, name: 'other' });
    await store.enqueue(disabled.id);
    await store.enqueue(enabled.id);
    await store.setEnabled(disabled.id, false);
    expect((await store.claim('worker'))?.jobId).toBe(enabled.id);
  });
  it('still runs queued work when a due schedule is refused at run capacity', async () => {
    const { store, spec } = await fixture();
    const manual = await store.add(spec, 0);
    await store.add({ ...spec, name: 'nightly', intervalMs: 60_000 }, 0);
    const queued = await store.enqueue(manual.id, 'manual', 'k-queued', 'default', '', 1);
    const state = JSON.parse(await readFile(store.file, 'utf8'));
    const template = state.runs[0];
    while (state.runs.length < 2000) {
      state.runs.push({
        ...template,
        id: randomUUID(),
        deliveryKey: randomUUID(),
        status: 'completed',
      });
    }
    await writeFile(store.file, JSON.stringify(state));
    const execute = vi.fn(async (options: DockerWorkspaceOptions) => completed(options));
    const service = new AutomationService(store, execute);
    await service.tick(120_000);
    await service.idle();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].id).toBe(queued.id);
    expect(service.lastError).toMatch(/capacity/);
  });
  it('refuses to overwrite malformed persistence', async () => {
    const { store, spec } = await fixture();
    await store.add(spec);
    await writeFile(store.file, '{broken');
    await expect(store.scheduleDue()).rejects.toThrow();
    expect(await readFile(store.file, 'utf8')).toBe('{broken');
  });
  it('records executor failures as failed runs with artifact metadata', async () => {
    const { store, spec } = await fixture();
    const job = await store.add(spec);
    await store.enqueue(job.id);
    const service = new AutomationService(store, async () => {
      throw new Error('fixture failure');
    });
    await service.tick();
    await service.idle();
    const run = (await store.snapshot()).runs[0]!;
    expect(run).toMatchObject({ status: 'failed', error: 'fixture failure' });
    expect(await readFile(path.join(run.artifactDirectory!, 'claim.json'), 'utf8')).toContain(
      run.id,
    );
  });
  it('resolves credentials per run without saving their values in metadata', async () => {
    const { store, spec } = await fixture();
    const ref = {
      profile: 'default',
      provider: 'openai',
      keyLabel: 'work',
      envName: 'OPENAI_API_KEY',
    };
    const job = await store.add({ ...spec, credentials: [ref] });
    const execute = vi.fn(async (options: DockerWorkspaceOptions) => completed(options));
    const resolve = vi.fn(async () => ({
      env: { OPENAI_API_KEY: 'test-secret-value' },
      providers: {},
    }));
    const service = new AutomationService(store, execute, 1, resolve);
    await store.enqueue(job.id);
    await service.tick();
    await service.idle();
    expect(execute.mock.calls[0]?.[0].env).toEqual({ OPENAI_API_KEY: 'test-secret-value' });
    expect(await readFile(store.file, 'utf8')).not.toContain('test-secret-value');
    expect(execute.mock.calls[0]?.[0].args).not.toContain('--yolo');
  });
  it('restores only the same GitHub subject patch and conversation on a subsequent event', async () => {
    const { store, spec } = await fixture();
    const job = await store.add(spec);
    const execute = vi.fn(async (options: DockerWorkspaceOptions) => {
      await mkdir(options.conversationDirectory!, { recursive: true });
      return completed(options);
    });
    const service = new AutomationService(store, execute);
    await store.enqueue(job.id, 'github', 'd1', 'repo#1');
    await service.tick();
    await service.idle();
    await store.enqueue(job.id, 'github', 'd2', 'repo#1');
    await service.tick();
    await service.idle();
    expect(execute.mock.calls[1]?.[0].initialPatch).toContain('diff --git');
    expect(execute.mock.calls[1]?.[0].args).toContain('--continue');
    await store.enqueue(job.id, 'github', 'd3', 'repo#2');
    await service.tick();
    await service.idle();
    expect(execute.mock.calls[2]?.[0].initialPatch).toBeUndefined();
    expect(execute.mock.calls[2]?.[0].args).not.toContain('--continue');
  });
});

describe('GitHub intake', () => {
  it('checks signatures in constant-length comparison and refuses malformed signatures', () => {
    const body = Buffer.from('{"event":1}');
    const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
    expect(verifyGitHubSignature(body, signature, 'secret')).toBe(true);
    expect(verifyGitHubSignature(body, signature, 'different')).toBe(false);
    expect(verifyGitHubSignature(body, 'sha256=abc', 'secret')).toBe(false);
  });
  it('binds repo/subject and deduplicates verified delivery IDs', async () => {
    const { store, spec } = await fixture();
    const job = await store.add({
      ...spec,
      github: {
        repository: 'org/repo',
        events: ['issue_comment.created'],
        secretEnv: 'HOOK_SECRET',
      },
    });
    const body = Buffer.from(
      JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/repo' },
        issue: { number: 12 },
        comment: { body: 'Fix tests' },
      }),
    );
    const headers = {
      signature: `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`,
      delivery: 'delivery-1',
      event: 'issue_comment',
    };
    const a = await ingestGitHubEvent(store, job.id, body, headers, { HOOK_SECRET: 'secret' });
    const b = await ingestGitHubEvent(store, job.id, body, headers, { HOOK_SECRET: 'secret' });
    expect(a?.id).toBe(b?.id);
    const changedHeader = await ingestGitHubEvent(
      store,
      job.id,
      body,
      { ...headers, delivery: 'another-delivery-id' },
      { HOOK_SECRET: 'secret' },
    );
    expect(changedHeader?.id).toBe(a?.id);
    expect(a?.subjectKey).toBe('org/repo#12');
    expect((await store.snapshot()).runs).toHaveLength(1);
    await expect(
      ingestGitHubEvent(store, job.id, body, headers, { HOOK_SECRET: 'wrong' }),
    ).rejects.toThrow('signature');
  });
  it('rejects a signed delivery for a different configured repository', async () => {
    const { store, spec } = await fixture();
    const job = await store.add({
      ...spec,
      github: { repository: 'org/repo', events: ['push'], secretEnv: 'HOOK_SECRET' },
    });
    const body = Buffer.from(JSON.stringify({ repository: { full_name: 'other/repo' } }));
    await expect(
      ingestGitHubEvent(
        store,
        job.id,
        body,
        {
          signature: `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`,
          delivery: 'd',
          event: 'push',
        },
        { HOOK_SECRET: 'secret' },
      ),
    ).rejects.toThrow('repository');
  });
});

describe('automation control API', () => {
  it('requires bearer auth and idempotency for manual dispatch', async () => {
    const { store, spec } = await fixture();
    const job = await store.add(spec);
    const service = new AutomationService(store, async (options) => completed(options));
    const token = 'a'.repeat(64);
    const server = createAutomationServer(service, token);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const url = `http://127.0.0.1:${address.port}`;
      expect((await fetch(`${url}/v1/state`)).status).toBe(401);
      expect(
        (
          await fetch(`${url}/v1/jobs/${job.id}/run`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(400);
      const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'operation-a' };
      const a = await (
        await fetch(`${url}/v1/jobs/${job.id}/run`, { method: 'POST', headers })
      ).json();
      const b = await (
        await fetch(`${url}/v1/jobs/${job.id}/run`, { method: 'POST', headers })
      ).json();
      expect(a).toEqual(b);
      expect((await store.snapshot()).runs).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.stop();
    }
  });
});
