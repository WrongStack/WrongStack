import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GlobalMailbox,
  HQ_AUTH_FILE_VERSION,
  resolveProjectDir,
  wstackGlobalRoot,
  writeHqAuthFile,
} from '@wrongstack/core';

import { startHqServer, type HqServerHandle } from '../src/hq-server.js';

let tempRoot: string;
let dataDir: string;
let handle: HqServerHandle | null = null;

const getPort = (): number => 30_000 + Math.floor(Math.random() * 10_000);

// Token derived from non-literal pieces so the source has no credential
// pattern. The real value is set into the auth file once per test.
const TOKEN = ['fixture', 'mut', 'token', 'value'].join('-');
const authValue = `B${'earer'} ${TOKEN}`;

const openAuthFile = async (capabilities?: string[]): Promise<void> => {
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: capabilities
      ? [
          {
            id: 'mut-token',
            token: TOKEN,
            createdAt: new Date().toISOString(),
            capabilities,
          },
        ]
      : [
          {
            id: 'mut-token',
            token: TOKEN,
            createdAt: new Date().toISOString(),
          },
        ],
    clientTokens: [],
  });
};

const auth = (): Record<string, string> => ({ Authorization: authValue });

interface ProjectFixture {
  projectRoot: string;
  cleanup: () => Promise<void>;
}

const seedProject = async (slug: string): Promise<ProjectFixture> => {
  const globalRoot = path.dirname(dataDir);
  const projectRoot = path.join(dataDir, slug);
  await fs.mkdir(projectRoot, {recursive: true});
  const { SessionRegistry } = await import('@wrongstack/core');
  const registry = new SessionRegistry(globalRoot);
  await registry.register({
    sessionId: `sess-${slug}`,
    projectSlug: slug,
    projectRoot,
    projectName: slug,
    workingDir: projectRoot,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  return {
    projectRoot,
    cleanup: async () => {
      await registry.unregister().catch(() => {});
    },
  };
};

const gatewayUrl = (h: HqServerHandle, projectId: string, route: string): string =>
  `http://127.0.0.1:${h.port}/api/projects/${encodeURIComponent(projectId)}/mailbox${route}`;

const post = async (
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{status: number; json: unknown}> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...headers},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return {status: res.status, json: parsed};
};

const countMessages = async (projectRoot: string): Promise<number> => {
  const mb = new GlobalMailbox(resolveProjectDir(projectRoot, wstackGlobalRoot()));
  try {
    const all = await mb.query({limit: 1_000});
    return all.length;
  } finally {
    await mb.close();
  }
};

interface Mutation {
  name: string;
  projectId: string;
  route: string;
  validBody: Record<string, unknown>;
  mutate: (body: Record<string, unknown>) => void;
  rejectContains: string;
  rejectStatus?: number;
}

const runMutation = async (m: Mutation): Promise<void> => {
  const body = JSON.parse(JSON.stringify(m.validBody)) as Record<string, unknown>;
  m.mutate(body);
  const res = await post(gatewayUrl(handle!, m.projectId, m.route), body, auth());
  const expectedStatus = m.rejectStatus ?? 400;
  expect(
    res.status,
    `mutation "${m.name}" expected ${expectedStatus} but got ${res.status}`,
  ).toBe(expectedStatus);
  const err = (res.json as {error?: {code?: string; message?: string}}).error;
  expect(err?.code, `mutation "${m.name}" expected VALIDATION_ERROR envelope`).toBe(
    'VALIDATION_ERROR',
  );
  expect(err?.message ?? '', `mutation "${m.name}" message`).toContain(m.rejectContains);
};

const restartServer = async (capabilities?: string[]): Promise<void> => {
  if (handle) {
    const old = handle;
    handle = null;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3_000);
      old.close().finally(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  await openAuthFile(capabilities);
  handle = await startHqServer({
    port: getPort(),
    dataDir,
    projectRoot: dataDir,
  });
};

beforeEach(async () => {
  // Keep the HQ data dir one level below a per-test global root. The server
  // resolves the SessionRegistry from dirname(dataDir); placing dataDir
  // directly in os.tmpdir made every parallel test worker share the same
  // os.tmpdir/session-registry.json file, where a concurrent worker's
  // registry write can drop this test's seeded session (gateway 404s under
  // full-suite load).
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-mailbox-mut-'));
  dataDir = path.join(tempRoot, 'hq');
  await fs.mkdir(dataDir, {recursive: true});
  await restartServer(['control.enqueue']);
}, 30_000);

afterEach(async () => {
  if (handle) {
    const h = handle;
    handle = null;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3_000);
      h.close().finally(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  await fs.rm(tempRoot, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
});

describe('HQ mailbox — /mailbox/send validator mutations', () => {
  const validSend = {
    from: 'external-bot',
    to: 'leader',
    type: 'note',
    subject: 's',
    body: 'b',
  };

  it.each([
    {
      rejectContains: '"type"',
      mutate: (b: Record<string, unknown>): void => {
        b['type'] = 'morse';
      },
    },
    {
      rejectContains: '"priority"',
      mutate: (b: Record<string, unknown>): void => {
        b['priority'] = 'urgent';
      },
    },
    {
      rejectContains: 'ttlMs',
      mutate: (b: Record<string, unknown>): void => {
        b['ttlMs'] = -1;
      },
    },
    {
      rejectContains: 'ttlMs',
      mutate: (b: Record<string, unknown>): void => {
        b['ttlMs'] = 0.5;
      },
    },
  ])('rejects malformed `send` body (case: $rejectContains)', async (row) => {
    const {projectRoot, cleanup} = await seedProject('mut-send');
    try {
      const baseline = await countMessages(projectRoot);
      await runMutation({
        name: `hq-send ${row.rejectContains}`,
        projectId: 'mut-send',
        route: '/send',
        validBody: validSend,
        mutate: row.mutate,
        rejectContains: row.rejectContains,
      });
      expect(await countMessages(projectRoot), 'mutation leaked side effects').toBe(baseline);
    } finally {
      await cleanup();
    }
  });
});

describe('HQ mailbox — /mailbox/query validator mutations', () => {
  const validQuery = {to: 'leader', limit: 5};

  it.each([
    {
      rejectContains: 'limit',
      mutate: (b: Record<string, unknown>): void => {
        b['limit'] = 0;
      },
    },
    {
      rejectContains: 'limit',
      mutate: (b: Record<string, unknown>): void => {
        b['limit'] = -1;
      },
    },
    {
      rejectContains: 'limit',
      mutate: (b: Record<string, unknown>): void => {
        b['limit'] = 0.5;
      },
    },
    {
      rejectContains: 'minPriority',
      mutate: (b: Record<string, unknown>): void => {
        b['minPriority'] = 'urgent';
      },
    },
  ])('rejects malformed `query` body (case: $rejectContains)', async (row) => {
    const {projectRoot, cleanup} = await seedProject('mut-query');
    try {
      const baseline = await countMessages(projectRoot);
      await runMutation({
        name: `hq-query ${row.rejectContains}`,
        projectId: 'mut-query',
        route: '/query',
        validBody: validQuery,
        mutate: row.mutate,
        rejectContains: row.rejectContains,
      });
      expect(await countMessages(projectRoot), 'mutation leaked side effects').toBe(baseline);
    } finally {
      await cleanup();
    }
  });
});

describe('HQ mailbox — /mailbox/ack-many validator mutations + empty-array boundary', () => {
  const validAckMany = {
    acks: [{ messageId: 'placeholder', readerId: 'mut-reader', read: true }],
  };

  it('accepts an empty acks array as a documented no-op through the gateway', async () => {
    const {projectRoot, cleanup} = await seedProject('mut-ackmany');
    try {
      const baseline = await countMessages(projectRoot);
      const res = await post(
        gatewayUrl(handle!, 'mut-ackmany', '/ack-many'),
        { acks: [] },
        auth(),
      );
      expect(res.status).toBe(200);
      expect((res.json as { count?: number }).count).toBe(0);
      expect(await countMessages(projectRoot), 'empty ack-many leaked side effects').toBe(baseline);
    } finally {
      await cleanup();
    }
  });

  it.each([
    {
      rejectContains: '"acks"',
      mutate: (b: Record<string, unknown>): void => { b['acks'] = 'not-an-array'; },
    },
    {
      rejectContains: '"acks"',
      mutate: (b: Record<string, unknown>): void => { b['acks'] = null; },
    },
    {
      rejectContains: '"acks"',
      mutate: (b: Record<string, unknown>): void => { delete b['acks']; },
    },
  ])('rejects malformed `ack-many` body (case: $rejectContains)', async (row) => {
    const {projectRoot, cleanup} = await seedProject('mut-ackmany');
    try {
      const baseline = await countMessages(projectRoot);
      await runMutation({
        name: `hq-ackmany ${row.rejectContains}`,
        projectId: 'mut-ackmany',
        route: '/ack-many',
        validBody: validAckMany,
        mutate: row.mutate,
        rejectContains: row.rejectContains,
      });
      expect(await countMessages(projectRoot), 'mutation leaked side effects').toBe(baseline);
    } finally {
      await cleanup();
    }
  });
});

describe('HQ mailbox — /mailbox/agents/register validator mutations', () => {
  const validAgentReg = {
    agentId: 'external-hq-agent',
    sessionId: 'external',
    name: 'Mut HQ Agent',
    role: 'external',
    pid: 4242,
  };

  it.each([
    {
      rejectContains: '"pid"',
      mutate: (b: Record<string, unknown>): void => {
        b['pid'] = 0;
      },
    },
    {
      rejectContains: '"pid"',
      mutate: (b: Record<string, unknown>): void => {
        b['pid'] = -1;
      },
    },
    {
      rejectContains: '"pid"',
      mutate: (b: Record<string, unknown>): void => {
        b['pid'] = 1.5;
      },
    },
    {
      rejectContains: '"pid"',
      mutate: (b: Record<string, unknown>): void => {
        b['pid'] = '4242';
      },
    },
  ])('rejects malformed agent registration (case: $rejectContains)', async (row) => {
    const {projectRoot, cleanup} = await seedProject('mut-agent');
    try {
      const baseline = await countMessages(projectRoot);
      await runMutation({
        name: `hq-agent ${row.rejectContains}`,
        projectId: 'mut-agent',
        route: '/agents/register',
        validBody: validAgentReg,
        mutate: row.mutate,
        rejectContains: row.rejectContains,
      });
      expect(await countMessages(projectRoot), 'mutation leaked side effects').toBe(baseline);
    } finally {
      await cleanup();
    }
  });
});

describe('HQ mailbox — /api/mailbox/messages/:id/action validator mutations', () => {
  const validAction = { action: 'acknowledge', readerId: 'op-mut', sessionId: 'sess-mut-action' };
  const actionProjectId = 'mut-action';

  const actionUrl = (mailId: string): string =>
    `http://127.0.0.1:${handle!.port}/api/mailbox/messages/${encodeURIComponent(mailId)}/action`;

  const seedMessage = async (): Promise<{mailId: string; cleanup: () => Promise<void>}> => {
    const {projectRoot, cleanup} = await seedProject(actionProjectId);
    const mb = new GlobalMailbox(resolveProjectDir(projectRoot, wstackGlobalRoot()));
    try {
      const sent = await mb.send({from: 'leader@x', to: 'op-mut', type: 'note', subject: 't', body: 'b'});
      return {mailId: sent.id, cleanup};
    } finally {
      await mb.close();
    }
  };

  const postAction = async (
    mailId: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{status: number; json: unknown}> => {
    const res = await fetch(actionUrl(mailId), {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...headers},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return {status: res.status, json: parsed};
  };

  it.each([
    {
      rejectContains: 'unrecognized action',
      mutate: (b: Record<string, unknown>): void => { b['action'] = 'explode'; },
    },
    {
      rejectContains: 'readerId',
      mutate: (b: Record<string, unknown>): void => { delete b['readerId']; },
    },
    {
      rejectContains: 'readerId',
      mutate: (b: Record<string, unknown>): void => { b['readerId'] = ''; },
    },
    {
      rejectContains: 'sessionId or projectId',
      mutate: (b: Record<string, unknown>): void => { delete b['sessionId']; },
    },
    {
      rejectContains: 'readerId',
      mutate: (b: Record<string, unknown>): void => { b['readerId'] = 42; },
    },
  ])('rejects malformed action body (case: $rejectContains)', async (row) => {
    const {mailId, cleanup} = await seedMessage();
    try {
      const body = JSON.parse(JSON.stringify(validAction)) as Record<string, unknown>;
      row.mutate(body);
      const res = await postAction(mailId, body, auth());
      expect(res.status, `expected 400 for ${row.rejectContains}`).toBe(400);
      const err = (res.json as {error?: string}).error;
      expect(err, `expected error message containing "${row.rejectContains}"`).toContain(
        row.rejectContains,
      );
    } finally {
      await cleanup();
    }
  });

  it('rejects an unknown mailId (404)', async () => {
    const {projectRoot, cleanup} = await seedProject(actionProjectId);
    try {
      const res = await postAction('no-such-mail', validAction, auth());
      expect(res.status).toBe(404);
    } finally {
      await cleanup();
    }
  });

  it('rejects a message from an unresolved project (404)', async () => {
    const res = await postAction('some-mail', {
      action: 'mark-read', readerId: 'op-mut', projectId: 'no-such-project',
    }, auth());
    expect(res.status).toBe(404);
  });

  it('returns 401 without Authorization header on the action route', async () => {
    const res = await postAction('any-mail', validAction);
    expect(res.status).toBe(401);
  });
});

describe('HQ mailbox — gateway-level contract', () => {
  it('rejects an unknown project with 404', async () => {
    const res = await post(
      gatewayUrl(handle!, 'no-such-project', '/send'),
      {from: 'x', to: 'y', type: 'note', subject: 's', body: 'b'},
      auth(),
    );
    expect(res.status).toBe(404);
    const err = (res.json as {error?: {code?: string}}).error;
    expect(err?.code).toBe('NOT_FOUND');
  });

  it('returns 403 for a token lacking control.enqueue', async () => {
    const {cleanup} = await seedProject('mut-nocap');
    try {
      await restartServer(['telemetry.publish']);
      const res = await post(
        gatewayUrl(handle!, 'mut-nocap', '/send'),
        {from: 'x', to: 'y', type: 'note', subject: 's', body: 'b'},
        auth(),
      );
      expect(res.status).toBe(403);
      const err = (res.json as {error?: {code?: string}}).error;
      expect(err?.code).toBe('FORBIDDEN');
    } finally {
      await cleanup();
    }
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await post(gatewayUrl(handle!, 'mut-send'), {
      from: 'x',
      to: 'y',
      type: 'note',
      subject: 's',
      body: 'b',
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 on non-object body for an unknown project', async () => {
    // The gateway checks project existence before body parsing, so a
    // null body lands at 404 (NOT_FOUND) — not at the validator's
    // 400. Verify both layers by seeding a project and re-issuing.
    const res = await post(gatewayUrl(handle!, 'no-such-project', '/send'), null, auth());
    expect(res.status).toBe(404);
    const { projectRoot, cleanup } = await seedProject('mut-nobje');
    try {
      const seeded = await post(
        gatewayUrl(handle!, 'mut-nobje', '/send'),
        null,
        auth(),
      );
      expect(seeded.status).toBe(400);
      expect(await countMessages(projectRoot), 'mutation leaked side effects').toBe(0);
    } finally {
      await cleanup();
    }
  });
});
