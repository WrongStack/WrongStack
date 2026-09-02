/**
 * End-to-end tests for the Requirements Intake REST API wired into the
 * WebUI HTTP server: route registration, auth gate, error mapping, and the
 * full create → answer → submit lifecycle over HTTP.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureProjectIdentity } from '@wrongstack/core/utils';
import {
  AllowAllIntakeAuthorizer,
  RequirementIntakeService,
  RequirementIntakeStore,
} from '@wrongstack/requirement-intake';
import { createHttpServer } from '../src/index.js';

// Security scan 2026-08-04, finding H3: the HTTP API now requires a token on
// every bind, including loopback. These suites previously exercised the
// unauthenticated configuration that finding was about.
const TEST_API_TOKEN = 'test-api-token';
const authFetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, {
    ...init,
    headers: { ...((init.headers as Record<string, string>) ?? {}), 'x-ws-token': TEST_API_TOKEN },
  });

let distDir: string;
let storeDir: string;
let projectRoot: string;
let expectedProjectId: string;
let server: import('node:http').Server;
let baseUrl: string;

let lockedServer: import('node:http').Server;
let lockedBaseUrl: string;

let noServiceServer: import('node:http').Server;
let noServiceBaseUrl: string;

const REQUEST = {
  projectId: 'proj_alpha',
  originalRequest: 'Add email-based password reset so users can recover access.',
  requestedBy: 'user-alice',
};

beforeAll(async () => {
  distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-intake-dist-'));
  await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>intake</title>');
  storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-intake-store-'));
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-intake-project-'));
  expectedProjectId = (await ensureProjectIdentity(projectRoot)).identity.projectId;

  const service = new RequirementIntakeService({
    store: new RequirementIntakeStore({ baseDir: storeDir }),
    authorizer: new AllowAllIntakeAuthorizer(),
  });

  server = createHttpServer({
    host: '127.0.0.1',
    distDir,
    projectRoot,
    intakeService: service,
    apiToken: TEST_API_TOKEN,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad listen address');
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // A second server WITHOUT an intake service — intake routes must 503.
  lockedServer = createHttpServer({
    host: '127.0.0.1',
    distDir,
    apiToken: 'test-token',
    requireToken: true,
  });
  await new Promise<void>((resolve) => lockedServer.listen(0, '127.0.0.1', resolve));
  const lockedAddr = lockedServer.address();
  if (!lockedAddr || typeof lockedAddr === 'string') throw new Error('bad listen address');
  lockedBaseUrl = `http://127.0.0.1:${lockedAddr.port}`;

  // A third server with neither a service nor a token gate — 503 (not 401).
  noServiceServer = createHttpServer({ host: '127.0.0.1', distDir, apiToken: TEST_API_TOKEN });
  await new Promise<void>((resolve) => noServiceServer.listen(0, '127.0.0.1', resolve));
  const noServiceAddr = noServiceServer.address();
  if (!noServiceAddr || typeof noServiceAddr === 'string') throw new Error('bad listen address');
  noServiceBaseUrl = `http://127.0.0.1:${noServiceAddr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => lockedServer.close(() => resolve()));
  await new Promise<void>((resolve) => noServiceServer.close(() => resolve()));
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.rm(storeDir, { recursive: true, force: true });
  await fs.rm(projectRoot, { recursive: true, force: true });
});

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await authFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as unknown };
}

describe('requirement-intake REST API', () => {
  it('creates an intake record and preserves the original request', async () => {
    const { status, json } = await postJson(
      `${baseUrl}/api/projects/proj_alpha/requirement-intakes`,
      REQUEST,
    );
    expect(status).toBe(201);
    const body = json as { record: { id: string; originalRequest: string; status: string } };
    expect(body.record.id).toMatch(/^reqi_/);
    expect(body.record.originalRequest).toBe(REQUEST.originalRequest);
    expect(body.record.status).toBe('draft');
  });

  it('rejects an empty request with a 400 and field issues', async () => {
    const { status, json } = await postJson(
      `${baseUrl}/api/projects/proj_alpha/requirement-intakes`,
      {
        ...REQUEST,
        originalRequest: '   ',
      },
    );
    expect(status).toBe(400);
    const body = json as { error: { code: string; issues: Array<{ field: string }> } };
    expect(body.error.code).toBe('INTAKE_VALIDATION_ERROR');
    expect(body.error.issues.some((issue) => issue.field.includes('originalRequest'))).toBe(true);
  });

  it('lists intake records for a project', async () => {
    await postJson(`${baseUrl}/api/projects/proj_alpha/requirement-intakes`, REQUEST);
    const res = await authFetch(`${baseUrl}/api/projects/proj_alpha/requirement-intakes`);
    expect(res.status).toBe(200);
    const records = (await res.json()) as Array<{ id: string; projectId: string }>;
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.projectId === 'proj_alpha')).toBe(true);
  });

  it('gets, patches, answers, and submits an intake record', async () => {
    const created = await postJson(
      `${baseUrl}/api/projects/proj_alpha/requirement-intakes`,
      REQUEST,
    );
    const intakeId = (created.json as { record: { id: string } }).record.id;

    // GET
    const getRes = await authFetch(`${baseUrl}/api/requirement-intakes/${intakeId}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { title: string; originalRequest: string };
    expect(fetched.originalRequest).toBe(REQUEST.originalRequest);

    // PATCH
    const patchRes = await authFetch(`${baseUrl}/api/requirement-intakes/${intakeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Password reset', priority: 'high' }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { title: string; priority: string };
    expect(patched.title).toBe('Password reset');
    expect(patched.priority).toBe('high');

    // answers
    const answerRes = await postJson(`${baseUrl}/api/requirement-intakes/${intakeId}/answers`, {
      field: 'business_goal',
      answer: 'Reduce password reset support tickets',
    });
    expect(answerRes.status).toBe(200);
    const answered = answerRes.json as { businessGoal: string };
    expect(answered.businessGoal).toBe('Reduce password reset support tickets');
    // submit
    const submitRes = await postJson(`${baseUrl}/api/requirement-intakes/${intakeId}/submit`, {});
    expect(submitRes.status).toBe(200);
    const submitted = submitRes.json as { record: { status: string } };
    expect(submitted.record.status).toBe('submitted');

    // duplicate submit is idempotent
    const again = await postJson(`${baseUrl}/api/requirement-intakes/${intakeId}/submit`, {});
    expect(again.status).toBe(200);
    expect((again.json as { idempotent: boolean }).idempotent).toBe(true);
  });

  it('rejects invalid lifecycle transitions with 409', async () => {
    const created = await postJson(
      `${baseUrl}/api/projects/proj_alpha/requirement-intakes`,
      REQUEST,
    );
    const intakeId = (created.json as { record: { id: string } }).record.id;
    await postJson(`${baseUrl}/api/requirement-intakes/${intakeId}/submit`, {});
    const cancelRes = await postJson(`${baseUrl}/api/requirement-intakes/${intakeId}/cancel`, {
      reason: 'too late',
    });
    expect(cancelRes.status).toBe(409);
    expect((cancelRes.json as { error: { code: string } }).error.code).toBe(
      'INTAKE_INVALID_TRANSITION',
    );
  });

  it('returns 404 for an unknown intake id', async () => {
    const res = await authFetch(`${baseUrl}/api/requirement-intakes/reqi_nope`);
    expect(res.status).toBe(404);
  });

  it('returns 502 when LLM suggestions are requested without a generator', async () => {
    const created = await postJson(
      `${baseUrl}/api/projects/proj_alpha/requirement-intakes`,
      REQUEST,
    );
    const intakeId = (created.json as { record: { id: string } }).record.id;
    const res = await postJson(`${baseUrl}/api/requirement-intakes/${intakeId}/suggestions`, {});
    expect(res.status).toBe(502);
    expect((res.json as { error: { code: string } }).error.code).toBe('INTAKE_SUGGESTION_ERROR');
  });

  it('responds 503 when no intake service is wired', async () => {
    const res = await authFetch(`${noServiceBaseUrl}/api/projects/proj_alpha/requirement-intakes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(REQUEST),
    });
    expect(res.status).toBe(503);
  });

  it('lists the server project with its resolved id (frontend entry point)', async () => {
    // Create one record through the project-scoped endpoint first.
    const create = await authFetch(
      `${baseUrl}/api/projects/${expectedProjectId}/requirement-intakes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: expectedProjectId,
          originalRequest: 'Server-resolved list request',
          requestedBy: 'user-alice',
        }),
      },
    );
    expect(create.status).toBe(201);

    const res = await authFetch(`${baseUrl}/api/requirement-intakes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projectId: string;
      intakes: Array<{ id: string; originalRequest: string }>;
    };
    expect(body.projectId).toBe(expectedProjectId);
    expect(body.intakes.length).toBeGreaterThan(0);
    expect(
      body.intakes.some((intake) => intake.originalRequest === 'Server-resolved list request'),
    ).toBe(true);
  });

  it('returns 404 for the server list when the project has no identity', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-intake-bare-'));
    try {
      const service = new RequirementIntakeService({
        store: new RequirementIntakeStore({ baseDir: storeDir }),
        authorizer: new AllowAllIntakeAuthorizer(),
      });
      const bareServer = createHttpServer({
        host: '127.0.0.1',
        distDir,
        projectRoot: bare,
        intakeService: service,
        apiToken: TEST_API_TOKEN,
      });
      await new Promise<void>((resolve) => bareServer.listen(0, '127.0.0.1', resolve));
      const addr = bareServer.address();
      if (!addr || typeof addr === 'string') throw new Error('bad listen address');
      const bareBaseUrl = `http://127.0.0.1:${addr.port}`;
      try {
        const res = await authFetch(`${bareBaseUrl}/api/requirement-intakes`);
        expect(res.status).toBe(404);
      } finally {
        await new Promise<void>((resolve) => bareServer.close(() => resolve()));
      }
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });

  it('enforces the HTTP token gate on intake routes', async () => {
    const res = await fetch(`${lockedBaseUrl}/api/projects/proj_alpha/requirement-intakes`);
    expect(res.status).toBe(401);
    const authorized = await fetch(`${lockedBaseUrl}/api/projects/proj_alpha/requirement-intakes`, {
      headers: { 'X-WS-Token': 'test-token' },
    });
    expect(authorized.status).toBe(503); // token OK, service still missing
  });
});
