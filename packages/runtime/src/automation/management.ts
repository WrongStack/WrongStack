import { readFile, realpath } from 'node:fs/promises';
import { readAutomationArtifact } from './artifact.js';

export { readAutomationArtifact } from './artifact.js';

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import {
  exportAutomationJob,
  importAutomationJob,
  VERSIONED_AUTOMATION_TEMPLATES,
} from '@wrongstack/webui-protocol';
import type { AutomationJobSpec } from './contracts.js';
import { evaluateGitHubFilters } from './github-filters.js';
import { createHeadlessLaunchPlan } from './launch-plan.js';
import { AutomationPullRequests } from './pull-request.js';
import { AutomationJobBusy, AutomationRevisionConflict, type AutomationStore } from './store.js';

export async function readAutomationBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 128 * 1024) throw new Error('Request exceeds 128 KB');
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

/** Only reads a machine-owned descriptor. The browser cannot select the worker URL or token. */
export async function automationWorkerRequest(
  store: AutomationStore,
  suffix = '/healthz',
  method = 'GET',
): Promise<unknown> {
  if (
    !(
      (suffix === '/healthz' && method === 'GET') ||
      (/^\/v1\/runs\/[a-f0-9-]{36}\/cancel$/.test(suffix) && method === 'POST')
    )
  )
    throw new Error('Unsupported automation worker operation');
  const endpoint = JSON.parse(await readFile(path.join(store.directory, 'endpoint.json'), 'utf8'));
  if (
    !Number.isSafeInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535 ||
    typeof endpoint.workerId !== 'string'
  )
    throw new Error('Automation worker unavailable');
  const token = (await readFile(path.join(store.directory, 'token.txt'), 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Automation worker unavailable');
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${suffix}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(method === 'POST' ? 30_000 : 1500),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Automation worker unavailable or cancellation was refused');
  const value = (await response.json()) as { workerId?: unknown };
  if (suffix === '/healthz' && value.workerId !== endpoint.workerId)
    throw new Error('Automation worker unavailable');
  return value;
}

/** Authentication is performed by the caller. projectRoot binds all UI reads and mutations. */
export async function handleAutomationManagement(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  store: AutomationStore,
  cancel: (id: string) => Promise<void>,
  projectRoot?: string,
  profileConfig: (profile: string) => string = (profile) =>
    path.join(wstackGlobalRoot(), 'profiles', profile, 'config.json'),
): Promise<boolean> {
  const route = url.pathname;
  const known =
    /^\/v1\/(state|preview|import|templates|jobs(?:\/[a-f0-9-]{36}(?:\/(?:enabled|run|export))?)?|runs\/[a-f0-9-]{36}\/(?:cancel|artifact|pr(?:\/(?:prepare|publish|check|follow-up))?))$/;
  if (!known.test(route)) return false;
  const reply = (status: number, data: unknown) => {
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(data));
  };
  try {
    const root = projectRoot === undefined ? undefined : await realpath(projectRoot);
    const state = await store.snapshot();
    const jobs = state.jobs.filter((job) => root === undefined || job.projectRoot === root);
    const runs = state.runs.filter((run) => root === undefined || run.job.projectRoot === root);
    if (route === '/v1/state' && request.method === 'GET') {
      let workerOnline = false;
      try {
        await automationWorkerRequest(store);
        workerOnline = true;
      } catch {
        /* Offline queues remain usable. */
      }
      reply(200, { ...state, jobs, runs, workerOnline });
      return true;
    }
    if (route === '/v1/templates' && request.method === 'GET') {
      reply(200, VERSIONED_AUTOMATION_TEMPLATES);
      return true;
    }
    if (route === '/v1/import' && request.method === 'POST') {
      const body = await readAutomationBody(request);
      const spec = {
        ...importAutomationJob(body['document']),
        projectRoot: root ?? String(body['projectRoot'] ?? ''),
      };
      reply(201, await store.add(spec));
      return true;
    }
    const jobMatch = /^\/v1\/jobs\/([a-f0-9-]{36})(?:\/(enabled|run|export))?$/.exec(route);
    const runMatch =
      /^\/v1\/runs\/([a-f0-9-]{36})\/(cancel|artifact|pr(?:\/(?:prepare|publish|check|follow-up))?)$/.exec(
        route,
      );
    if (jobMatch && !jobs.some((job) => job.id === jobMatch[1])) {
      reply(404, { error: 'Automation job not found' });
      return true;
    }
    if (runMatch && !runs.some((run) => run.id === runMatch[1])) {
      reply(404, { error: 'Automation run not found' });
      return true;
    }
    if (runMatch?.[2]?.startsWith('pr')) {
      const pullRequests = new AutomationPullRequests(store);
      const operation = runMatch[2];
      if (operation === 'pr' && request.method === 'GET')
        reply(200, await pullRequests.inspect(runMatch[1]!));
      else if (operation !== 'pr' && request.method === 'POST') {
        const body = await readAutomationBody(request);
        if (operation === 'pr/prepare')
          reply(
            200,
            await pullRequests.prepare(runMatch[1]!, {
              repository: body['repository'] as string,
              base: body['base'] as string,
              title: body['title'] as string,
            }),
          );
        else if (operation === 'pr/publish')
          reply(
            200,
            await pullRequests.publish(
              runMatch[1]!,
              typeof body['fingerprint'] === 'string' ? body['fingerprint'] : '',
            ),
          );
        else if (operation === 'pr/follow-up')
          reply(
            202,
            await pullRequests.followUp(
              runMatch[1]!,
              typeof body['fingerprint'] === 'string' ? body['fingerprint'] : '',
            ),
          );
        else reply(200, await pullRequests.check(runMatch[1]!));
      } else reply(405, { error: 'Method not allowed' });
    } else if (jobMatch?.[2] === 'export' && request.method === 'GET') {
      reply(200, exportAutomationJob(jobs.find((job) => job.id === jobMatch[1])!));
    } else if (runMatch?.[2] === 'artifact' && request.method === 'GET') {
      reply(200, {
        content: await readAutomationArtifact(
          store,
          runMatch[1]!,
          url.searchParams.get('name') ?? '',
        ),
      });
    } else if (runMatch?.[2] === 'cancel' && request.method === 'POST') {
      await cancel(runMatch[1]!);
      reply(200, { ok: true });
    } else if (jobMatch?.[2] === 'run' && request.method === 'POST') {
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !key.trim() || key.length > 128)
        throw new Error('Idempotency-Key is required');
      const hasBody =
        (request.headers['content-length'] !== undefined &&
          request.headers['content-length'] !== '0') ||
        request.headers['transfer-encoding'] !== undefined;
      const body = hasBody ? await readAutomationBody(request) : {};
      const expectedRevision = body['expectedRevision'];
      if (
        expectedRevision !== undefined &&
        (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1)
      )
        throw new Error('Invalid expectedRevision');
      const run = await store.enqueue(
        jobMatch[1]!,
        'manual',
        `api:${key}`,
        'default',
        '',
        Date.now(),
        undefined,
        root,
        expectedRevision as number | undefined,
      );
      reply(202, { runId: run.id });
    } else if (jobMatch && !jobMatch[2] && request.method === 'DELETE') {
      const raw = url.searchParams.get('expectedRevision');
      const expectedRevision = raw === null ? Number.NaN : Number(raw);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
        throw new Error('expectedRevision is required');
      if (!jobs.some((job) => job.id === jobMatch[1])) {
        reply(404, { error: 'Automation job not found' });
        return true;
      }
      reply(200, {
        ok: true,
        removedRuns: await store.remove(jobMatch[1]!, expectedRevision, root),
      });
    } else if (jobMatch?.[2] === 'enabled' && request.method === 'POST') {
      const body = await readAutomationBody(request);
      if (typeof body['enabled'] !== 'boolean' || !Number.isSafeInteger(body['expectedRevision']))
        throw new Error('Enabled and expectedRevision are required');
      await store.setEnabled(
        jobMatch[1]!,
        body['enabled'],
        body['expectedRevision'] as number,
        root,
      );
      reply(200, { ok: true });
    } else if (
      (route === '/v1/jobs' || route === '/v1/preview' || (jobMatch && !jobMatch[2])) &&
      ['POST', 'PUT'].includes(request.method ?? '')
    ) {
      if (!jobMatch && request.method !== 'POST') {
        reply(405, { error: 'Use POST to create or preview a job' });
        return true;
      }
      if (jobMatch && request.method !== 'PUT') {
        reply(405, { error: 'Use PUT to edit a job' });
        return true;
      }
      const body = await readAutomationBody(request);
      const raw = body['spec'];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Job spec is required');
      const spec = { ...raw, ...(root ? { projectRoot: root } : {}) } as AutomationJobSpec;
      // Generated record fields are never accepted as editable input.
      if (['id', 'revision', 'createdAt', 'nextRunAt'].some((key) => Object.hasOwn(spec, key)))
        throw new Error('Record fields are not editable');
      const plan = createHeadlessLaunchPlan(spec);
      if (route === '/v1/preview') {
        const missingReferences: string[] = [
          ...new Set([
            ...spec.envNames,
            ...(spec.environment?.services.flatMap((service) => service.envNames) ?? []),
          ]),
        ].filter((name) => !process.env[name]);
        for (const ref of spec.credentials ?? []) {
          try {
            const profile = JSON.parse(await readFile(profileConfig(ref.profile), 'utf8'));
            const provider =
              profile.providers && Object.hasOwn(profile.providers, ref.provider)
                ? profile.providers[ref.provider]
                : undefined;
            const key = provider?.apiKeys?.find(
              (item: { label: string }) => item.label === ref.keyLabel,
            );
            if (!key?.apiKey || (key.authMethod && key.authMethod !== 'api_key'))
              missingReferences.push(`${ref.profile}/${ref.provider}/${ref.keyLabel}`);
          } catch {
            missingReferences.push(`${ref.profile}/${ref.provider}/${ref.keyLabel}`);
          }
        }
        const filterPreview =
          body['event'] === undefined
            ? undefined
            : evaluateGitHubFilters(spec.github?.filters, body['event']);
        reply(200, { ...plan, missingReferences, filterPreview });
      } else if (jobMatch) {
        if (!Number.isSafeInteger(body['expectedRevision']))
          throw new Error('expectedRevision is required');
        reply(200, await store.update(jobMatch[1]!, spec, body['expectedRevision'] as number));
      } else reply(201, await store.add(spec));
    } else reply(405, { error: 'Method not allowed' });
  } catch (error) {
    reply(
      error instanceof AutomationRevisionConflict || error instanceof AutomationJobBusy ? 409 : 400,
      {
        error: error instanceof Error ? error.message.slice(0, 256) : 'Automation request failed',
      },
    );
  }
  return true;
}
