import { MailboxEventEmitter, type RemoteMailbox } from '@wrongstack/coordination';
import { describe, expect, it, vi } from 'vitest';
import { createMailboxMcpServer, createMailboxMcpToolHost } from '../src/adapter.js';

function backend(overrides: Record<string, unknown> = {}): RemoteMailbox {
  return {
    query: vi.fn().mockResolvedValue([]),
    unreadCount: vi.fn().mockResolvedValue(0),
    getAgentStatuses: vi.fn().mockResolvedValue([]),
    getOnlineAgents: vi.fn().mockResolvedValue([]),
    getClientStatuses: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue({ storage: 'sqlite' }),
    send: vi.fn().mockResolvedValue({ id: 'message-1' }),
    ack: vi.fn().mockResolvedValue({ id: 'message-1' }),
    ackMany: vi.fn().mockResolvedValue([]),
    softDelete: vi.fn().mockResolvedValue({ id: 'message-1' }),
    restore: vi.fn().mockResolvedValue({ id: 'message-1' }),
    registerAgent: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    deregisterAgent: vi.fn().mockResolvedValue(undefined),
    clearAll: vi.fn().mockResolvedValue(undefined),
    purgeStale: vi.fn().mockResolvedValue({ totalPurged: 0 }),
    autoCompact: vi.fn().mockResolvedValue({ totalRemoved: 0 }),
    purgeAgents: vi.fn().mockResolvedValue(0),
    purgeClients: vi.fn().mockResolvedValue(0),
    credentialIssue: vi.fn().mockResolvedValue({ credential: {}, secret: 'secret' }),
    credentialVerify: vi.fn().mockResolvedValue({ valid: true }),
    credentialRevoke: vi.fn().mockResolvedValue(true),
    credentialRotate: vi.fn().mockResolvedValue(null),
    credentialGet: vi.fn().mockResolvedValue(null),
    credentialList: vi.fn().mockResolvedValue([]),
    credentialStatusCounts: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as RemoteMailbox;
}

/** A `query` that returns each requested id as mail addressed to `actor`. */
function addressedTo(actor: string) {
  return vi.fn().mockImplementation(async ({ ids, to }: { ids?: string[]; to?: string }) =>
    to === actor
      ? (ids ?? []).map((id) => ({
          id,
          from: 'leader',
          to: actor,
          timestamp: '2026-10-14T10:00:00Z',
        }))
      : [],
  );
}

describe('request bounds', () => {
  it('reads the configured actor inbox without requiring the agent to supply its identity', async () => {
    const direct = { id: 'direct', timestamp: '2026-10-14T10:00:00Z' };
    const broadcast = { id: 'broadcast', timestamp: '2026-10-14T11:00:00Z' };
    const session = { id: 'session', type: 'btw', timestamp: '2026-10-14T12:00:00Z' };
    const query = vi
      .fn()
      .mockImplementation(async ({ to }: { to: string }) =>
        to === 'worker-1' ? [direct, broadcast] : [session, broadcast],
      );
    const host = createMailboxMcpToolHost(backend({ query }), new MailboxEventEmitter(), {
      actor: 'worker-1',
      sessionId: 'session-1',
    });

    const result = await host.callTool('mailbox_read', {
      action: 'inbox',
      to: 'another-agent',
      limit: 2,
    });
    expect(result).toMatchObject({
      isError: false,
      content: { messages: [session, broadcast] },
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'worker-1',
        unreadBy: 'worker-1',
        currentSessionId: 'session-1',
        limit: 2,
      }),
    );
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ to: '@session:session-1', unreadBy: 'worker-1' }),
    );
    expect(query).not.toHaveBeenCalledWith(expect.objectContaining({ to: 'another-agent' }));
  });

  // `inputSchema` is a description handed to the model, not a gate —
  // MCPServer does not validate it. Both bounds below therefore have to be
  // enforced in adapter code, and both were not.

  it('clamps an out-of-range read limit instead of passing it to the store', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const host = createMailboxMcpToolHost(backend({ query }), new MailboxEventEmitter(), {
      actor: 'external-agent',
    });

    await host.callTool('mailbox_read', { action: 'query', limit: 1_000_000_000 });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }));

    query.mockClear();
    await host.callTool('mailbox_read', { action: 'query', limit: 25 });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });

  it('refuses an ack batch over the ceiling before touching the store', async () => {
    const ackMany = vi.fn().mockResolvedValue([]);
    const host = createMailboxMcpToolHost(
      backend({ ackMany, query: addressedTo('external-agent') }),
      new MailboxEventEmitter(),
      { actor: 'external-agent', writable: true },
    );

    // `ackMany` runs the whole batch in one `BEGIN IMMEDIATE`; unbounded, a
    // single call holds the project's only write lock past every other
    // surface's busy_timeout.
    await expect(
      host.callTool('mailbox_manage', {
        action: 'ack_many',
        messageIds: Array.from({ length: 501 }, (_, index) => `msg-${index}`),
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(ackMany).not.toHaveBeenCalled();

    await host.callTool('mailbox_manage', {
      action: 'ack_many',
      messageIds: Array.from({ length: 500 }, (_, index) => `msg-${index}`),
    });
    expect(ackMany).toHaveBeenCalled();
  });
});

describe('createMailboxMcpToolHost', () => {
  it.each([
    { subject: '  code sample  ', body: '    return 42;\n  ' },
    { subject: 'plain subject', body: 'plain body' },
    { subject: '\tsample\r\n', body: '\r\n\tcode\r\n' },
  ])('preserves send payload whitespace: %j', async ({ subject, body }) => {
    const send = vi.fn().mockResolvedValue({ id: 'message-1' });
    const host = createMailboxMcpToolHost(backend({ send }), new MailboxEventEmitter(), {
      actor: 'external-agent',
      writable: true,
    });

    await expect(
      host.callTool('mailbox_manage', {
        action: 'send',
        to: ' leader ',
        type: ' note ',
        subject,
        body,
      }),
    ).resolves.toMatchObject({ isError: false });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ to: 'leader', type: 'note', subject, body }),
    );
  });

  it.each([
    { subject: 'subject', body: '', missing: 'body' },
    { subject: 'subject', body: ' \n\t ', missing: 'body' },
    { subject: '', body: 'body', missing: 'subject' },
    { subject: ' \t ', body: 'body', missing: 'subject' },
  ])('rejects blank send payloads: %j', async ({ subject, body, missing }) => {
    const send = vi.fn();
    const host = createMailboxMcpToolHost(backend({ send }), new MailboxEventEmitter(), {
      actor: 'external-agent',
      writable: true,
    });

    await expect(
      host.callTool('mailbox_manage', {
        action: 'send',
        to: 'leader',
        type: 'note',
        subject,
        body,
      }),
    ).resolves.toEqual({ isError: true, content: `${missing} is required` });
    expect(send).not.toHaveBeenCalled();
  });

  it('advertises full tiered tools in admin mode', async () => {
    const host = createMailboxMcpToolHost(backend(), new MailboxEventEmitter(), {
      actor: 'external-agent',
      admin: true,
    });
    expect((await host.listTools()).map((tool) => tool.name)).toEqual([
      'mailbox_read',
      'mailbox_watch',
      'mailbox_manage',
      'mailbox_admin',
    ]);
  });

  it('binds sender, receipt, and deletion identity to the configured actor', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'message-1' });
    const ack = vi.fn().mockResolvedValue({ id: 'message-1' });
    const softDelete = vi.fn().mockResolvedValue({ id: 'message-1' });
    const mailbox = backend({ send, ack, softDelete, query: addressedTo('trusted-external') });
    const host = createMailboxMcpToolHost(mailbox, new MailboxEventEmitter(), {
      actor: 'trusted-external',
      sessionId: 'session-1',
      writable: true,
    });

    await host.callTool('mailbox_manage', {
      action: 'send',
      from: 'impersonated',
      to: 'leader',
      type: 'note',
      subject: 'Hello',
      body: 'World',
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'trusted-external', senderSessionId: 'session-1' }),
    );

    await host.callTool('mailbox_manage', {
      action: 'ack',
      messageId: 'message-1',
      readerId: 'impersonated',
    });
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'message-1', readerId: 'trusted-external' }),
    );

    await host.callTool('mailbox_manage', {
      action: 'soft_delete',
      messageId: 'message-1',
    });
    expect(softDelete).toHaveBeenCalledWith('message-1', 'trusted-external');
  });

  it('rejects hidden admin actions and runtime control messages', async () => {
    const host = createMailboxMcpToolHost(backend(), new MailboxEventEmitter(), {
      actor: 'external-agent',
      writable: true,
    });
    await expect(host.callTool('mailbox_admin', { action: 'clear_all' })).resolves.toMatchObject({
      isError: true,
    });
    await expect(
      host.callTool('mailbox_manage', {
        action: 'send',
        to: 'leader',
        type: 'control',
        subject: 'No',
        body: 'No',
      }),
    ).resolves.toEqual({
      content: 'Runtime control messages are not exposed over MCP',
      isError: true,
    });
  });

  it('validates credential options and normalizes notBefore', async () => {
    const credentialIssue = vi.fn().mockResolvedValue({ credential: {}, secret: 'secret' });
    const host = createMailboxMcpToolHost(backend({ credentialIssue }), new MailboxEventEmitter(), {
      actor: 'external-admin',
      admin: true,
    });
    const notBefore = new Date(Date.now() - 1_000).toISOString();

    await expect(
      host.callTool('mailbox_admin', {
        action: 'credential_issue',
        credentialOptions: {
          principalId: 'external-agent',
          projectId: 'external-project',
          kind: 'agent',
          capabilities: ['mail.read.self', 'mail.read.self'],
          ttlMs: 60_000,
          notBefore,
        },
      }),
    ).resolves.toMatchObject({ isError: false });
    expect(credentialIssue).toHaveBeenCalledWith({
      principalId: 'external-agent',
      projectId: 'external-project',
      kind: 'agent',
      capabilities: ['mail.read.self'],
      ttlMs: 60_000,
      notBefore: new Date(notBefore),
    });

    await expect(
      host.callTool('mailbox_admin', {
        action: 'credential_issue',
        credentialOptions: {
          principalId: 'external-agent',
          // Present so the rejection below is attributable to the unsupported
          // capability: the projectId guard throws earlier in credentialOptions,
          // which would otherwise satisfy `isError: true` for the wrong reason.
          projectId: 'external-project',
          kind: 'agent',
          capabilities: ['mail.runtime.control'],
          ttlMs: 60_000,
        },
      }),
    ).resolves.toMatchObject({ isError: true });
  });

  it('requires projectId to issue a credential but not to rotate one', async () => {
    const credentialIssue = vi.fn().mockResolvedValue({ credential: {}, secret: 'secret' });
    const credentialRotate = vi
      .fn()
      .mockResolvedValue({ credential: { credentialId: 'cred-2' }, secret: 'rotated' });
    const host = createMailboxMcpToolHost(
      backend({ credentialIssue, credentialRotate }),
      new MailboxEventEmitter(),
      { actor: 'external-admin', admin: true },
    );

    // Issuing without projectId is rejected before the backend is touched.
    // Without this guard the credential is created successfully and then fails
    // every HTTP request as a generic 401 that never names the missing field.
    const issued = await host.callTool('mailbox_admin', {
      action: 'credential_issue',
      credentialOptions: { principalId: 'external-agent', kind: 'agent' },
    });
    expect(issued).toMatchObject({ isError: true });
    expect(String(issued.content)).toContain('projectId');
    expect(credentialIssue).not.toHaveBeenCalled();

    // Rotation legitimately omits it — core inherits projectId from the
    // credential being superseded — so the guard must not fire here even when
    // credentialOptions is present. This is the asymmetry the `required`
    // argument encodes, and why projectId cannot live in the shared schema's
    // `required` array.
    await expect(
      host.callTool('mailbox_admin', {
        action: 'credential_rotate',
        credentialId: 'cred-1',
        credentialOptions: { ttlMs: 60_000 },
      }),
    ).resolves.toMatchObject({ isError: false });
    expect(credentialRotate).toHaveBeenCalledWith('cred-1', { ttlMs: 60_000 });

    // Omitting credentialOptions entirely stays valid too.
    await expect(
      host.callTool('mailbox_admin', { action: 'credential_rotate', credentialId: 'cred-1' }),
    ).resolves.toMatchObject({ isError: false });
    expect(credentialRotate).toHaveBeenLastCalledWith('cred-1', undefined);
  });

  it('long-polls Mailbox events and removes its subscription', async () => {
    const emitter = new MailboxEventEmitter();
    const host = createMailboxMcpToolHost(backend(), emitter, { actor: 'external-agent' });
    const pending = host.callTool('mailbox_watch', {
      eventType: 'message.sent',
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(emitter.subscriberCount).toBe(1));
    emitter.emit({
      type: 'message.sent',
      messageId: 'message-1',
      from: 'leader',
      to: 'external-agent',
      timestamp: new Date().toISOString(),
    });
    await expect(pending).resolves.toMatchObject({
      content: { changed: true, event: { messageId: 'message-1' } },
      isError: false,
    });
    expect(emitter.subscriberCount).toBe(0);
  });

  it('cancels a Mailbox watch and removes its subscription immediately', async () => {
    const emitter = new MailboxEventEmitter();
    const controller = new AbortController();
    const host = createMailboxMcpToolHost(backend(), emitter, { actor: 'external-agent' });
    const pending = host.callTool(
      'mailbox_watch',
      { timeoutMs: 100 },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(emitter.subscriberCount).toBe(1));
    controller.abort(new Error('client stopped watching'));

    await expect(pending).resolves.toEqual({
      content: 'client stopped watching',
      isError: true,
    });
    expect(emitter.subscriberCount).toBe(0);

    await expect(
      host.callTool('mailbox_watch', { eventType: 'message.sent', to: 'external-agent' }),
    ).resolves.toEqual({
      content: 'mailbox_watch: unknown argument "to"',
      isError: true,
    });
  });

  it('does not execute Mailbox operations for a pre-cancelled request', async () => {
    const status = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    const host = createMailboxMcpToolHost(backend({ status }), new MailboxEventEmitter(), {
      actor: 'external-agent',
    });

    await expect(
      host.callTool('mailbox_read', { action: 'status' }, { signal: controller.signal }),
    ).resolves.toEqual({ content: 'already cancelled', isError: true });
    expect(status).not.toHaveBeenCalled();
  });

  it('enforces lower limit clamp, ttlMs/integer/retentionAge/enum/credentialOption bounds, watch timeout/filtering, and non-blank actor', async () => {
    // S15-M10: blank actor id rejected
    expect(() =>
      createMailboxMcpToolHost(backend(), new MailboxEventEmitter(), { actor: '   ' }),
    ).toThrow('Mailbox MCP requires a non-blank actor id');

    const query = vi.fn().mockResolvedValue([]);
    const emitter = new MailboxEventEmitter();
    const host = createMailboxMcpToolHost(backend({ query }), emitter, {
      actor: 'external-admin',
      admin: true,
    });

    // S15-M1: boundedLimit lower bound clamps 0 to 1
    await host.callTool('mailbox_read', { action: 'query', limit: 0 });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));

    // S15-M2: ttlMs < 1 rejected
    await expect(
      host.callTool('mailbox_manage', {
        action: 'send',
        to: 'leader',
        type: 'note',
        subject: 'hi',
        body: 'there',
        ttlMs: 0,
      }),
    ).resolves.toEqual({ content: 'ttlMs must be at least 1', isError: true });

    // S15-M3: optionalNonNegativeInteger rejects negative iterations on heartbeat_self
    await expect(
      host.callTool('mailbox_manage', {
        action: 'heartbeat_self',
        iterations: -1,
      }),
    ).resolves.toMatchObject({ isError: true });

    // S15-M4: optionalRetentionAge rejects negative age on purge_stale
    await expect(
      host.callTool('mailbox_admin', {
        action: 'purge_stale',
        completedMaxAgeMs: -5,
      }),
    ).resolves.toMatchObject({ isError: true });

    // S15-M5: optionalEnum rejects invalid priority
    await expect(
      host.callTool('mailbox_manage', {
        action: 'send',
        to: 'leader',
        type: 'note',
        subject: 'hi',
        body: 'there',
        priority: 'invalid-priority',
      }),
    ).resolves.toMatchObject({ isError: true });

    // S15-M6: unknown credentialOptions property rejected
    await expect(
      host.callTool('mailbox_admin', {
        action: 'credential_issue',
        credentialOptions: {
          principalId: 'agent-1',
          projectId: 'proj-1',
          kind: 'agent',
          bogusKey: true,
        },
      }),
    ).resolves.toEqual({
      content: 'Unsupported credential option: bogusKey',
      isError: true,
    });

    // S15-M7, S15-M8, S15-M9: watch timeoutMs clamped to 100ms, ignores non-matching eventType, and resolves timedOut: true
    const watchPending = host.callTool('mailbox_watch', {
      eventType: 'message.sent',
      timeoutMs: 5,
    });
    await vi.waitFor(() => expect(emitter.subscriberCount).toBe(1));
    emitter.emit({
      type: 'message.acked',
      messageId: 'other-1',
      // An ack carries the message's ends, as the mailbox emits it.
      from: 'external-admin',
      to: 'leader',
      timestamp: new Date().toISOString(),
    });
    await expect(watchPending).resolves.toEqual({
      content: { changed: false, timedOut: true, timeoutMs: 100 },
      isError: false,
    });
  });

  it('forwards actorRole as readerRole and includes leader target and query filters in inbox and query', async () => {
    const query = vi.fn().mockImplementation(async (q: Record<string, unknown>) => {
      if (q['to'] === 'leader' && q['readerRole'] === 'leader') {
        return [
          {
            id: 'msg-leader-1',
            from: 'worker-1',
            to: 'leader',
            type: 'ask',
            priority: 'high',
            subject: 'Escalation',
            body: 'Need review',
            timestamp: '2026-10-18T10:00:00.000Z',
            readBy: [],
          },
        ];
      }
      return [];
    });
    const host = createMailboxMcpToolHost(backend({ query }), new MailboxEventEmitter(), {
      actor: 'agent-alpha',
      sessionId: 'sess-leader',
      actorRole: 'leader',
    });

    const inboxRes = await host.callTool('mailbox_read', {
      action: 'inbox',
      minPriority: 'high',
      incompleteOnly: true,
    });
    expect(inboxRes.isError).toBe(false);
    expect((inboxRes.content as { messages: Array<{ id: string }> }).messages).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'leader',
        unreadBy: 'agent-alpha',
        readerRole: 'leader',
        minPriority: 'high',
        incompleteOnly: true,
        currentSessionId: 'sess-leader',
      }),
    );

    query.mockClear();
    await host.callTool('mailbox_read', {
      action: 'query',
      minPriority: 'high',
    });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        readerRole: 'leader',
        minPriority: 'high',
      }),
    );
  });

  it('validates message type on send/query, eventType on mailbox_watch, and non-blank messageIds on ack_many', async () => {
    const send = vi.fn();
    const query = vi.fn();
    const ackMany = vi.fn();
    const emitter = new MailboxEventEmitter();
    const host = createMailboxMcpToolHost(backend({ send, query, ackMany }), emitter, {
      actor: 'external-agent',
      writable: true,
    });

    await expect(
      host.callTool('mailbox_manage', {
        action: 'send',
        to: 'leader',
        type: 'bogus-type',
        subject: 'Subj',
        body: 'Body',
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining('type must be one of'),
    });
    expect(send).not.toHaveBeenCalled();

    await expect(
      host.callTool('mailbox_read', {
        action: 'query',
        type: 'control',
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining('type must be one of'),
    });
    expect(query).not.toHaveBeenCalled();

    await expect(
      host.callTool('mailbox_watch', {
        eventType: 'not.an.event',
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining('eventType must be one of'),
    });
    expect(emitter.subscriberCount).toBe(0);

    await expect(
      host.callTool('mailbox_manage', {
        action: 'ack_many',
        messageIds: ['valid-id', '   '],
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining('non-empty'),
    });
    expect(ackMany).not.toHaveBeenCalled();
  });
});

describe('createMailboxMcpServer', () => {
  it('publishes identity and workflow prompt', async () => {
    const server = createMailboxMcpServer(backend(), new MailboxEventEmitter(), {
      actor: 'external-agent',
    });
    const initialized = JSON.parse(
      (await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      ))!,
    ) as { result: { serverInfo: { name: string } } };
    expect(initialized.result.serverInfo.name).toBe('wrongstack-mailbox-mcp');

    const prompts = JSON.parse(
      (await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'prompts/list', params: {} }),
      ))!,
    ) as { result: { prompts: Array<{ name: string }> } };
    expect(prompts.result.prompts).toContainEqual(
      expect.objectContaining({ name: 'coordinate-via-mailbox' }),
    );
  });

  it('serves tiered tools and calls them through MCP JSON-RPC', async () => {
    const server = createMailboxMcpServer(backend(), new MailboxEventEmitter(), {
      actor: 'external-agent',
      admin: true,
    });
    const listed = JSON.parse(
      (await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      ))!,
    ) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual([
      'mailbox_read',
      'mailbox_watch',
      'mailbox_manage',
      'mailbox_admin',
    ]);

    const called = JSON.parse(
      (await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'mailbox_read', arguments: { action: 'status' } },
        }),
      ))!,
    ) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };
    expect(called.result.isError).toBe(false);
    expect(called.result.content[0]).toMatchObject({ type: 'text' });
    expect(called.result.content[0]?.text).toContain('sqlite');
  });

  it('forwards identity fields on heartbeat_self so pruned agent presence rows can be rebuilt', async () => {
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const host = createMailboxMcpToolHost(backend({ heartbeat }), new MailboxEventEmitter(), {
      actor: 'agent-1',
      sessionId: 'sess-1',
      actorName: 'Worker One',
      actorRole: 'builder',
      writable: true,
    });
    const res = await host.callTool('mailbox_manage', {
      action: 'heartbeat_self',
      status: 'running',
      currentTask: 'task-42',
    });
    expect(res).toEqual({ isError: false, content: { heartbeat: true, agentId: 'agent-1' } });
    expect(heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        sessionId: 'sess-1',
        name: 'Worker One',
        role: 'builder',
        source: 'mcp',
        status: 'running',
        currentTask: 'task-42',
      }),
    );
  });

  it('rejects non-finite or non-number values in optionalNonNegativeInteger and sendTtlMs (F653)', async () => {
    const { optionalNonNegativeInteger, sendTtlMs } = await import('../src/tool-arg-parsing.js');
    expect(() => optionalNonNegativeInteger({ sinceSeq: Number.NaN }, 'sinceSeq')).toThrow(
      'sinceSeq must be a non-negative integer',
    );
    expect(() => optionalNonNegativeInteger({ sinceSeq: '10' }, 'sinceSeq')).toThrow(
      'sinceSeq must be a non-negative integer',
    );
    expect(() => sendTtlMs({ ttlMs: Number.NaN })).toThrow('ttlMs must be at least 1');
    expect(() => sendTtlMs({ ttlMs: Number.POSITIVE_INFINITY })).toThrow(
      'ttlMs must be at least 1',
    );
    expect(() => sendTtlMs({ ttlMs: '60000' })).toThrow('ttlMs must be at least 1');
  });

  it('parses --flag=value CLI options, expands session-tagged actor read scope, and rejects non-boolean optionalBoolean values (F681)', async () => {
    const { parseArgs } = await import('../src/main.js');
    const { optionalBoolean } = await import('../src/tool-arg-parsing.js');

    const parsed = parseArgs([
      '--http',
      '--project-root=/tmp/proj',
      '--actor=worker-1@sess-1',
      '--session-id=sess-1',
      '--port=4321',
      '--token=-secret=token',
    ]);
    expect(parsed.actor).toBe('worker-1@sess-1');
    expect(parsed.sessionId).toBe('sess-1');
    expect(parsed.httpPort).toBe(4321);
    expect(parsed.httpToken).toBe('-secret=token');

    const query = vi.fn().mockImplementation(async (q: { to?: string }) =>
      q.to === 'worker-1'
        ? [
            {
              id: 'msg-base',
              from: 'leader',
              to: 'worker-1',
              type: 'task',
              priority: 'normal',
              subject: 'Subtask',
              body: 'Body',
              timestamp: '2026-10-20T10:00:00.000Z',
              readBy: [],
            },
          ]
        : [],
    );
    const host = createMailboxMcpToolHost(backend({ query }), new MailboxEventEmitter(), {
      actor: 'worker-1@sess-1',
      sessionId: 'sess-1',
    });
    const readRes = await host.callTool('mailbox_read', { action: 'inbox' });
    expect(readRes.isError).toBe(false);
    expect(
      (readRes.content as { messages: Array<{ id: string }> }).messages.map((m) => m.id),
    ).toEqual(['msg-base']);

    expect(() => optionalBoolean({ incompleteOnly: 'true' }, 'incompleteOnly')).toThrow(
      'incompleteOnly must be a boolean',
    );

    // F857: unread action uses actorReadScope / unreadCountForActor (including base alias)
    const unreadRes = await host.callTool('mailbox_read', { action: 'unread' });
    expect(unreadRes.isError).toBe(false);
    expect(unreadRes.content).toEqual({ unread: 1 });

    // F858: non-string / non-finite-number optional arguments are rejected
    const badSince = await host.callTool('mailbox_read', { action: 'query', since: 12345 });
    expect(badSince.isError).toBe(true);
    const badLimit = await host.callTool('mailbox_read', { action: 'query', limit: '5' });
    expect(badLimit.isError).toBe(true);
  });
});
