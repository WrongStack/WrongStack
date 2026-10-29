import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AutomationJob,
  type AutomationJobSpec,
  type AutomationState,
  validateJobSpec,
} from '../src/automation/contracts.js';
import { ingestGitHubEvent } from '../src/automation/github.js';
import { evaluateGitHubFilters } from '../src/automation/github-filters.js';
import { createAutomationServer } from '../src/automation/http.js';
import { createHeadlessLaunchPlan } from '../src/automation/launch-plan.js';
import {
  automationWorkerRequest,
  handleAutomationManagement,
  readAutomationArtifact,
} from '../src/automation/management.js';
import { previewSchedule, validateCronSchedule } from '../src/automation/schedule.js';
import { AutomationService } from '../src/automation/service.js';
import { AutomationStore } from '../src/automation/store.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) {
    if (
      path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) ||
      !path.basename(dir).startsWith('wrongstack-automation-management-')
    )
      throw new Error('Refusing cleanup outside the owned fixture');
    await rm(dir, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-automation-management-'));
  dirs.push(directory);
  await mkdir(path.join(directory, 'project'));
  const root = await realpath(path.join(directory, 'project'));
  const store = new AutomationStore(path.join(directory, 'automation'));
  const spec: AutomationJobSpec = {
    name: 'review',
    projectRoot: root,
    image: 'trusted:1',
    prompt: 'Review changes',
    envNames: [],
    yolo: false,
    enabled: true,
    timeoutMs: 60000,
  };
  return { directory, store, spec };
}
async function api(store: AutomationStore, projectRoot: string) {
  const server = createServer((req, res) => {
    void handleAutomationManagement(
      req,
      res,
      new URL(req.url!, 'http://localhost'),
      store,
      (id) => store.cancel(id),
      projectRoot,
    ).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return (route: string, method = 'GET', body?: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/v1/${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'fixture' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
}

describe('calendar schedules', () => {
  it('imports a project-bound disabled definition and exports references without machine identity', async () => {
    const { store, spec } = await fixture();
    const request = await api(store, spec.projectRoot);
    const { projectRoot: _root, ...portable } = spec;
    const response = await request('import', 'POST', {
      document: {
        type: 'wrongstack.automation',
        version: 1,
        spec: {
          ...portable,
          enabled: true,
          yolo: true,
          template: { id: 'test-triage', version: 1 },
        },
      },
      projectRoot: 'other-project',
    });
    expect(response.status).toBe(201);
    const job = (await response.json()) as AutomationJob;
    expect(job).toMatchObject({ enabled: false, yolo: false, projectRoot: spec.projectRoot });
    const exported = (await (await request(`jobs/${job.id}/export`)).json()) as {
      spec: Record<string, unknown>;
    };
    expect(exported.spec.projectRoot).toBeUndefined();
    expect(exported.spec.id).toBeUndefined();
    const invalid = await request('import', 'POST', {
      document: {
        type: 'wrongstack.automation',
        version: 1,
        spec: {
          ...portable,
          credentials: [
            {
              envName: 'KEY',
              profile: 'work',
              provider: 'openai',
              keyLabel: 'work',
              apiKey: 'raw-secret',
            },
          ],
        },
      },
    });
    expect(invalid.status).toBe(400);
    expect((await store.snapshot()).jobs).toHaveLength(1);
  });
  it('computes weekdays in the selected timezone and preserves legacy intervals', () => {
    const now = Date.parse('2026-10-02T07:00:00Z');
    const times = previewSchedule(
      { schedule: { type: 'cron', expression: '0 9 * * 1-5', timezone: 'Europe/Istanbul' } },
      now,
      2,
    );
    expect(times.map((time) => new Date(time).toISOString())).toEqual([
      '2026-10-05T06:00:00.000Z',
      '2026-10-06T06:00:00.000Z',
    ]);
    expect(previewSchedule({ intervalMs: 60000 }, 0, 2)).toEqual([60000, 120000]);
  });
  it('shifts a missing DST hour and does not double-run a repeated hour', () => {
    const job = {
      schedule: { type: 'cron' as const, expression: '30 2 * * *', timezone: 'Europe/Berlin' },
    };
    expect(
      previewSchedule(job, Date.parse('2026-03-28T03:00:00Z'), 2).map((time) =>
        new Date(time).toISOString(),
      ),
    ).toEqual(['2026-03-29T01:30:00.000Z', '2026-03-30T00:30:00.000Z']);
    expect(
      previewSchedule(job, Date.parse('2026-10-24T03:00:00Z'), 2).map((time) =>
        new Date(time).toISOString(),
      ),
    ).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']);
  });
  it.each(['0 0 31 2 *', '* * * * * *', 'H * * * *', '@daily'])(
    'rejects invalid or nondeterministic schedules %s',
    (expression) => {
      expect(() => validateCronSchedule({ type: 'cron', expression, timezone: 'UTC' })).toThrow();
    },
  );
  it('rejects invalid timezones and competing schedule modes', async () => {
    const { spec } = await fixture();
    expect(() =>
      validateJobSpec({
        ...spec,
        schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'Invalid/Zone' },
      }),
    ).toThrow();
    expect(() =>
      validateJobSpec({
        ...spec,
        intervalMs: 60000,
        schedule: { type: 'cron', expression: '* * * * *', timezone: 'UTC' },
      }),
    ).toThrow();
  });
  it('coalesces missed cron fires and deduplicates concurrent scheduler ticks', async () => {
    const { store, spec } = await fixture();
    const created = Date.parse('2026-10-01T00:00:00Z');
    const now = Date.parse('2026-10-05T10:00:00Z');
    await store.add(
      { ...spec, schedule: { type: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' } },
      created,
    );
    await Promise.all([store.scheduleDue(now), store.scheduleDue(now)]);
    expect((await store.snapshot()).runs).toHaveLength(1);
    expect((await store.snapshot()).jobs[0]!.nextRunAt).toBe(Date.parse('2026-10-06T09:00:00Z'));
  });
});

describe('management revisions and scoped artifacts', () => {
  it('checks worker identity and cancels through the machine-owned authenticated endpoint', async () => {
    const { store, spec } = await fixture();
    const job = await store.add(spec);
    const run = await store.enqueue(job.id);
    const service = new AutomationService(store);
    const server = createAutomationServer(service, 'a'.repeat(64));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await writeFile(path.join(store.directory, 'token.txt'), 'a'.repeat(64));
    const file = path.join(store.directory, 'endpoint.json');
    await writeFile(file, JSON.stringify({ port, workerId: service.workerId }));
    expect(await automationWorkerRequest(store)).toMatchObject({ workerId: service.workerId });
    await automationWorkerRequest(store, `/v1/runs/${run.id}/cancel`, 'POST');
    expect((await store.snapshot()).runs[0]!.status).toBe('cancelled');
    await writeFile(file, JSON.stringify({ port, workerId: 'stale-owner' }));
    await expect(automationWorkerRequest(store)).rejects.toThrow('unavailable');
    await expect(automationWorkerRequest(store, '@example.invalid')).rejects.toThrow('Unsupported');
  });
  it('fences stale edits and keeps queued run definitions frozen', async () => {
    const { store, spec } = await fixture();
    const job = await store.add(spec);
    await store.enqueue(job.id);
    await store.update(job.id, { ...spec, prompt: 'new definition' }, 1);
    await expect(store.update(job.id, spec, 1)).rejects.toThrow('refresh');
    await expect(store.setEnabled(job.id, false, 1)).rejects.toThrow('refresh');
    const state = await store.snapshot();
    expect(state.jobs[0]!.revision).toBe(2);
    expect(state.runs[0]!.job.prompt).toBe(spec.prompt);
  });
  it('deletes a job and its run records at its reviewed revision and refuses active runs', async () => {
    const { store, spec } = await fixture();
    const request = await api(store, spec.projectRoot);
    const job = await store.add(spec);
    const queued = await store.enqueue(job.id);
    // A queued run blocks deletion.
    const blocked = await request(`jobs/${job.id}?expectedRevision=1`, 'DELETE');
    expect(blocked.status).toBe(409);
    await store.cancel(queued.id);
    // A stale revision is refused.
    await store.update(job.id, { ...spec, prompt: 'edited' }, 1);
    expect((await request(`jobs/${job.id}?expectedRevision=1`, 'DELETE')).status).toBe(409);
    expect((await request(`jobs/${job.id}`, 'DELETE')).status).toBe(400);
    const other = await store.add({ ...spec, name: 'other' });
    const kept = await store.enqueue(other.id);
    const removed = await request(`jobs/${job.id}?expectedRevision=2`, 'DELETE');
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true, removedRuns: 1 });
    const state = await store.snapshot();
    expect(state.jobs.map((item) => item.id)).toEqual([other.id]);
    // Only the deleted job's run records go; other jobs keep theirs.
    expect(state.runs.map((run) => run.id)).toEqual([kept.id]);
    expect((await request(`jobs/${job.id}?expectedRevision=3`, 'DELETE')).status).toBe(404);
  });
  it('supports legacy jobs without revisions', async () => {
    const { store, spec } = await fixture();
    await store.add(spec);
    const state = await store.snapshot();
    delete state.jobs[0]!.revision;
    await writeFile(store.file, JSON.stringify(state));
    await store.update(state.jobs[0]!.id, spec, 1);
    expect((await store.snapshot()).jobs[0]!.revision).toBe(2);
  });
  it('does not persist a preview and strips generated fields from editable input', async () => {
    const { store, spec } = await fixture();
    const request = await api(store, spec.projectRoot);
    const response = await request('preview', 'POST', {
      spec: { ...spec, envNames: ['WRONGSTACK_FIXTURE_MISSING_KEY'] },
      event: {},
    });
    expect(response.status).toBe(200);
    const preview = (await response.json()) as { missingReferences: string[] };
    expect(preview.missingReferences).toEqual(['WRONGSTACK_FIXTURE_MISSING_KEY']);
    expect((await store.snapshot()).jobs).toEqual([]);
    expect((await request('jobs', 'POST', { spec: { ...spec, id: 'fake' } })).status).toBe(400);
  });
  it('binds creates to the host project and rejects another project reads and mutations', async () => {
    const { directory, store, spec } = await fixture();
    const request = await api(store, spec.projectRoot);
    await mkdir(path.join(directory, 'other'));
    const otherRoot = await realpath(path.join(directory, 'other'));
    const other = await store.add({ ...spec, name: 'other', projectRoot: otherRoot });
    const otherRun = await store.enqueue(other.id);
    const created = await request('jobs', 'POST', { spec: { ...spec, projectRoot: otherRoot } });
    expect(created.status).toBe(201);
    const createdJob = (await created.json()) as AutomationJob;
    expect(createdJob.projectRoot).toBe(spec.projectRoot);
    const view = (await (await request('state')).json()) as AutomationState;
    expect(view.jobs).toHaveLength(1);
    expect(view.runs).toHaveLength(0);
    expect((await request(`jobs/${other.id}/run`, 'POST')).status).toBe(404);
    expect((await request(`jobs/${other.id}`, 'PUT', { spec, expectedRevision: 1 })).status).toBe(
      404,
    );
    expect((await request(`runs/${otherRun.id}/cancel`, 'POST')).status).toBe(404);
    expect((await request(`runs/${otherRun.id}/artifact?name=output.log`)).status).toBe(404);
  });
  it('rejects a stale manual dispatch before creating a run', async () => {
    const { store, spec } = await fixture();
    const request = await api(store, spec.projectRoot);
    const job = await store.add(spec);
    await store.update(job.id, { ...spec, prompt: 'Changed' }, 1);
    expect((await request(`jobs/${job.id}/run`, 'POST', { expectedRevision: 1 })).status).toBe(409);
    expect((await store.snapshot()).runs).toHaveLength(0);
    expect((await request(`jobs/${job.id}/run`, 'POST', { expectedRevision: 2 })).status).toBe(202);
    expect((await store.snapshot()).runs[0]!.job.revision).toBe(2);
  });
  it('returns 409 on an outdated HTTP edit', async () => {
    const { store, spec } = await fixture();
    const request = await api(store, spec.projectRoot);
    const job = await store.add(spec);
    expect(
      (
        await request(`jobs/${job.id}`, 'PUT', {
          spec: { ...spec, prompt: 'changed' },
          expectedRevision: 1,
        })
      ).status,
    ).toBe(200);
    expect((await request(`jobs/${job.id}`, 'PUT', { spec, expectedRevision: 1 })).status).toBe(
      409,
    );
  });
  it('returns only named bounded artifacts from a known run', async () => {
    const { store, spec } = await fixture();
    const job = await store.add(spec);
    const run = await store.enqueue(job.id);
    const root = path.join(store.directory, 'runs', run.id);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'output.log'), 'verified fixture');
    expect(await readAutomationArtifact(store, run.id, 'output.log')).toBe('verified fixture');
    await expect(readAutomationArtifact(store, run.id, '../token.txt')).rejects.toThrow();
    await expect(readAutomationArtifact(store, 'unknown', 'output.log')).rejects.toThrow();
    await writeFile(path.join(root, 'output.log'), Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(readAutomationArtifact(store, run.id, 'output.log')).rejects.toThrow('2 MB');
  });
});

describe('GitHub conditions and launch plans', () => {
  it('fences a definition changed between webhook verification and queue publication', async () => {
    const { store, spec } = await fixture();
    const github = {
      repository: 'fixture/repo',
      events: ['issue_comment.created'],
      secretEnv: 'TEST_KEY',
    };
    const job = await store.add({ ...spec, github });
    const enqueue = store.enqueue.bind(store);
    vi.spyOn(store, 'enqueue').mockImplementation(async (...args) => {
      await store.update(job.id, { ...spec, github, image: 'changed:2' }, 1);
      return enqueue(...args);
    });
    const body = Buffer.from(
      JSON.stringify({
        repository: { full_name: 'fixture/repo' },
        action: 'created',
        issue: { number: 1 },
      }),
    );
    await expect(
      ingestGitHubEvent(
        store,
        job.id,
        body,
        {
          event: 'issue_comment',
          delivery: 'fenced',
          signature: `sha256=${createHmac('sha256', 'fixture-secret').update(body).digest('hex')}`,
        },
        { TEST_KEY: 'fixture-secret' },
      ),
    ).rejects.toThrow('refresh');
    expect((await store.snapshot()).runs).toHaveLength(0);
  });
  it('rejects secret values, missing reference fields and conflicting provider keys in job input', async () => {
    const { spec } = await fixture();
    const ref = { envName: 'API_KEY', profile: 'default', provider: 'team', keyLabel: 'work' };
    expect(() =>
      validateJobSpec({
        ...spec,
        credentials: [{ ...ref, apiKey: 'do-not-persist' } as typeof ref],
      }),
    ).toThrow();
    expect(() =>
      validateJobSpec({
        ...spec,
        credentials: [{ ...ref, profile: undefined } as unknown as typeof ref],
      }),
    ).toThrow();
    expect(() =>
      validateJobSpec({ ...spec, credentials: [ref, { ...ref, envName: 'OTHER_KEY' }] }),
    ).toThrow();
  });
  it('rejects malformed preview payloads and fails missing bot identity closed', () => {
    expect(evaluateGitHubFilters({ excludeBots: true }, {}).matches).toBe(false);
    expect(() => evaluateGitHubFilters(undefined, ['invalid'])).toThrow();
  });
  const payload = {
    repository: { full_name: 'fixture/repo' },
    action: 'created',
    issue: { number: 1, labels: [{ name: 'agent' }] },
    comment: { body: '@wrongstack investigate' },
    sender: { type: 'User', login: 'tester' },
  };
  it('explains each unmet condition and preserves unconditional legacy triggers', () => {
    expect(evaluateGitHubFilters(undefined, {})).toEqual({ matches: true, reasons: [] });
    expect(
      evaluateGitHubFilters({ mention: '@wrongstack', label: 'agent', excludeBots: true }, payload)
        .matches,
    ).toBe(true);
    expect(
      evaluateGitHubFilters({ branch: 'main', draft: false, conclusion: 'failure' }, payload)
        .reasons,
    ).toEqual(['branch', 'draft', 'conclusion']);
    expect(evaluateGitHubFilters({ excludeBots: true }, { sender: { type: 'Bot' } }).matches).toBe(
      false,
    );
  });
  it('filters signed ingestion before queueing and still deduplicates matching deliveries', async () => {
    const { store, spec } = await fixture();
    const job = await store.add({
      ...spec,
      github: {
        repository: 'fixture/repo',
        events: ['issue_comment.created'],
        secretEnv: 'TEST_KEY',
        filters: { mention: '@wrongstack' },
      },
    });
    const send = async (data: unknown, delivery: string) => {
      const body = Buffer.from(JSON.stringify(data));
      return ingestGitHubEvent(
        store,
        job.id,
        body,
        {
          event: 'issue_comment',
          delivery,
          signature: `sha256=${createHmac('sha256', 'fixture-secret').update(body).digest('hex')}`,
        },
        { TEST_KEY: 'fixture-secret' },
      );
    };
    expect(await send({ ...payload, comment: { body: 'unrelated' } }, 'ignored')).toBeNull();
    const run = await send(payload, 'accepted');
    expect(run).not.toBeNull();
    expect((await send(payload, 'accepted'))!.id).toBe(run!.id);
    expect((await store.snapshot()).runs).toHaveLength(1);
  });
  it('shares deterministic flags and exposes only credential references', async () => {
    const { spec } = await fixture();
    const plan = createHeadlessLaunchPlan(
      {
        ...spec,
        credentials: [
          { envName: 'API_KEY', profile: 'default', provider: 'team', keyLabel: 'work' },
        ],
        maxIterations: 12,
      },
      'event fixture',
      true,
      0,
    );
    expect(plan.args).toContain('--continue');
    expect(plan.args).toContain('12');
    expect(plan.args[1]).toContain('untrusted task data');
    expect(plan.credentialResolution).toBe('read-at-use');
    expect(plan.credentials[0]!.keyLabel).toBe('work');
    expect(() => createHeadlessLaunchPlan({ ...spec, envNames: ['NODE_OPTIONS'] })).toThrow();
    expect(() =>
      createHeadlessLaunchPlan({ ...spec, github: null as unknown as typeof spec.github }),
    ).toThrow('Invalid GitHub automation trigger');
  });
  it('preserves nextRunAt across reordered cron keys, rejects cross-project updates, retains same-ms continuation on prune, and matches GitHub repository case-insensitively (F28)', async () => {
    const { directory, store, spec } = await fixture();
    const otherDir = path.join(directory, 'other-f28');
    await mkdir(otherDir, { recursive: true });
    const createdAt = Date.parse('2026-10-01T00:05:00Z');
    const job = await store.add(
      {
        ...spec,
        schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
        github: {
          repository: 'WrongStack/Repo',
          events: ['issue_comment.created'],
          secretEnv: 'TEST_KEY',
        },
      },
      createdAt,
    );
    const updated = await store.update(
      job.id,
      {
        ...spec,
        prompt: 'Updated prompt',
        schedule: { timezone: 'UTC', expression: '0 * * * *', type: 'cron' },
        github: {
          repository: 'WrongStack/Repo',
          events: ['issue_comment.created'],
          secretEnv: 'TEST_KEY',
        },
      },
      1,
      Date.parse('2026-10-01T02:30:00Z'),
    );
    expect(updated.nextRunAt).toBe(job.nextRunAt);
    await expect(store.update(job.id, { ...spec, projectRoot: otherDir }, 2)).rejects.toThrow(
      'Automation job not found',
    );

    const r1 = await store.enqueue(job.id, 'github', 'd-f28-1', 'WrongStack/Repo#1', '', 100);
    const c1 = (await store.claim('w1', 101))!;
    await store.finish(
      c1.id,
      c1.leaseId!,
      {
        status: 'completed',
        result: {
          version: 1,
          agentStatus: 'done',
          sessionId: 's1',
          finalText: 'ok',
          durationMs: 1,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            iterations: 1,
            costUsd: null,
            costSource: 'unknown',
          },
          changedFiles: ['a.ts'],
          changedFilesTruncated: false,
          validation: { status: 'passed', evidence: ['verification.json'] },
        },
      },
      200,
    );
    const r2 = await store.enqueueCIRepair(r1.id, 'fix ci', 'b'.repeat(64));
    const c2 = (await store.claim('w1', 200))!;
    await store.finish(
      c2.id,
      c2.leaseId!,
      {
        status: 'completed',
        result: {
          version: 1,
          agentStatus: 'done',
          sessionId: 's2',
          finalText: 'ok2',
          durationMs: 1,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            iterations: 1,
            costUsd: null,
            costSource: 'unknown',
          },
          changedFiles: ['a.ts'],
          changedFilesTruncated: false,
          validation: { status: 'passed', evidence: ['verification.json'] },
        },
      },
      200,
    );
    await store.prune(1000);
    expect((await store.snapshot()).runs.map((r) => r.id)).toEqual([r1.id, r2.id]);

    const body = Buffer.from(
      JSON.stringify({
        repository: { full_name: 'wrongstack/repo' },
        action: 'created',
        issue: { number: 12 },
      }),
    );
    const run = await ingestGitHubEvent(
      store,
      job.id,
      body,
      {
        event: 'issue_comment',
        delivery: 'case-f28',
        signature: `sha256=${createHmac('sha256', 'fixture-secret').update(body).digest('hex')}`,
      },
      { TEST_KEY: 'fixture-secret' },
    );
    expect(run?.subjectKey).toBe('WrongStack/Repo#12');
  });
});
