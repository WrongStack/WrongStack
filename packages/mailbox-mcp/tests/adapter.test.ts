import { MailboxEventEmitter, type RemoteMailbox } from '@wrongstack/core/coordination';
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

describe('request bounds', () => {
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
    const host = createMailboxMcpToolHost(backend({ ackMany }), new MailboxEventEmitter(), {
      actor: 'external-agent',
      writable: true,
    });

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
    const mailbox = backend({ send, ack, softDelete });
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
});
