import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { MailboxEventEmitter } from '../../src/coordination/mailbox-events.js';
import {
  authorizeMailboxBearerToken,
  authorizePersistedMailboxCredential,
  createMailboxHttpRouter,
  MailboxHttpRateLimiter,
} from '../../src/coordination/mailbox-http-router.js';
import type {
  Mailbox,
  MailboxAckBatchInput,
  MailboxAckInput,
  MailboxMessage,
  MailboxQuery,
  MailboxSendInput,
} from '../../src/coordination/mailbox-types.js';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';
import {
  type CredentialStoreLike,
  closeOpenedCredentialStores,
  openCredentialStore,
} from '../helpers/sqlite-credential-store.js';

interface ResponseRecorder {
  response: ServerResponse;
  readonly chunks: string[];
  status?: number;
  headers?: OutgoingHttpHeaders;
  ended: boolean;
  json(): unknown;
  text(): string;
}

function makeRequest(
  input: {
    method?: string;
    url?: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
    keepOpen?: boolean;
  } = {},
): IncomingMessage {
  const raw = input.rawBody ?? (input.body === undefined ? '' : JSON.stringify(input.body));
  const stream = input.keepOpen ? new PassThrough() : Readable.from(raw ? [Buffer.from(raw)] : []);
  Object.assign(stream, {
    method: input.method ?? 'GET',
    url: input.url ?? '/',
    headers: { ...(input.headers ?? {}) },
  });
  return stream as unknown as IncomingMessage;
}

function makeResponse(): ResponseRecorder {
  const chunks: string[] = [];
  const recorder: ResponseRecorder = {
    response: undefined as unknown as ServerResponse,
    chunks,
    ended: false,
    json: () => JSON.parse(chunks.join('')) as unknown,
    text: () => chunks.join(''),
  };
  const response = {
    writeHead(status: number, headers?: OutgoingHttpHeaders) {
      recorder.status = status;
      recorder.headers = headers;
      return response;
    },
    write(chunk: string | Buffer) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) chunks.push(String(chunk));
      recorder.ended = true;
      return response;
    },
  };
  recorder.response = response as unknown as ServerResponse;
  return recorder;
}

function message(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    id: 'msg-1',
    from: 'external-a',
    to: 'agent-b',
    type: 'note',
    subject: 'subject',
    body: 'body',
    priority: 'normal',
    timestamp: '2026-07-16T00:00:00.000Z',
    readBy: {},
    completed: false,
    ...overrides,
  };
}

function makeMailbox() {
  const send = vi.fn(async (input: MailboxSendInput) =>
    message({
      id: 'sent-1',
      from: input.from,
      to: input.to,
      type: input.type,
      subject: input.subject,
      body: input.body,
      ...(input.audience !== undefined ? { audience: input.audience } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
      ...(input.taskContext !== undefined ? { taskContext: input.taskContext } : {}),
      ...(input.senderSessionId !== undefined ? { senderSessionId: input.senderSessionId } : {}),
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    }),
  );
  const query = vi.fn(async (_query: MailboxQuery) => [] as MailboxMessage[]);
  const ack = vi.fn(async (input: MailboxAckInput) =>
    message({ id: input.messageId, completed: input.completed ?? false }),
  );
  const ackMany = vi.fn(async (input: MailboxAckBatchInput) =>
    input.acks.map((entry) =>
      message({ id: entry.messageId, completed: entry.completed ?? false }),
    ),
  );
  const unreadCount = vi.fn(async () => 0);
  const registerAgent = vi.fn(async () => undefined);
  const heartbeat = vi.fn(async () => undefined);
  const registerClient = vi.fn(async () => undefined);
  const clientHeartbeat = vi.fn(async () => undefined);
  const getAgentStatuses = vi.fn(async () => []);
  const getOnlineAgents = vi.fn(async () => []);
  const purgeClients = vi.fn(async () => 0);

  const mailbox: Mailbox = {
    send,
    query,
    ack,
    ackMany,
    unreadCount,
    registerAgent,
    heartbeat,
    registerClient,
    clientHeartbeat,
    getAgentStatuses,
    getOnlineAgents,
    purgeClients,
    softDelete: vi.fn(async () => null),
    restore: vi.fn(async () => null),
    deregisterAgent: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    clearAll: vi.fn(async () => undefined),
    purgeStale: vi.fn(async () => ({
      completedPurged: 0,
      incompletePurged: 0,
      totalPurged: 0,
      remaining: 0,
    })),
    autoCompact: vi.fn(async () => ({
      readByAllRemoved: 0,
      expiredRemoved: 0,
      stalePurged: 0,
      totalRemoved: 0,
      remaining: 0,
    })),
    startAutoCompactTimer: vi.fn(() => () => undefined),
    deregisterClient: vi.fn(async () => undefined),
    getClientStatuses: vi.fn(async () => []),
  };

  return {
    mailbox,
    send,
    query,
    ack,
    ackMany,
    unreadCount,
    registerAgent,
    heartbeat,
    registerClient,
    clientHeartbeat,
    getAgentStatuses,
    getOnlineAgents,
    purgeClients,
  };
}

async function handle(
  input: {
    mailbox?: Mailbox;
    request?: IncomingMessage;
    routePath?: string;
    authorize?: Parameters<typeof createMailboxHttpRouter>[0]['authorize'];
    credentialStore?: CredentialStoreLike;
    rateLimiter?: MailboxHttpRateLimiter;
    eventEmitter?: MailboxEventEmitter;
    maxBodyBytes?: number;
    defaultMaxAgeMs?: number;
    projectId?: string;
  } = {},
): Promise<ResponseRecorder> {
  const response = makeResponse();
  const router = createMailboxHttpRouter({
    mailbox: input.mailbox ?? makeMailbox().mailbox,
    ...(input.authorize ? { authorize: input.authorize } : {}),
    ...(input.credentialStore ? { credentialStore: input.credentialStore } : {}),
    ...(input.credentialStore || input.projectId !== undefined
      ? { projectId: input.projectId ?? 'test-project' }
      : {}),
    ...(input.rateLimiter ? { rateLimiter: input.rateLimiter } : {}),
    ...(input.eventEmitter ? { eventEmitter: input.eventEmitter } : {}),
    ...(input.maxBodyBytes !== undefined ? { maxBodyBytes: input.maxBodyBytes } : {}),
    ...(input.defaultMaxAgeMs !== undefined ? { defaultMaxAgeMs: input.defaultMaxAgeMs } : {}),
  });
  await router.handle(input.request ?? makeRequest(), response.response, input.routePath);
  return response;
}

describe('mailbox HTTP router', () => {
  it('serves /healthz before authorization and returns no-store JSON', async () => {
    const authorize = vi.fn(() => ({ allowed: false as const }));
    const response = await handle({ request: makeRequest({ url: '/healthz' }), authorize });

    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    expect(response.json()).toEqual({ ok: true });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('supports host prefix mounting through routePath and validates send input', async () => {
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/api/projects/proj/mailbox/send',
        body: {
          from: 'external-bot',
          to: 'agent-b',
          type: 'note',
          subject: 'mounted',
          body: 'through HQ',
          priority: 'high',
          audience: 'leaders',
          ttlMs: 1_000,
        },
      }),
      routePath: '/mailbox/send',
    });

    expect(response.status).toBe(201);
    expect(stub.send).toHaveBeenCalledWith({
      from: 'external-bot',
      to: 'agent-b',
      type: 'note',
      subject: 'mounted',
      body: 'through HQ',
      priority: 'high',
      audience: 'leaders',
      ttlMs: 1_000,
    });
    expect(response.json()).toMatchObject({ id: 'sent-1', subject: 'mounted' });
  });

  it.each(['all', ' ALL ', ' * '])(
    'canonicalizes project broadcast recipient %j before forwarding',
    async (to) => {
      const stub = makeMailbox();
      const response = await handle({
        mailbox: stub.mailbox,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/send',
          body: {
            from: 'external-bot',
            to,
            type: 'broadcast',
            subject: 'broadcast',
            body: 'hello',
          },
        }),
      });

      expect(response.status).toBe(201);
      expect(stub.send).toHaveBeenCalledWith(expect.objectContaining({ to: '*' }));
    },
  );

  it.each([
    ['assign', 'all'],
    ['assign', ' ALL '],
    ['assign', ' * '],
    ['assign', '@session:session-1'],
    ['steer', 'all'],
    ['steer', '@session:session-1'],
  ] as const)('rejects %s sent to multi-recipient target %j', async (type, to) => {
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/send',
        body: {
          from: 'external-bot',
          to,
          type,
          subject: 'action',
          body: 'do this',
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('requires a specific recipient'),
      },
    });
    expect(stub.send).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'reserved sender identity',
      body: { from: 'leader@remote', to: 'x', type: 'note', subject: 's', body: 'b' },
      message: 'reserved internal agent id "leader"',
    },
    {
      name: 'unknown message type',
      body: { from: 'external', to: 'x', type: 'unknown', subject: 's', body: 'b' },
      message: 'field "type" must be one of',
    },
    {
      name: 'invalid priority',
      body: {
        from: 'external',
        to: 'x',
        type: 'note',
        subject: 's',
        body: 'b',
        priority: 'urgent',
      },
      message: 'field "priority" must be one of',
    },
  ])('rejects $name before calling the mailbox', async ({ body, message: expected }) => {
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({ method: 'POST', url: '/mailbox/send', body }),
    });

    expect(response.status).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: expect.stringContaining(expected) },
    });
    expect(stub.send).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON and bodies over the configured cap', async () => {
    const invalid = await handle({
      request: makeRequest({ method: 'POST', url: '/mailbox/query', rawBody: '{broken' }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const oversized = await handle({
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/query',
        rawBody: '{"x":"too large"}',
        headers: { 'content-length': '17' },
      }),
      maxBodyBytes: 8,
    });
    expect(oversized.status).toBe(400);
    expect(oversized.json()).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('request body too large'),
      },
    });
  });

  it('returns custom authorization denials and enforces host-keyed rate limits', async () => {
    const denied = await handle({
      request: makeRequest({ url: '/mailbox/agents' }),
      authorize: () => ({
        allowed: false,
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'missing capability' } },
      }),
    });
    expect(denied.status).toBe(403);
    expect(denied.json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'missing capability' },
    });

    const stub = makeMailbox();
    const router = createMailboxHttpRouter({
      mailbox: stub.mailbox,
      authorize: () => ({ allowed: true, rateLimitKey: 'shared-key' }),
      rateLimiter: new MailboxHttpRateLimiter(1, 60_000),
    });
    const first = makeResponse();
    const second = makeResponse();
    await router.handle(makeRequest({ url: '/mailbox/agents' }), first.response);
    await router.handle(makeRequest({ url: '/mailbox/agents' }), second.response);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(stub.getAgentStatuses).toHaveBeenCalledTimes(1);
  });

  it('checks direct and base inboxes, deduplicates/self-filters, and batches receipts once', async () => {
    const stub = makeMailbox();
    const direct = message({ id: 'direct', from: 'sender-a', to: 'agent@one' });
    const duplicate = message({ id: 'direct', from: 'sender-a', to: 'agent' });
    const self = message({ id: 'self', from: 'agent@one', to: 'agent@one' });
    const base = message({ id: 'base', from: 'sender-b', to: 'agent' });
    stub.query.mockImplementation(async (query: MailboxQuery) =>
      query.to === 'agent@one' ? [direct, self] : [duplicate, base],
    );
    stub.ackMany.mockImplementation(async ({ acks }: MailboxAckBatchInput) =>
      acks.map((entry) => message({ id: entry.messageId, completed: entry.completed ?? false })),
    );

    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/check',
        body: {
          agentId: 'agent@one',
          baseId: 'agent',
          completed: true,
          outcome: 'handled',
          limit: 10,
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(stub.query).toHaveBeenCalledTimes(2);
    expect(stub.ackMany).toHaveBeenCalledTimes(1);
    expect(stub.ackMany).toHaveBeenCalledWith({
      acks: [
        {
          messageId: 'direct',
          readerId: 'agent@one',
          read: true,
          completed: true,
          outcome: 'handled',
        },
        {
          messageId: 'base',
          readerId: 'agent@one',
          read: true,
          completed: true,
          outcome: 'handled',
        },
      ],
    });
    expect(response.json()).toMatchObject({ count: 2 });
  });

  it('drops mailbox messages older than the configured look-back window', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-07-16T12:00:00.000Z').getTime();
    vi.setSystemTime(now);
    try {
      const freshOld = message({
        id: 'fresh-old',
        timestamp: new Date(now - 90 * 60_000).toISOString(),
      });
      const justInside = message({
        id: 'just-inside',
        timestamp: new Date(now - 59 * 60_000).toISOString(),
      });
      const wayOld = message({
        id: 'way-old',
        timestamp: new Date(now - 6 * 60 * 60_000).toISOString(),
      });
      const stub = makeMailbox();
      stub.query.mockResolvedValue([freshOld, wayOld, justInside]);

      // 1 h window: the message at -59min stays (just inside); -90min
      // and -6h are older than the cutoff and are dropped.
      const response = await handle({
        mailbox: stub.mailbox,
        request: makeRequest({ method: 'POST', url: '/mailbox/query', body: { to: 'agent-b' } }),
        defaultMaxAgeMs: 60 * 60_000,
      });

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ data: [justInside], count: 1 });

      // `?sinceMs=0` opts in to the full retained history regardless of
      // the server default. The router still validates that the value
      // is a non-negative integer, but a zero is the explicit "no filter"
      // escape hatch.
      const allResponse = await handle({
        mailbox: stub.mailbox,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/query?sinceMs=0',
          body: { to: 'agent-b' },
        }),
      });
      expect(allResponse.status).toBe(200);
      expect(allResponse.json()).toMatchObject({ count: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects out-of-range ?sinceMs values with 400 VALIDATION_ERROR', async () => {
    const stub = makeMailbox();
    for (const bad of ['-5', 'abc', '1.5', '99999999999999999999']) {
      const response = await handle({
        mailbox: stub.mailbox,
        request: makeRequest({
          method: 'POST',
          url: `/mailbox/query?sinceMs=${bad}`,
          body: { to: 'agent-b' },
        }),
      });
      expect(response.status, `sinceMs=${bad} should reject`).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('sinceMs') },
      });
      // No mailbox method is permitted to fire — the filter rejection
      // happens at the routing layer BEFORE the underlying query().
    }
    expect(stub.query).not.toHaveBeenCalled();
  });

  it('honours per-request ?sinceMs even when the server default would retain the message', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-07-16T12:00:00.000Z').getTime();
    vi.setSystemTime(now);
    try {
      const tenMinOld = message({
        id: '10min',
        timestamp: new Date(now - 10 * 60_000).toISOString(),
      });
      const fiveMinOld = message({
        id: '5min',
        timestamp: new Date(now - 5 * 60_000).toISOString(),
      });
      const stub = makeMailbox();
      stub.query.mockResolvedValueOnce([tenMinOld, fiveMinOld]);

      // Server default would let both pass (10min < 1h), but the agent
      // explicitly asks for a tighter 6-minute look-back, so the 10-minute
      // message is dropped while the 5-minute one survives.
      const response = await handle({
        mailbox: stub.mailbox,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/query?sinceMs=360000',
          body: { to: 'agent-b' },
        }),
        defaultMaxAgeMs: 60 * 60_000,
      });

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ data: [fiveMinOld], count: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not ack messages that the staleness filter drops from the /mailbox/check response', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-07-16T12:00:00.000Z').getTime();
    vi.setSystemTime(now);
    try {
      const old = message({ id: 'old', timestamp: new Date(now - 90 * 60_000).toISOString() });
      const fresh = message({ id: 'fresh', timestamp: new Date(now - 5 * 60_000).toISOString() });
      const stub = makeMailbox();
      stub.query.mockImplementation(async (query: MailboxQuery) =>
        query.to === 'agent-b' ? [old, fresh] : [],
      );

      const response = await handle({
        mailbox: stub.mailbox,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/check',
          body: { agentId: 'agent-b' },
        }),
        defaultMaxAgeMs: 30 * 60_000,
      });

      expect(response.status).toBe(200);
      expect(response.json()).toMatchObject({ count: 1 });
      // The ackMany input MUST be the filtered set — never the full
      // unfiltered query result — or the older message would be
      // silently marked read while the caller never sees it.
      expect(stub.ackMany).toHaveBeenCalledTimes(1);
      expect(stub.ackMany).toHaveBeenCalledWith({
        acks: [expect.objectContaining({ messageId: 'fresh', readerId: 'agent-b' })],
      });
      expect(
        (stub.ackMany.mock.calls[0]![0] as { acks: Array<{ messageId: string }> }).acks.map(
          (a) => a.messageId,
        ),
      ).not.toContain('old');
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats disable sentinels (-1, NaN, Infinity, 0) as "no filter" for defaultMaxAgeMs', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-07-16T12:00:00.000Z').getTime();
    vi.setSystemTime(now);
    try {
      // 90 minutes old: would be dropped by any positive finite look-back,
      // but is retained when the option is a disable sentinel.
      const oldish = message({
        id: 'oldish',
        timestamp: new Date(now - 90 * 60_000).toISOString(),
      });
      const veryOld = message({
        id: 'very-old',
        timestamp: new Date(now - 365 * 24 * 60 * 60_000).toISOString(),
      });
      const stub = makeMailbox();
      stub.query.mockResolvedValueOnce([oldish, veryOld]);

      let previousQueryCalls = 0;
      for (const sentinel of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0] as const) {
        // Re-prime the stub for every sentinel value so each case sees the
        // same input set. (NaN survives the `??` fallback because the
        // constructor pulls `options.defaultMaxAgeMs` verbatim.)
        stub.query.mockResolvedValueOnce([oldish, veryOld]);
        const response = await handle({
          mailbox: stub.mailbox,
          request: makeRequest({
            method: 'POST',
            url: '/mailbox/query',
            body: { to: 'agent-b' },
          }),
          defaultMaxAgeMs: sentinel,
        });
        expect(response.status, `sentinel=${sentinel}`).toBe(200);
        const payload = response.json() as { data: MailboxMessage[]; count: number };
        // Every retained message should pass through — the filter is off.
        expect(payload.count, `sentinel=${sentinel}`).toBe(2);
        expect(payload.data.map((m) => m.id).sort()).toEqual(['oldish', 'very-old']);
        // Lock the "single upstream query call per handle() regardless of
        // sentinel" invariant. Use cumulative delta rather than absolute
        // count so the assertion holds across every iteration in the loop.
        expect(
          stub.query.mock.calls.length,
          `sentinel=${sentinel}: upstream query call count`,
        ).toBe(previousQueryCalls + 1);
        previousQueryCalls = stub.query.mock.calls.length;
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps ?sinceMs above the ceiling to MAILBOX_HTTP_MAX_AGE_CEILING_MS (not rejected)', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-07-16T12:00:00.000Z').getTime();
    vi.setSystemTime(now);
    try {
      // One message at -3 days (within the 7-day ceiling), one at -10 days
      // (outside any clamped ceiling). `?sinceMs=10_000_000_000` is well
      // above the ceiling and must be accepted+clamped, not rejected.
      const within = message({
        id: 'within',
        timestamp: new Date(now - 3 * 24 * 60 * 60_000).toISOString(),
      });
      const beyond = message({
        id: 'beyond',
        timestamp: new Date(now - 10 * 24 * 60 * 60_000).toISOString(),
      });
      const stub = makeMailbox();
      stub.query.mockResolvedValueOnce([within, beyond]);

      const response = await handle({
        mailbox: stub.mailbox,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/query?sinceMs=10000000000', // ~115 days
          body: { to: 'agent-b' },
        }),
      });
      expect(response.status).toBe(200);
      const payload = response.json() as { data: MailboxMessage[]; count: number };
      // Only the 3-day-old message survives the 7-day ceiling; the
      // 10-day-old message is correctly filtered out by the clamped value.
      expect(payload.count).toBe(1);
      expect(payload.data[0]?.id).toBe('within');
    } finally {
      vi.useRealTimers();
    }
  });
  it('tags HTTP agent/client registrations and defaults external session ids', async () => {
    const stub = makeMailbox();
    const agent = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/agents/register',
        body: {
          agentId: 'external-agent',
          name: 'External Agent',
          pid: 123,
          role: 'reviewer',
        },
      }),
    });
    const client = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/register-client',
        body: { clientId: 'external-client', name: 'External Client', pid: 456 },
      }),
    });

    expect(agent.status).toBe(200);
    expect(client.status).toBe(200);
    expect(stub.registerAgent).toHaveBeenCalledWith({
      agentId: 'external-agent',
      sessionId: 'external',
      name: 'External Agent',
      pid: 123,
      role: 'reviewer',
      source: 'http',
    });
    expect(stub.registerClient).toHaveBeenCalledWith({
      clientId: 'external-client',
      sessionId: 'external',
      name: 'External Client',
      pid: 456,
      source: 'http',
    });
  });

  it('maps unknown routes to 404 and mailbox failures to structured 500 responses', async () => {
    const missing = await handle({ request: makeRequest({ url: '/mailbox/missing' }) });
    expect(missing.status).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const stub = makeMailbox();
    stub.getAgentStatuses.mockRejectedValueOnce(new Error('registry unavailable'));
    const failed = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({ url: '/mailbox/agents' }),
    });
    expect(failed.status).toBe(500);
    expect(failed.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'registry unavailable' },
    });
  });

  it('filters leader-only broadcast SSE events for a self-scoped non-leader actor', async () => {
    const eventEmitter = new MailboxEventEmitter();
    const request = makeRequest({ method: 'GET', url: '/mailbox/events', keepOpen: true });
    const response = makeResponse();
    const router = createMailboxHttpRouter({
      mailbox: makeMailbox().mailbox,
      eventEmitter,
      authorize: () => ({
        allowed: true,
        actor: {
          actorId: 'worker-1',
          projectId: 'project-1',
          kind: 'agent',
          role: 'worker',
          capabilities: new Set(['mail.events.self']),
          authMode: 'identity-token',
          recipientAliases: new Set<string>(),
        },
      }),
    });

    await router.handle(request, response.response);
    eventEmitter.emit({
      type: 'message.sent',
      messageId: 'leaders-only',
      from: 'leader-1',
      to: '*',
      audience: 'leaders',
      timestamp: '2026-07-16T00:00:00.000Z',
    });
    eventEmitter.emit({
      type: 'message.sent',
      messageId: 'all-agents',
      from: 'leader-1',
      to: '*',
      audience: 'all',
      timestamp: '2026-07-16T00:00:01.000Z',
    });

    expect(response.text()).not.toContain('leaders-only');
    expect(response.text()).toContain('all-agents');
    router.close();
  });

  it('reports active SSE streams via hasActiveStreams() and clears on close()', async () => {
    const eventEmitter = new MailboxEventEmitter();
    const request = makeRequest({ method: 'GET', url: '/mailbox/events', keepOpen: true });
    const response = makeResponse();
    const router = createMailboxHttpRouter({
      mailbox: makeMailbox().mailbox,
      eventEmitter,
      authorize: () => ({ allowed: true, rateLimitKey: 'has-active-streams' }),
    });

    // No stream open yet — hosts may evict the router.
    expect(router.hasActiveStreams()).toBe(false);
    await router.handle(request, response.response);
    // A live SSE stream must block eviction of the hosting gateway.
    expect(router.hasActiveStreams()).toBe(true);
    router.close();
    expect(router.hasActiveStreams()).toBe(false);
  });

  it('applies self and audience visibility to documented nested SSE envelopes', async () => {
    const eventEmitter = new MailboxEventEmitter();
    const request = makeRequest({ method: 'GET', url: '/mailbox/events', keepOpen: true });
    const response = makeResponse();
    const router = createMailboxHttpRouter({
      mailbox: makeMailbox().mailbox,
      eventEmitter,
      authorize: () => ({
        allowed: true,
        actor: {
          actorId: 'worker-1',
          projectId: 'project-1',
          kind: 'agent',
          role: 'worker',
          capabilities: new Set(['mail.events.self']),
          authMode: 'identity-token',
          recipientAliases: new Set(['worker']),
        },
      }),
    });

    await router.handle(request, response.response);
    eventEmitter.emit({
      messageSent: {
        messageId: 'nested-other-recipient',
        from: 'leader-1',
        to: 'other-worker',
        audience: 'all',
        timestamp: '2026-07-16T00:00:00.000Z',
      },
    } as never);
    eventEmitter.emit({
      ackUpdated: {
        messageId: 'nested-leaders-only',
        from: 'leader-1',
        to: '*',
        audience: 'leaders',
        timestamp: '2026-07-16T00:00:01.000Z',
      },
    } as never);
    eventEmitter.emit({
      messageSent: {
        messageId: 'nested-visible',
        from: 'leader-1',
        to: 'worker',
        audience: 'all',
        timestamp: '2026-07-16T00:00:02.000Z',
      },
    } as never);
    eventEmitter.emit({
      payload: {
        messageId: 'undocumented-payload',
        from: 'leader-1',
        to: 'worker',
        audience: 'all',
        timestamp: '2026-07-16T00:00:03.000Z',
      },
    } as never);

    expect(response.text()).not.toContain('nested-other-recipient');
    expect(response.text()).not.toContain('nested-leaders-only');
    expect(response.text()).not.toContain('undocumented-payload');
    expect(response.text()).toContain('nested-visible');
    router.close();
  });

  it('revalidates a credential before SSE delivery and closes a revoked stream', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-sse-credential-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'worker@sess-1',
        projectId: 'project-1',
        kind: 'agent',
        capabilities: ['mail.events.self'],
        ttlMs: 60_000,
      });
      const eventEmitter = new MailboxEventEmitter();
      const request = makeRequest({
        method: 'GET',
        url: '/mailbox/events',
        keepOpen: true,
        headers: { authorization: `Credential ${credential.credentialId}:${secret}` },
      });
      const response = makeResponse();
      const router = createMailboxHttpRouter({
        mailbox: makeMailbox().mailbox,
        eventEmitter,
        credentialStore: store,
        projectId: 'project-1',
      });

      await router.handle(request, response.response);
      expect(eventEmitter.subscriberCount).toBe(1);
      const externalStore = openCredentialStore(dir);
      await externalStore.load();
      await externalStore.revoke(credential.credentialId);
      eventEmitter.emit({
        type: 'message.sent',
        messageId: 'after-revoke',
        from: 'leader@sess-1',
        to: 'worker@sess-1',
        timestamp: '2026-07-16T00:00:00.000Z',
      });

      await vi.waitFor(() => expect(response.ended).toBe(true));
      expect(response.text()).not.toContain('after-revoke');
      expect(eventEmitter.subscriberCount).toBe(0);
      router.close();
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('preserves SSE event order while credential revalidation is asynchronous', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-sse-order-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'worker@sess-1',
        projectId: 'project-1',
        kind: 'agent',
        capabilities: ['mail.events.self'],
        ttlMs: 60_000,
      });
      const eventEmitter = new MailboxEventEmitter();
      const request = makeRequest({
        method: 'GET',
        url: '/mailbox/events',
        keepOpen: true,
        headers: { authorization: `Credential ${credential.credentialId}:${secret}` },
      });
      const response = makeResponse();
      const router = createMailboxHttpRouter({
        mailbox: makeMailbox().mailbox,
        eventEmitter,
        credentialStore: store,
        projectId: 'project-1',
      });
      await router.handle(request, response.response);

      const verifyPersisted = store.verifyPersisted.bind(store);
      let validations = 0;
      vi.spyOn(store, 'verifyPersisted').mockImplementation(async (...args) => {
        validations++;
        if (validations === 1) await new Promise((resolve) => setTimeout(resolve, 25));
        return verifyPersisted(...args);
      });
      eventEmitter.emit({
        type: 'message.sent',
        messageId: 'first',
        from: 'leader',
        to: 'worker@sess-1',
        timestamp: '2026-07-16T00:00:00.000Z',
      });
      eventEmitter.emit({
        type: 'message.sent',
        messageId: 'second',
        from: 'leader',
        to: 'worker@sess-1',
        timestamp: '2026-07-16T00:00:01.000Z',
      });

      await vi.waitFor(() => expect(response.text()).toContain('second'));
      expect(response.text().indexOf('first')).toBeLessThan(response.text().indexOf('second'));
      router.close();
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('does not write an event when the stream closes during credential revalidation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-sse-close-race-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'worker@sess-1',
        projectId: 'project-1',
        kind: 'agent',
        capabilities: ['mail.events.self'],
        ttlMs: 60_000,
      });
      const eventEmitter = new MailboxEventEmitter();
      const request = makeRequest({
        method: 'GET',
        url: '/mailbox/events',
        keepOpen: true,
        headers: { authorization: `Credential ${credential.credentialId}:${secret}` },
      });
      const response = makeResponse();
      const router = createMailboxHttpRouter({
        mailbox: makeMailbox().mailbox,
        eventEmitter,
        credentialStore: store,
        projectId: 'project-1',
      });
      await router.handle(request, response.response);

      const verifyPersisted = store.verifyPersisted.bind(store);
      let releaseValidation: () => void = () => undefined;
      const validationGate = new Promise<void>((resolve) => {
        releaseValidation = resolve;
      });
      const validationStarted = vi.fn();
      vi.spyOn(store, 'verifyPersisted').mockImplementation(async (...args) => {
        validationStarted();
        await validationGate;
        return verifyPersisted(...args);
      });

      eventEmitter.emit({
        type: 'message.sent',
        messageId: 'pending-at-close',
        from: 'leader',
        to: 'worker@sess-1',
        timestamp: '2026-07-16T00:00:00.000Z',
      });
      await vi.waitFor(() => expect(validationStarted).toHaveBeenCalledOnce());
      router.close();
      releaseValidation();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(response.ended).toBe(true);
      expect(response.text()).not.toContain('pending-at-close');
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('streams events over SSE and router.close tears down subscribers idempotently', async () => {
    const eventEmitter = new MailboxEventEmitter();
    const request = makeRequest({ method: 'GET', url: '/mailbox/events', keepOpen: true });
    const response = makeResponse();
    const router = createMailboxHttpRouter({ mailbox: makeMailbox().mailbox, eventEmitter });

    await router.handle(request, response.response);
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
    });
    expect(response.text()).toContain(': connected');
    expect(eventEmitter.subscriberCount).toBe(1);

    eventEmitter.emit({
      type: 'message.sent',
      messageId: 'evt-1',
      from: 'external-a',
      to: 'agent-b',
      timestamp: '2026-07-16T00:00:00.000Z',
    });
    expect(response.text()).toContain('"type":"message.sent"');
    expect(response.text()).toContain('"messageId":"evt-1"');

    router.close();
    router.close();
    expect(response.ended).toBe(true);
    expect(eventEmitter.subscriberCount).toBe(0);
  });
});

describe('mailbox HTTP router — validator mutation matrix', () => {
  // Each row starts from a known-valid body, alters **one** field
  // (delete it, replace it with the wrong type, or use an out-of-domain
  // value), and asserts that the router returns a 400 VALIDATION_ERROR
  // **before** any Mailbox method is invoked.

  function errorEnvelope(body: unknown): { code: string; message: string } | null {
    if (!body || typeof body !== 'object') return null;
    const candidate = body as { error?: { code?: unknown; message?: unknown } };
    if (!candidate.error || typeof candidate.error !== 'object') return null;
    if (typeof candidate.error.code !== 'string') return null;
    if (typeof candidate.error.message !== 'string') return null;
    return { code: candidate.error.code, message: candidate.error.message };
  }

  async function expectMutationRejected(input: {
    method?: string;
    route: string;
    validBody: object;
    mutate: (body: Record<string, unknown>) => void;
    rejectContains: string;
    assertNoCall?: keyof ReturnType<typeof makeMailbox>;
  }): Promise<void> {
    const stub = makeMailbox();
    const body: Record<string, unknown> = JSON.parse(JSON.stringify(input.validBody));
    input.mutate(body);
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: input.method ?? 'POST',
        url: input.route,
        body,
      }),
    });
    expect(response.status).toBe(400);
    const envelope = errorEnvelope(response.json());
    expect(envelope).not.toBeNull();
    expect(envelope?.code).toBe('VALIDATION_ERROR');
    expect(envelope?.message).toContain(input.rejectContains);
    if (input.assertNoCall) {
      expect(stub[input.assertNoCall]).not.toHaveBeenCalled();
    }
  }

  it.each(['string', 'number', 'true', 'null', 'array'])(
    'rejects non-object body (sent as %s) on /mailbox/send',
    async (kind) => {
      const stub = makeMailbox();
      const scalar: unknown =
        kind === 'number' ? 1 : kind === 'true' ? true : kind === 'array' ? [] : kind;
      const response = await handle({
        mailbox: stub.mailbox,
        request: makeRequest({ method: 'POST', url: '/mailbox/send', body: scalar }),
      });
      expect(response.status).toBe(400);
      const envelope = errorEnvelope(response.json());
      expect(envelope?.code).toBe('VALIDATION_ERROR');
      expect(stub.send).not.toHaveBeenCalled();
    },
  );

  it.each([
    '/mailbox/send',
    '/mailbox/query',
    '/mailbox/check',
    '/mailbox/ack',
    '/mailbox/ack-many',
    '/mailbox/unread-count',
    '/mailbox/agents/register',
    '/mailbox/agents/heartbeat',
    '/mailbox/register-client',
    '/mailbox/heartbeat',
  ])('rejects raw invalid JSON on %s', async (route) => {
    const response = await handle({
      request: makeRequest({ method: 'POST', url: route, rawBody: '{broken' }),
    });
    expect(response.status).toBe(400);
    const envelope = errorEnvelope(response.json());
    expect(envelope?.code).toBe('VALIDATION_ERROR');
  });

  it.each([0, -1, 1.5, '60', false, []])('rejects invalid ttlMs (sent as %s)', async (value) => {
    await expectMutationRejected({
      route: '/mailbox/send',
      validBody: {
        from: 'external-a',
        to: 'agent-b',
        type: 'note',
        subject: 'subject',
        body: 'body',
        priority: 'normal',
      },
      mutate: (body) => {
        body.ttlMs = value;
      },
      rejectContains: 'field "ttlMs"',
      assertNoCall: 'send',
    });
  });

  // 501 / 1e9 are the ceiling cases: `limit` used to be validated only as "a
  // positive integer", and the router passes it through to a query that is
  // fanned out across every recipient address the actor answers to, with the
  // store pre-limiting in SQL. Nothing downstream clamped it, so one request
  // could ask for the whole table once per address.
  it.each([0, -1, 1.5, '20', 501, 1_000_000_000, Number.MAX_SAFE_INTEGER])(
    'rejects invalid query limit (sent as %s)',
    async (value) => {
      await expectMutationRejected({
        route: '/mailbox/query',
        validBody: {},
        mutate: (body) => {
          body.limit = value;
        },
        rejectContains: 'field "limit"',
        assertNoCall: 'query',
      });
    },
  );

  it.each([0, -1, 1.5, '10', 501, 1_000_000_000])(
    'rejects invalid check limit (sent as %s)',
    async (value) => {
      await expectMutationRejected({
        route: '/mailbox/check',
        validBody: { agentId: 'agent-b' },
        mutate: (body) => {
          body.limit = value;
        },
        rejectContains: 'field "limit"',
        assertNoCall: 'query',
      });
    },
  );

  it('refuses the bare "@session" alias with a 400, not a 500', async () => {
    // `@session` is documented and reaches `normalizeRecipient`, which needs a
    // session id to expand it and throws a bare TypeError without one. That is
    // not a MailboxHttpValidationError, so the router classified it as
    // INTERNAL_ERROR: a documented recipient alias answered with a 500 and a
    // leaked internal message.
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/send',
        body: {
          from: 'external-a',
          to: '@session',
          type: 'note',
          subject: 'subject',
          body: 'body',
        },
      }),
    });
    expect(response.status).toBe(400);
    const envelope = errorEnvelope(response.json());
    expect(envelope?.code).toBe('VALIDATION_ERROR');
    expect(envelope?.message).toContain('"@session"');
    expect(stub.send).not.toHaveBeenCalled();
  });

  it('accepts an explicit "@session:<id>" recipient', async () => {
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/send',
        body: {
          from: 'external-a',
          to: '@session:sess-1',
          type: 'broadcast',
          subject: 'subject',
          body: 'body',
        },
      }),
    });
    expect(response.status).toBe(201);
    expect(stub.send).toHaveBeenCalledWith(expect.objectContaining({ to: '@session:sess-1' }));
  });

  it('accepts a query limit at the ceiling', async () => {
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({ method: 'POST', url: '/mailbox/query', body: { limit: 500 } }),
    });
    expect(response.status).toBe(200);
    expect(stub.query).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }));
  });

  it('rejects an ack-many batch over the ceiling before touching the store', async () => {
    // `ackMany` applies the whole batch inside one `BEGIN IMMEDIATE` with a
    // lookup per entry. Unbounded, a single request could hold the project's
    // only write lock long enough to fail every other surface on busy_timeout.
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/ack-many',
        body: {
          acks: Array.from({ length: 501 }, (_, index) => ({
            messageId: `msg-${index}`,
            readerId: 'agent-b',
          })),
        },
      }),
    });
    expect(response.status).toBe(400);
    const envelope = errorEnvelope(response.json());
    expect(envelope?.code).toBe('VALIDATION_ERROR');
    expect(envelope?.message).toContain('at most 500');
    expect(stub.ackMany).not.toHaveBeenCalled();
  });

  it('accepts an ack-many batch at the ceiling', async () => {
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/ack-many',
        body: {
          acks: Array.from({ length: 500 }, (_, index) => ({
            messageId: `msg-${index}`,
            readerId: 'agent-b',
          })),
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(stub.ackMany).toHaveBeenCalled();
  });

  it.each(['urgent', true, 1])('rejects invalid priority (sent as %s)', async (value) => {
    await expectMutationRejected({
      route: '/mailbox/send',
      validBody: {
        from: 'external-a',
        to: 'agent-b',
        type: 'note',
        subject: 'subject',
        body: 'body',
      },
      mutate: (body) => {
        body.priority = value as never;
      },
      rejectContains: 'priority',
      assertNoCall: 'send',
    });
  });

  it('rejects priority of null (must-not-be-null guard)', async () => {
    // null is explicitly rejected by the `optionalString` body. The
    // validator fails with a `must not be null` message before the
    // enum check would have been consulted.
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/send',
        body: {
          from: 'external-a',
          to: 'agent-b',
          type: 'note',
          subject: 's',
          body: 'b',
          priority: null,
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('"priority" must not be null'),
      },
    });
    expect(stub.send).not.toHaveBeenCalled();
  });

  it.each(['sms', 1, true])('rejects invalid message type (sent as %s)', async (value) => {
    await expectMutationRejected({
      route: '/mailbox/send',
      validBody: {
        from: 'external-a',
        to: 'agent-b',
        type: 'note',
        subject: 'subject',
        body: 'body',
      },
      mutate: (body) => {
        body.type = value as never;
      },
      rejectContains: 'type',
      assertNoCall: 'send',
    });
  });

  it('rejects message type of null (required-string guard)', async () => {
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/send',
        body: {
          from: 'external-a',
          to: 'agent-b',
          type: null,
          subject: 's',
          body: 'b',
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('type') },
    });
    expect(stub.send).not.toHaveBeenCalled();
  });

  it.each([0, -1, 0.5])('rejects invalid agent pid (sent as %s)', async (value) => {
    await expectMutationRejected({
      route: '/mailbox/agents/register',
      validBody: { agentId: 'agent-b', name: 'Agent', pid: 123 },
      mutate: (body) => {
        body.pid = value;
      },
      rejectContains: 'pid',
      assertNoCall: 'registerAgent',
    });
  });

  it('rejects client pid value of 5 (string not allowed)', async () => {
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/register-client',
        body: { clientId: 'tui-1', name: 'TUI', pid: '5' },
      }),
    });
    expect(response.status).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('pid') },
    });
    expect(stub.registerClient).not.toHaveBeenCalled();
  });

  it.each([0, -1, 0.5])('rejects invalid client pid (sent as %s)', async (value) => {
    await expectMutationRejected({
      route: '/mailbox/register-client',
      validBody: { clientId: 'tui-1', name: 'TUI', pid: 456 },
      mutate: (body) => {
        body.pid = value;
      },
      rejectContains: 'pid',
      assertNoCall: 'registerClient',
    });
  });

  it.each([-1, 0.5, '3'])('rejects invalid iterations counter (sent as %s)', async (value) => {
    await expectMutationRejected({
      route: '/mailbox/agents/heartbeat',
      validBody: { agentId: 'agent-b' },
      mutate: (body) => {
        body.iterations = value;
      },
      rejectContains: 'iterations',
      assertNoCall: 'heartbeat',
    });
  });

  it('accepts iterations counter at zero (valid non-negative integer)', async () => {
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/agents/heartbeat',
        body: { agentId: 'agent-b', iterations: 0 },
      }),
    });
    expect(response.status).toBe(200);
    expect(stub.heartbeat).toHaveBeenCalledOnce();
  });

  it.each([-1, 0.5, '3'])('rejects invalid toolCalls counter (sent as %s)', async (value) => {
    await expectMutationRejected({
      route: '/mailbox/agents/heartbeat',
      validBody: { agentId: 'agent-b' },
      mutate: (body) => {
        body.toolCalls = value;
      },
      rejectContains: 'toolCalls',
      assertNoCall: 'heartbeat',
    });
  });

  it('accepts toolCalls counter at zero (valid non-negative integer)', async () => {
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/agents/heartbeat',
        body: { agentId: 'agent-b', toolCalls: 0 },
      }),
    });
    expect(response.status).toBe(200);
    expect(stub.heartbeat).toHaveBeenCalledOnce();
  });

  // Type filter accepts any declared message-type literal string; non-string
  // values are rejected at the type guard, not the enum check.
  it('rejects non-string type filter in /mailbox/query', async () => {
    await expectMutationRejected({
      route: '/mailbox/query',
      validBody: {},
      mutate: (body) => {
        body.type = 1 as never;
      },
      rejectContains: 'field "type"',
      assertNoCall: 'query',
    });
  });

  it.each([
    'leader',
    'fleet',
    'hq',
    'mailbox-bridge',
    'mailbox-bridge-watchdog',
    'tech-stack-consumer',
  ])('rejects reserved sender identity "%s"', async (id) => {
    await expectMutationRejected({
      route: '/mailbox/send',
      validBody: {
        from: 'external-a',
        to: 'agent-b',
        type: 'note',
        subject: 'subject',
        body: 'body',
      },
      mutate: (body) => {
        body.from = `${id}@peer`;
      },
      rejectContains: `reserved internal agent id "${id}"`,
      assertNoCall: 'send',
    });
  });

  it.each([
    'leader',
    'fleet',
    'hq',
    'mailbox-bridge',
    'mailbox-bridge-watchdog',
    'tech-stack-consumer',
  ])('rejects reserved readerId "%s"', async (id) => {
    await expectMutationRejected({
      route: '/mailbox/ack',
      validBody: { messageId: 'msg-1', readerId: 'agent-b' },
      mutate: (body) => {
        body.readerId = `${id}@peer`;
      },
      rejectContains: `reserved internal agent id "${id}"`,
      assertNoCall: 'ack',
    });
  });

  it('rejects missing required fields on /mailbox/ack', async () => {
    for (const remove of ['messageId', 'readerId'] as const) {
      await expectMutationRejected({
        route: '/mailbox/ack',
        validBody: { messageId: 'msg-1', readerId: 'agent-b' },
        mutate: (body) => {
          delete body[remove];
        },
        rejectContains: `field "${remove}" is required`,
        assertNoCall: 'ack',
      });
    }
  });

  it('rejects malformed entry inside /mailbox/ack-many acks array', async () => {
    await expectMutationRejected({
      route: '/mailbox/ack-many',
      validBody: { acks: [{ messageId: 'msg-1', readerId: 'agent-b' }] },
      mutate: (body) => {
        const list = body.acks as Array<Record<string, unknown>>;
        list[0]!.readerId = '';
      },
      rejectContains: 'field "readerId" is required',
      assertNoCall: 'ackMany',
    });
  });

  it('rejects non-array acks on /mailbox/ack-many', async () => {
    await expectMutationRejected({
      route: '/mailbox/ack-many',
      validBody: { acks: [] },
      mutate: (body) => {
        body.acks = 'not-an-array';
      },
      rejectContains: 'field "acks" is required (array)',
      assertNoCall: 'ackMany',
    });
  });

  it('rejects empty list acks on /mailbox/ack-many by passing null', async () => {
    await expectMutationRejected({
      route: '/mailbox/ack-many',
      validBody: { acks: [] },
      mutate: (body) => {
        body.acks = null;
      },
      rejectContains: 'field "acks" is required (array)',
      assertNoCall: 'ackMany',
    });
  });

  it('rejects missing forAgentId on /mailbox/unread-count', async () => {
    await expectMutationRejected({
      route: '/mailbox/unread-count',
      validBody: { forAgentId: 'agent-b' },
      mutate: (body) => {
        delete body.forAgentId;
      },
      rejectContains: 'forAgentId',
      assertNoCall: 'unreadCount',
    });
  });

  it('rejects non-boolean incompleteOnly on /mailbox/query', async () => {
    await expectMutationRejected({
      route: '/mailbox/query',
      validBody: {},
      mutate: (body) => {
        body.incompleteOnly = 'true';
      },
      rejectContains: 'incompleteOnly',
      assertNoCall: 'query',
    });
  });

  it('rejects unknown minPriority on /mailbox/query', async () => {
    await expectMutationRejected({
      route: '/mailbox/query',
      validBody: {},
      mutate: (body) => {
        body.minPriority = 'urgent';
      },
      rejectContains: 'field "minPriority" must be one of',
      assertNoCall: 'query',
    });
  });
});

describe('mailbox HTTP authorization helpers', () => {
  it('accepts only the exact authorization value and returns it as the rate-limit key', () => {
    const scheme = ['Bea', 'rer'].join('');
    const expected = ['fixture', 'mailbox', 'value'].join('-');
    expect(
      authorizeMailboxBearerToken(
        makeRequest({ headers: { authorization: `${scheme} ${expected}` } }),
        expected,
      ),
    ).toEqual({ allowed: true, rateLimitKey: expected });
    expect(
      authorizeMailboxBearerToken(
        makeRequest({ headers: { authorization: `${scheme} ${expected.toUpperCase()}` } }),
        expected,
      ),
    ).toEqual({ allowed: false });
    expect(authorizeMailboxBearerToken(makeRequest(), expected)).toEqual({ allowed: false });
  });

  it('resolves the persisted principal and capability set for a valid credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-credential-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'agent-credential',
        projectId: 'test-project',
        kind: 'agent',
        capabilities: ['mail.send.informational', 'mail.read.self'],
        ttlMs: 60_000,
      });

      const decision = await authorizePersistedMailboxCredential(
        makeRequest({
          headers: { authorization: `Credential ${credential.credentialId}:${secret}` },
        }),
        store,
      );

      expect(decision).toMatchObject({
        allowed: true,
        rateLimitKey: `cred:${credential.credentialId}`,
        actor: {
          actorId: 'agent-credential',
          kind: 'agent',
          authMode: 'identity-token',
        },
      });
      if (!decision.allowed || !('actor' in decision)) {
        throw new Error('expected successful credential authorization');
      }
      expect(decision.actor.capabilities).toBeInstanceOf(Set);
      expect(decision.actor.capabilities.has('mail.read.self')).toBe(true);
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('uses credentialStore for router authorization when no custom authorizer is supplied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-credential-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'service-credential',
        projectId: 'test-project',
        kind: 'service',
        capabilities: ['mail.presence.read'],
        ttlMs: 60_000,
      });

      const accepted = await handle({
        credentialStore: store,
        request: makeRequest({
          url: '/mailbox/agents',
          headers: { authorization: `Credential ${credential.credentialId}:${secret}` },
        }),
      });
      const rejected = await handle({
        credentialStore: store,
        request: makeRequest({
          url: '/mailbox/agents',
          headers: { authorization: `Credential ${credential.credentialId}:wrong-secret` },
        }),
      });
      const missing = await handle({
        credentialStore: store,
        request: makeRequest({ url: '/mailbox/agents' }),
      });

      expect(accepted.status).toBe(200);
      expect(rejected.status).toBe(401);
      expect(missing.status).toBe(401);
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('rejects ordinary requests after another store revokes the credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-external-revoke-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'credential-agent',
        projectId: 'test-project',
        kind: 'agent',
        capabilities: ['mail.presence.read'],
        ttlMs: 60_000,
      });
      const authorization = `Credential ${credential.credentialId}:${secret}`;
      const stub = makeMailbox();

      const accepted = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({ url: '/mailbox/agents', headers: { authorization } }),
      });
      expect(accepted.status).toBe(200);
      expect(stub.getAgentStatuses).toHaveBeenCalledTimes(1);

      const externalStore = openCredentialStore(dir);
      await externalStore.load();
      await externalStore.revoke(credential.credentialId);
      stub.getAgentStatuses.mockClear();

      const rejected = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({ url: '/mailbox/agents', headers: { authorization } }),
      });
      expect(rejected.status).toBe(401);
      expect(stub.getAgentStatuses).not.toHaveBeenCalled();
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('revalidates cached custom credential authorization before ordinary dispatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-custom-external-revoke-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'credential-agent',
        projectId: 'test-project',
        kind: 'agent',
        capabilities: ['mail.presence.read'],
        ttlMs: 60_000,
      });
      const authorization = `Credential ${credential.credentialId}:${secret}`;
      const stub = makeMailbox();
      const authorize = (request: IncomingMessage) =>
        authorizePersistedMailboxCredential(request, store);

      const accepted = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        authorize,
        request: makeRequest({ url: '/mailbox/agents', headers: { authorization } }),
      });
      expect(accepted.status).toBe(200);
      expect(stub.getAgentStatuses).toHaveBeenCalledTimes(1);

      const externalStore = openCredentialStore(dir);
      await externalStore.load();
      await externalStore.revoke(credential.credentialId);
      stub.getAgentStatuses.mockClear();

      const rejected = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        authorize,
        request: makeRequest({ url: '/mailbox/agents', headers: { authorization } }),
      });
      expect(rejected.status).toBe(401);
      expect(stub.getAgentStatuses).not.toHaveBeenCalled();
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('uses persisted capabilities instead of a custom authorizer stale snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-custom-capabilities-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'credential-agent',
        projectId: 'test-project',
        kind: 'agent',
        capabilities: ['mail.read.self'],
        ttlMs: 60_000,
      });
      const authorization = `Credential ${credential.credentialId}:${secret}`;
      const stub = makeMailbox();

      const response = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        authorize: () => ({
          allowed: true,
          actor: {
            actorId: 'credential-agent',
            projectId: 'test-project',
            kind: 'agent',
            capabilities: new Set(['mail.presence.read']),
            authMode: 'identity-token',
            recipientAliases: new Set(['credential-agent']),
          },
        }),
        request: makeRequest({ url: '/mailbox/agents', headers: { authorization } }),
      });

      expect(response.status).toBe(403);
      expect(stub.getAgentStatuses).not.toHaveBeenCalled();
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('enforces credential capabilities and derives the sender from the principal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-principal-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'credential-agent',
        projectId: 'test-project',
        kind: 'agent',
        capabilities: ['mail.send.informational'],
        ttlMs: 60_000,
      });
      const authorization = `Credential ${credential.credentialId}:${secret}`;
      const stub = makeMailbox();

      const sent = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/send',
          headers: { authorization },
          body: {
            to: 'recipient',
            type: 'note',
            subject: 'subject',
            body: 'body',
          },
        }),
      });
      const denied = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/query',
          headers: { authorization },
          body: {},
        }),
      });

      expect(sent.status).toBe(201);
      expect(stub.send).toHaveBeenCalledWith(expect.objectContaining({ from: 'credential-agent' }));
      expect(denied.status).toBe(403);
      expect(stub.query).not.toHaveBeenCalled();
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('enforces project scope before dispatching a credential-authenticated request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-project-scope-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'credential-agent',
        projectId: 'project-a',
        kind: 'agent',
        capabilities: ['mail.presence.read'],
        ttlMs: 60_000,
      });
      const stub = makeMailbox();

      const response = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        projectId: 'project-b',
        request: makeRequest({
          url: '/mailbox/agents',
          headers: { authorization: `Credential ${credential.credentialId}:${secret}` },
        }),
      });

      expect(response.status).toBe(403);
      expect(response.json()).toEqual({
        error: { code: 'FORBIDDEN', message: 'credential is scoped to a different project' },
      });
      expect(stub.getAgentStatuses).not.toHaveBeenCalled();
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('requires ack capability when credential check uses its default mark-read behavior', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-check-capability-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'credential-agent',
        projectId: 'test-project',
        kind: 'agent',
        capabilities: ['mail.read.self'],
        ttlMs: 60_000,
      });
      const authorization = `Credential ${credential.credentialId}:${secret}`;
      const stub = makeMailbox();

      const denied = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/check',
          headers: { authorization },
          body: {},
        }),
      });
      const completionDenied = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/check',
          headers: { authorization },
          body: { markRead: false, completed: true, outcome: 'handled' },
        }),
      });
      const readOnly = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/check',
          headers: { authorization },
          body: { markRead: false },
        }),
      });

      expect(denied.status).toBe(403);
      expect(completionDenied.status).toBe(403);
      expect(readOnly.status).toBe(200);
      expect(stub.query).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'credential-agent', unreadBy: 'credential-agent' }),
      );
      expect(stub.ackMany).not.toHaveBeenCalled();
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('derives ack and self-query identities from the credential principal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-self-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'credential-agent',
        projectId: 'test-project',
        kind: 'agent',
        capabilities: ['mail.read.self', 'mail.ack.self'],
        ttlMs: 60_000,
      });
      const authorization = `Credential ${credential.credentialId}:${secret}`;
      const stub = makeMailbox();
      stub.query.mockResolvedValue([
        {
          ...message({
            id: 'msg-1',
            to: 'credential-agent',
            readBy: {
              'credential-agent': '2026-07-16T00:00:30.000Z',
              'other-agent': '2026-07-16T00:01:00.000Z',
            },
            completed: true,
            completedBy: 'other-agent',
            completedAt: '2026-07-16T00:02:00.000Z',
            outcome: 'other actor legacy outcome',
          }),
          recipientState: {
            'credential-agent': {
              actorId: 'credential-agent',
              readAt: '2026-07-16T00:00:30.000Z',
              completedAt: '2026-07-16T00:01:30.000Z',
              outcome: 'my private outcome',
            },
            'other-agent': {
              actorId: 'other-agent',
              readAt: '2026-07-16T00:01:00.000Z',
              completedAt: '2026-07-16T00:02:00.000Z',
              outcome: 'other private outcome',
            },
          },
        },
      ]);
      const legacyCompleted = {
        ...message({
          id: 'msg-1',
          to: 'credential-agent',
          completed: true,
          completedBy: 'credential-agent',
          completedAt: '2026-07-16T00:03:00.000Z',
          outcome: 'another recipient outcome',
        }),
        recipientState: {
          'credential-agent': {
            actorId: 'credential-agent',
            completedAt: '2026-07-16T00:03:00.000Z',
          },
        },
      };
      stub.ack.mockResolvedValue(legacyCompleted);
      stub.ackMany.mockResolvedValue([legacyCompleted]);

      const queried = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/query',
          headers: { authorization },
          body: { to: 'credential-agent', unreadBy: 'other-agent' },
        }),
      });
      const checked = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/check',
          headers: { authorization },
          body: { markRead: false },
        }),
      });
      const acked = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/ack',
          headers: { authorization },
          body: { messageId: 'msg-1' },
        }),
      });
      const batchAcked = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/ack-many',
          headers: { authorization },
          body: { acks: [{ messageId: 'msg-1', completed: true, outcome: 'handled' }] },
        }),
      });
      const rejectedBatch = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/ack-many',
          headers: { authorization },
          body: { acks: [{ messageId: 'not-visible', completed: true }] },
        }),
      });

      expect(queried.status).toBe(200);
      expect(stub.query).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'credential-agent',
          unreadBy: 'credential-agent',
          includeReceiptState: true,
        }),
      );
      // The per-actor visibility check behind ack / ack-many is id-scoped: it
      // asks about exactly the messages being acked. It used to answer the
      // same question by listing the actor's entire mailbox
      // (`limit: Number.MAX_SAFE_INTEGER`, no `unreadBy`, so the store also
      // re-read the agent registry) once per eligible recipient address, on
      // every single ack.
      expect(stub.query).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'credential-agent',
          ids: ['msg-1'],
          limit: 1,
        }),
      );
      expect(stub.query).toHaveBeenCalledWith(
        expect.objectContaining({ ids: ['not-visible'], limit: 1 }),
      );
      // Still a non-`unreadBy` read (visibility is not an unread question) —
      // but now a bounded one. No read this route issues may be unbounded:
      // either it omits `limit` (the store's own default of 50 applies) or it
      // states one within the request ceiling.
      expect(stub.query.mock.calls.some(([query]) => query.unreadBy === undefined)).toBe(true);
      expect(
        stub.query.mock.calls.every(([query]) => query.limit === undefined || query.limit <= 500),
      ).toBe(true);
      const projected = (queried.json() as { data: Array<Record<string, unknown>> }).data[0];
      expect(projected).toMatchObject({
        readByMe: true,
        completedByMe: true,
        myOutcome: 'my private outcome',
      });
      expect(projected).not.toHaveProperty('recipientState');
      expect(projected).not.toHaveProperty('readBy');
      expect(projected).not.toHaveProperty('completedBy');
      expect(projected).not.toHaveProperty('completedAt');
      expect(projected).not.toHaveProperty('outcome');
      expect(JSON.stringify(projected)).not.toContain('other private outcome');
      expect(checked.status).toBe(200);
      expect(checked.json()).toMatchObject({
        data: [
          {
            readByMe: true,
            completedByMe: true,
            myOutcome: 'my private outcome',
          },
        ],
      });
      expect(acked.status).toBe(200);
      expect(stub.ack).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'msg-1', readerId: 'credential-agent' }),
      );
      expect(acked.json()).toMatchObject({
        updated: {
          completedByMe: true,
        },
      });
      expect((acked.json() as { updated: Record<string, unknown> }).updated).not.toHaveProperty(
        'myOutcome',
      );
      expect(batchAcked.status).toBe(200);
      expect(batchAcked.json()).toMatchObject({
        updated: [
          {
            completedByMe: true,
          },
        ],
      });
      expect(
        (batchAcked.json() as { updated: Array<Record<string, unknown>> }).updated[0],
      ).not.toHaveProperty('myOutcome');
      expect(stub.ackMany).toHaveBeenCalledWith({
        acks: [
          expect.objectContaining({
            messageId: 'msg-1',
            readerId: 'credential-agent',
            completed: true,
            outcome: 'handled',
          }),
        ],
      });
      expect(rejectedBatch.status).toBe(404);
      expect(stub.ackMany).toHaveBeenCalledTimes(1);
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('unions exact, alias, and session recipients without forcing unread filtering', async () => {
    const stub = makeMailbox();
    const visibleByRecipient: Record<string, MailboxMessage[]> = {
      'worker@sess-1': [message({ id: 'direct', to: 'worker@sess-1' })],
      worker: [message({ id: 'alias', to: 'worker' })],
      '@session:sess-1': [message({ id: 'session', to: '@session:sess-1' })],
    };
    stub.query.mockImplementation(async (query) => visibleByRecipient[query.to ?? ''] ?? []);
    const actor = {
      actorId: 'worker@sess-1',
      projectId: 'test-project',
      kind: 'agent' as const,
      role: 'worker',
      capabilities: new Set(['mail.read.self'] as const),
      authMode: 'identity-token' as const,
      recipientAliases: new Set(['worker']),
      sessionId: 'sess-1',
    };

    const response = await handle({
      mailbox: stub.mailbox,
      authorize: () => ({ allowed: true, actor }),
      request: makeRequest({ method: 'POST', url: '/mailbox/query', body: {} }),
    });

    expect(response.status).toBe(200);
    expect((response.json() as { data: MailboxMessage[] }).data.map(({ id }) => id)).toEqual([
      'direct',
      'alias',
      'session',
    ]);
    expect(stub.query).toHaveBeenCalledTimes(3);
    for (const [query] of stub.query.mock.calls) {
      expect(query.unreadBy).toBeUndefined();
      expect(query.includeReceiptState).toBe(true);
    }

    const unreadResponse = await handle({
      mailbox: stub.mailbox,
      authorize: () => ({ allowed: true, actor }),
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/query',
        body: { unreadBy: 'spoofed-reader' },
      }),
    });
    expect(unreadResponse.status).toBe(200);
    for (const [query] of stub.query.mock.calls.slice(3)) {
      expect(query.unreadBy).toBe('worker@sess-1');
      expect(query.readerRole).toBe('worker');
    }

    stub.query.mockClear();
    const incompleteResponse = await handle({
      mailbox: stub.mailbox,
      authorize: () => ({ allowed: true, actor }),
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/query',
        body: { incompleteOnly: true },
      }),
    });
    expect(incompleteResponse.status).toBe(200);
    expect(stub.query).toHaveBeenCalledTimes(3);
    for (const [query] of stub.query.mock.calls) {
      expect(query.unreadBy).toBe('worker@sess-1');
      expect(query.readerRole).toBe('worker');
      expect(query.incompleteOnly).toBe(true);
    }
  });

  it('counts credential unread mail across exact, alias, and session recipients', async () => {
    const stub = makeMailbox();
    const broadcast = message({ id: 'broadcast', to: '*' });
    const completedForActor = {
      ...message({ id: 'completed-for-actor', to: 'worker' }),
      recipientState: {
        'worker@sess-1': {
          actorId: 'worker@sess-1',
          completedAt: '2026-07-16T00:02:00.000Z',
        },
      },
    };
    const completedForSomeoneElse = {
      ...message({ id: 'completed-for-someone-else', to: 'worker' }),
      recipientState: {
        'other-worker': {
          actorId: 'other-worker',
          completedAt: '2026-07-16T00:03:00.000Z',
        },
      },
    };
    const visibleByRecipient: Record<string, MailboxMessage[]> = {
      'worker@sess-1': [message({ id: 'direct', to: 'worker@sess-1' }), broadcast],
      worker: [
        message({ id: 'alias', to: 'worker' }),
        broadcast,
        completedForActor,
        completedForSomeoneElse,
      ],
      '@session:sess-1': [message({ id: 'session', to: '@session:sess-1' }), broadcast],
    };
    stub.query.mockImplementation(async (query) => visibleByRecipient[query.to ?? ''] ?? []);
    const actor = {
      actorId: 'worker@sess-1',
      projectId: 'test-project',
      kind: 'agent' as const,
      role: 'worker',
      capabilities: new Set(['mail.read.self'] as const),
      authMode: 'identity-token' as const,
      recipientAliases: new Set(['worker']),
      sessionId: 'sess-1',
    };

    const response = await handle({
      mailbox: stub.mailbox,
      authorize: () => ({ allowed: true, actor }),
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/unread-count',
        body: { forAgentId: 'spoofed-reader' },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ count: 5 });
    expect(stub.unreadCount).not.toHaveBeenCalled();
    expect(stub.query).toHaveBeenCalledTimes(3);
    for (const [query] of stub.query.mock.calls) {
      expect(query).toMatchObject({
        unreadBy: 'worker@sess-1',
        readerRole: 'worker',
        includeReceiptState: true,
        limit: Number.MAX_SAFE_INTEGER,
      });
      expect(query.incompleteOnly).toBeUndefined();
    }
  }, 5_000);

  it('rejects self queries for recipient forms outside the trusted actor context', async () => {
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      authorize: () => ({
        allowed: true,
        actor: {
          actorId: 'worker@sess-1',
          projectId: 'test-project',
          kind: 'agent',
          role: 'worker',
          capabilities: new Set(['mail.read.self']),
          authMode: 'identity-token',
          recipientAliases: new Set(['worker']),
          sessionId: 'sess-1',
        },
      }),
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/query',
        body: { to: 'other-worker' },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ data: [], count: 0 });
    expect(stub.query).not.toHaveBeenCalled();
  });

  it('binds receipt state to broad readers that lack receipt-admin capability', async () => {
    const stub = makeMailbox();
    stub.query.mockResolvedValue([
      {
        ...message({ id: 'aggregate', to: '*' }),
        recipientState: {
          operator: { actorId: 'operator', readAt: '2026-07-16T00:00:30.000Z' },
          victim: { actorId: 'victim', completedAt: '2026-07-16T00:01:00.000Z' },
        },
      },
    ]);
    const response = await handle({
      mailbox: stub.mailbox,
      authorize: () => ({
        allowed: true,
        actor: {
          actorId: 'operator',
          projectId: 'test-project',
          kind: 'operator',
          capabilities: new Set(['mail.read.all']),
          authMode: 'identity-token',
          recipientAliases: new Set<string>(),
        },
      }),
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/query',
        body: { unreadBy: 'victim', incompleteOnly: true },
      }),
    });
    expect(response.status).toBe(200);
    expect(stub.query).toHaveBeenCalledWith(
      expect.objectContaining({
        unreadBy: 'operator',
        incompleteOnly: true,
        includeReceiptState: true,
      }),
    );
    const projected = (response.json() as { data: Array<Record<string, unknown>> }).data[0];
    expect(projected).toMatchObject({ readByMe: true, completedByMe: false });
    expect(projected).not.toHaveProperty('recipientState');
  });

  it('allows receipt administrators to retrieve folded aggregate receipt state', async () => {
    const stub = makeMailbox();
    const aggregate = {
      ...message({ id: 'aggregate', to: '*' }),
      recipientState: {
        worker: { actorId: 'worker', readAt: '2026-07-16T00:00:30.000Z' },
      },
      legacyGlobalCompletion: false,
    };
    stub.query.mockResolvedValue([aggregate]);

    const response = await handle({
      mailbox: stub.mailbox,
      authorize: () => ({
        allowed: true,
        actor: {
          actorId: 'operator',
          projectId: 'test-project',
          kind: 'operator',
          capabilities: new Set(['mail.read.all', 'mail.admin.receipts']),
          authMode: 'identity-token',
          recipientAliases: new Set<string>(),
        },
      }),
      request: makeRequest({ method: 'POST', url: '/mailbox/query', body: {} }),
    });

    expect(response.status).toBe(200);
    expect(stub.query).toHaveBeenCalledWith(expect.objectContaining({ includeReceiptState: true }));
    expect(response.json()).toMatchObject({
      data: [{ id: 'aggregate', recipientState: aggregate.recipientState }],
    });
  });

  it('derives v2 completion and outcome on credential query and read-only check paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-v2-projection-'));
    const mailbox = new SqliteMailbox(dir);
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'credential-agent',
        projectId: 'test-project',
        kind: 'agent',
        capabilities: ['mail.read.self'],
        ttlMs: 60_000,
      });
      const authorization = `Credential ${credential.credentialId}:${secret}`;
      const sent = await mailbox.send({
        from: 'sender',
        to: 'credential-agent',
        type: 'ask',
        subject: 'question',
        body: 'answer me',
      });
      await mailbox.ack({
        messageId: sent.id,
        readerId: 'credential-agent',
        read: false,
        completed: true,
        outcome: 'resolved privately',
      });

      const queried = await handle({
        mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/query',
          headers: { authorization },
          body: {},
        }),
      });
      const checked = await handle({
        mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/check',
          headers: { authorization },
          body: { markRead: false },
        }),
      });

      for (const response of [queried, checked]) {
        expect(response.status).toBe(200);
        const projected = (response.json() as { data: Array<Record<string, unknown>> }).data[0];
        expect(projected).toMatchObject({
          id: sent.id,
          readByMe: false,
          completedByMe: true,
          actionRequiredForMe: false,
          myOutcome: 'resolved privately',
        });
        expect(projected).not.toHaveProperty('recipientState');
        expect(projected).not.toHaveProperty('readBy');
        expect(projected).not.toHaveProperty('completed');
      }
    } finally {
      await mailbox.close();
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('preserves legacy global completion when projecting a credential query', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-v1-projection-'));
    // The v1 record goes in through the store's one-shot import of a legacy
    // `_mailbox.jsonl`, so it must be on disk BEFORE the store opens.
    await writeFile(
      join(dir, '_mailbox.jsonl'),
      `${JSON.stringify({
        id: 'legacy-complete',
        from: 'sender',
        to: '*',
        type: 'ask',
        subject: 'legacy question',
        body: 'already handled',
        priority: 'normal',
        timestamp: '2026-07-16T00:00:00.000Z',
        readBy: {},
        completed: true,
        completedBy: 'old-worker',
        completedAt: '2026-07-16T00:01:00.000Z',
      })}\n`,
      'utf8',
    );
    const mailbox = new SqliteMailbox(dir);
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'credential-agent',
        projectId: 'test-project',
        kind: 'agent',
        capabilities: ['mail.read.self'],
        ttlMs: 60_000,
      });
      const response = await handle({
        mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/query?sinceMs=0',
          headers: { authorization: `Credential ${credential.credentialId}:${secret}` },
          body: {},
        }),
      });

      expect(response.status).toBe(200);
      expect(response.json()).toMatchObject({
        data: [
          {
            id: 'legacy-complete',
            completedByMe: false,
            actionRequiredForMe: false,
            legacyGlobalCompletion: true,
          },
        ],
      });
    } finally {
      await mailbox.close();
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('rejects a credential presence registration with a conflicting session claim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-presence-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'credential-agent@credential-session',
        projectId: 'test-project',
        kind: 'agent',
        capabilities: ['mail.presence.register.self'],
        ttlMs: 60_000,
      });
      const authorization = `Credential ${credential.credentialId}:${secret}`;
      const stub = makeMailbox();

      const registered = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/agents/register',
          headers: { authorization },
          body: {
            name: 'Credential Agent',
            pid: 123,
            sessionId: 'another-session',
          },
        }),
      });

      expect(registered.status).toBe(400);
      expect(registered.json()).toMatchObject({
        error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('sessionId') },
      });
      expect(stub.registerAgent).not.toHaveBeenCalled();
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('rejects a credential presence registration with a conflicting role claim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-presence-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'credential-agent@credential-session',
        projectId: 'test-project',
        kind: 'agent',
        capabilities: ['mail.presence.register.self'],
        ttlMs: 60_000,
      });
      const authorization = `Credential ${credential.credentialId}:${secret}`;
      const stub = makeMailbox();

      const registered = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/agents/register',
          headers: { authorization },
          body: {
            name: 'Credential Agent',
            pid: 123,
            role: 'leader',
          },
        }),
      });

      expect(registered.status).toBe(400);
      expect(registered.json()).toMatchObject({
        error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('role') },
      });
      expect(stub.registerAgent).not.toHaveBeenCalled();
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('derives credential presence registration identity and heartbeat agent ID', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-presence-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'credential-agent@credential-session',
        projectId: 'test-project',
        kind: 'agent',
        capabilities: ['mail.presence.register.self', 'mail.presence.heartbeat.self'],
        ttlMs: 60_000,
      });
      const authorization = `Credential ${credential.credentialId}:${secret}`;
      const stub = makeMailbox();

      const registered = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/agents/register',
          headers: { authorization },
          body: { name: 'Credential Agent', pid: 123 },
        }),
      });
      const heartbeat = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/agents/heartbeat',
          headers: { authorization },
          body: { status: 'working', iterations: 1 },
        }),
      });

      expect(registered.status).toBe(200);
      expect(stub.registerAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'credential-agent@credential-session',
          sessionId: 'credential-session',
          role: 'credential-agent',
        }),
      );
      expect(heartbeat.status).toBe(200);
      expect(stub.heartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'credential-agent@credential-session',
          status: 'working',
          iterations: 1,
        }),
      );
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('expires limiter entries after the configured window', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'));
      const limiter = new MailboxHttpRateLimiter(1, 1_000);
      expect(limiter.allow('key')).toBe(true);
      expect(limiter.allow('key')).toBe(false);

      vi.advanceTimersByTime(1_001);
      expect(limiter.allow('key')).toBe(true);
      limiter.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Behaviour matrix for `parseSinceMs` (documented at
 * mailbox-http-router.ts L513-524) plus the silent-ack regression test
 * for `checkMailbox` (mailbox-http-router.ts L775-816). The pre-diff
 * peer reviews converged on the silent-ack bug as the highest-leverage
 * gap; this block locks the L794 filter-before-ack invariant in place.
 */
describe('mailbox HTTP look-back filter (sinceMs / defaultMaxAgeMs)', () => {
  function messagesInRange(now: Date, ages: number[]): MailboxMessage[] {
    return ages.map((ageMs, index) =>
      message({
        id: `msg-${index}`,
        from: 'external-a',
        to: 'agent-b',
        timestamp: new Date(now.getTime() - ageMs).toISOString(),
      }),
    );
  }

  async function queryCall(opts: {
    defaultMaxAgeMs?: number;
    urlSuffix?: string;
    mailboxMsgs?: MailboxMessage[];
  }): Promise<{ response: ResponseRecorder; stub: ReturnType<typeof makeMailbox> }> {
    const stub = makeMailbox();
    if (opts.mailboxMsgs !== undefined) {
      stub.query.mockResolvedValue(opts.mailboxMsgs);
    }
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: `/mailbox/query${opts.urlSuffix ?? ''}`,
        body: {},
      }),
      ...(opts.defaultMaxAgeMs !== undefined ? { defaultMaxAgeMs: opts.defaultMaxAgeMs } : {}),
    });
    return { response, stub };
  }

  it('disables the look-back when defaultMaxAgeMs is undefined', async () => {
    const now = new Date('2026-07-16T00:00:00.000Z');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const { response, stub } = await queryCall({
        defaultMaxAgeMs: undefined,
        mailboxMsgs: messagesInRange(now, [0, 60_000, 3_600_000, 86_400_000]),
      });

      expect(response.status).toBe(200);
      // All four messages must survive — no filter applied when option is unset.
      expect(response.json()).toMatchObject({ count: 4 });
      expect(stub.query).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats defaultMaxAgeMs: -1 as the documented "disabled" sentinel', async () => {
    const now = new Date('2026-07-16T00:00:00.000Z');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const { response } = await queryCall({
        defaultMaxAgeMs: -1,
        mailboxMsgs: messagesInRange(now, [0, 3_600_000, 7 * 24 * 3_600_000]),
      });

      expect(response.status).toBe(200);
      expect(response.json()).toMatchObject({ count: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'treats defaultMaxAgeMs: %p as the documented "disabled" sentinel',
    async (sentinel) => {
      const now = new Date('2026-07-16T00:00:00.000Z');
      vi.useFakeTimers();
      try {
        vi.setSystemTime(now);
        const { response } = await queryCall({
          defaultMaxAgeMs: sentinel,
          mailboxMsgs: messagesInRange(now, [0, 3_600_000]),
        });

        expect(response.status).toBe(200);
        expect(response.json()).toMatchObject({ count: 2 });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('treats defaultMaxAgeMs: 0 as the documented "disabled" sentinel', async () => {
    const now = new Date('2026-07-16T00:00:00.000Z');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const { response } = await queryCall({
        defaultMaxAgeMs: 0,
        mailboxMsgs: messagesInRange(now, [0, 3_600_000, 7 * 24 * 3_600_000]),
      });

      expect(response.status).toBe(200);
      expect(response.json()).toMatchObject({ count: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('?sinceMs=0 explicitly opts in to the full retained history', async () => {
    const now = new Date('2026-07-16T00:00:00.000Z');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      // Even with an aggressive 1-minute default, ?sinceMs=0 must disable filtering.
      const { response } = await queryCall({
        defaultMaxAgeMs: 60_000,
        urlSuffix: '?sinceMs=0',
        mailboxMsgs: messagesInRange(now, [0, 60_000, 86_400_000]),
      });

      expect(response.status).toBe(200);
      expect(response.json()).toMatchObject({ count: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps ?sinceMs above the 7-day ceiling to MAILBOX_HTTP_MAX_AGE_CEILING_MS', async () => {
    const now = new Date('2026-07-16T00:00:00.000Z');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      // 30 days expressed in ms — well above the 7-day ceiling. Messages 6
      // days old must survive; messages 8 days old must be filtered.
      const sixDays = 6 * 24 * 3_600_000;
      const eightDays = 8 * 24 * 3_600_000;
      const { response } = await queryCall({
        urlSuffix: `?sinceMs=${30 * 24 * 3_600_000}`,
        mailboxMsgs: messagesInRange(now, [sixDays, eightDays]),
      });

      expect(response.status).toBe(200);
      const json = response.json() as { count: number; data: MailboxMessage[] };
      expect(json.count).toBe(1);
      expect(json.data[0]?.id).toBe('msg-0');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['abc', '1.5', '-5', ''])(
    'rejects malformed ?sinceMs=%s with 400 VALIDATION_ERROR',
    async (badValue) => {
      const { response, stub } = await queryCall({
        urlSuffix: `?sinceMs=${badValue}`,
      });

      expect(response.status).toBe(400);
      expect(response.json()).toMatchObject({
        error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      });
      expect(stub.query).not.toHaveBeenCalled();
    },
  );

  it('rejects out-of-range ?sinceMs (above Number.MAX_SAFE_INTEGER) with 400', async () => {
    const { response, stub } = await queryCall({
      urlSuffix: `?sinceMs=${Number.MAX_SAFE_INTEGER + 1}`,
    });

    expect(response.status).toBe(400);
    expect(response.json()).toMatchObject({
      error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    });
    expect(stub.query).not.toHaveBeenCalled();
  });

  it('regression: /mailbox/check with markRead=true + 1h look-back must NOT ack old unread messages', async () => {
    // The pre-diff bug: checkMailbox ackMany'd the unfiltered messages
    // slice while the response filtered afterwards, silently mutating
    // server state for messages the client never observed. The fix at
    // L794 filters before building the ack set.
    const now = new Date('2026-07-16T00:00:00.000Z');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const stub = makeMailbox();
      const freshMsg = message({
        id: 'msg-fresh',
        from: 'external-a',
        to: 'agent-b',
        timestamp: new Date(now.getTime() - 5 * 60_000).toISOString(), // 5m old
      });
      const staleMsg = message({
        id: 'msg-stale',
        from: 'external-a',
        to: 'agent-b',
        timestamp: new Date(now.getTime() - 2 * 3_600_000).toISOString(), // 2h old
      });
      stub.query.mockResolvedValue([freshMsg, staleMsg]);

      const response = await handle({
        mailbox: stub.mailbox,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/check',
          body: { agentId: 'agent-b', markRead: true },
        }),
        defaultMaxAgeMs: 3_600_000, // 1h
      });

      expect(response.status).toBe(200);
      // Only the 5m message survives the 1h filter; the 2h message
      // must NOT appear in the response and must NOT be acked.
      const json = response.json() as { count: number; data: MailboxMessage[] };
      expect(json.count).toBe(1);
      expect(json.data[0]?.id).toBe('msg-fresh');

      // Crucial assertion: ackMany must receive ONLY the surviving
      // message, never the filtered-out one. Pre-fix code passed both.
      expect(stub.ackMany).toHaveBeenCalledTimes(1);
      const ackCall = stub.ackMany.mock.calls[0]![0] as MailboxAckBatchInput;
      const ackedIds = ackCall.acks.map((entry) => entry.messageId);
      expect(ackedIds).toEqual(['msg-fresh']);
      expect(ackedIds).not.toContain('msg-stale');
    } finally {
      vi.useRealTimers();
    }
  });

  it('regression: /mailbox/check with ?sinceMs=0 must ack every unread message (the disable sentinel stays symmetric)', async () => {
    const now = new Date('2026-07-16T00:00:00.000Z');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const stub = makeMailbox();
      const oldMsg = message({
        id: 'msg-30d',
        from: 'external-a',
        to: 'agent-b',
        timestamp: new Date(now.getTime() - 30 * 24 * 3_600_000).toISOString(),
      });
      stub.query.mockResolvedValue([oldMsg]);

      const response = await handle({
        mailbox: stub.mailbox,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/check?sinceMs=0',
          body: { agentId: 'agent-b', markRead: true },
        }),
        defaultMaxAgeMs: 3_600_000, // 1h default — overridden by ?sinceMs=0
      });

      expect(response.status).toBe(200);
      const json = response.json() as { count: number; data: MailboxMessage[] };
      expect(json.count).toBe(1);
      expect(json.data[0]?.id).toBe('msg-30d');

      expect(stub.ackMany).toHaveBeenCalledTimes(1);
      const ackCall = stub.ackMany.mock.calls[0]![0] as MailboxAckBatchInput;
      expect(ackCall.acks.map((entry) => entry.messageId)).toEqual(['msg-30d']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a routePath that STARTS with a literal ? with 400 (defensive guard)', async () => {
    const response = await handle({
      request: makeRequest({
        method: 'POST',
        url: '?sinceMs=0',
        body: {
          from: 'external-bot',
          to: 'agent-b',
          type: 'note',
          subject: 'never-reaches-server',
          body: 'should never land',
        },
      }),
      routePath: '?sinceMs=0',
    });

    expect(response.status).toBe(400);
    expect(response.json()).toMatchObject({
      error: expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining("routePath must not start with '?'"),
      }),
    });
  });

  it('forwards a per-request ?sinceMs=… appended to the rewritten route path', async () => {
    // Hosts that mount the router below a prefix may pass the rewritten
    // path WITH a per-request query (e.g. the HQ gateway does this for
    // `?sinceMs=…` overrides). The router must strip the query before
    // route matching and forward it to `parseSinceMs`.
    const stub = makeMailbox();
    const oldMessage = message({
      id: 'old-message',
      to: 'agent-b',
      timestamp: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    });
    stub.query.mockResolvedValue([oldMessage]);

    // Without the override the 1-hour default suppresses the old message.
    const filtered = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/api/projects/p1/mailbox/query',
        body: { to: 'agent-b' },
      }),
      routePath: '/mailbox/query',
      defaultMaxAgeMs: 60 * 60_000,
    });
    expect(filtered.status).toBe(200);
    expect(filtered.json()).toMatchObject({ count: 0 });

    // With ?sinceMs=0 the filter is disabled and the old message is returned.
    stub.query.mockClear();
    stub.query.mockResolvedValue([oldMessage]);
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/api/projects/p1/mailbox/query?sinceMs=0',
        body: { to: 'agent-b' },
      }),
      routePath: '/mailbox/query?sinceMs=0',
      defaultMaxAgeMs: 60 * 60_000,
    });

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ count: 1, data: [{ id: 'old-message' }] });
  });
});

describe('mailbox-http-router — heartbeat row recovery over HTTP', () => {
  it('rebuilds a deleted agent row from an HTTP heartbeat carrying identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-hb-recovery-'));
    const mailbox = new SqliteMailbox(dir);
    try {
      const registered = await handle({
        mailbox,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/agents/register',
          body: {
            agentId: 'external-agent@session-1',
            sessionId: 'session-1',
            name: 'External Agent',
            pid: 4242,
          },
        }),
      });
      expect(registered.status).toBe(200);

      // Row loss without fake timers: deregisterAgent deletes the row AND the
      // throttle entry, so the recovery heartbeat is not throttled. The
      // prune-driven variant (row older than AGENT_STALE_MS) is covered at the
      // store level in sqlite-mailbox-store.test.ts; what this test proves is
      // the HTTP layer passing identity through to the recovery branch.
      await mailbox.deregisterAgent('external-agent@session-1');
      const gone = await handle({
        mailbox,
        request: makeRequest({ method: 'GET', url: '/mailbox/agents' }),
      });
      expect((gone.json() as { count: number }).count).toBe(0);

      const heartbeat = await handle({
        mailbox,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/agents/heartbeat',
          body: {
            agentId: 'external-agent@session-1',
            sessionId: 'session-1',
            name: 'External Agent',
            pid: 4242,
            status: 'running',
          },
        }),
      });
      expect(heartbeat.status).toBe(200);

      const listed = await handle({
        mailbox,
        request: makeRequest({ method: 'GET', url: '/mailbox/agents' }),
      });
      const body = listed.json() as { data: Array<Record<string, unknown>>; count: number };
      expect(body.count).toBe(1);
      expect(body.data[0]).toMatchObject({
        agentId: 'external-agent@session-1',
        sessionId: 'session-1',
        name: 'External Agent',
        pid: 4242,
        status: 'running',
        online: true,
        source: 'http',
      });
    } finally {
      await mailbox.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);

  it('rejects a heartbeat that would register a reserved id — no registration bypass', async () => {
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/agents/heartbeat',
        body: {
          agentId: 'leader@evil-session',
          sessionId: 'evil-session',
          name: 'Fake Leader',
          pid: 1,
        },
      }),
    });
    expect(response.status).toBe(400);
    const body = response.json() as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.message).toContain('reserved');
    // The store must never see it: a heartbeat carrying identity persists a
    // row, so rejecting at validation is what prevents the bypass.
    expect(stub.heartbeat).not.toHaveBeenCalled();
  });

  it('forces source http — a client-supplied source label never reaches the store', async () => {
    const stub = makeMailbox();
    const response = await handle({
      mailbox: stub.mailbox,
      request: makeRequest({
        method: 'POST',
        url: '/mailbox/agents/heartbeat',
        body: {
          agentId: 'external-agent@session-1',
          sessionId: 'session-1',
          name: 'External Agent',
          pid: 4242,
          source: 'cli',
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(stub.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'external-agent@session-1',
        source: 'http',
      }),
    );
  });

  it('derives heartbeat identity from the credential and rejects conflicting fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailbox-http-router-hb-cred-'));
    try {
      const store = openCredentialStore(dir);
      await store.load();
      const { credential, secret } = await store.issue({
        principalId: 'cred-agent@cred-session',
        projectId: 'test-project',
        kind: 'agent',
        capabilities: ['mail.presence.heartbeat.self'],
        ttlMs: 60_000,
      });
      const authorization = `Credential ${credential.credentialId}:${secret}`;
      const stub = makeMailbox();

      const ok = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/agents/heartbeat',
          headers: { authorization },
          body: { name: 'Cred Agent', pid: 777 },
        }),
      });
      expect(ok.status).toBe(200);
      expect(stub.heartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'cred-agent@cred-session',
          sessionId: 'cred-session',
          role: 'cred-agent',
          source: 'http',
        }),
      );

      const conflicting = await handle({
        mailbox: stub.mailbox,
        credentialStore: store,
        request: makeRequest({
          method: 'POST',
          url: '/mailbox/agents/heartbeat',
          headers: { authorization },
          body: { name: 'Cred Agent', pid: 777, sessionId: 'somebody-else' },
        }),
      });
      expect(conflicting.status).toBe(400);
      expect(stub.heartbeat).toHaveBeenCalledTimes(1);
    } finally {
      await closeOpenedCredentialStores();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 5_000);
});
