import { type ChildProcess, spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectMailbox, MailboxEventEmitter } from '@wrongstack/core/coordination';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMailboxMcpToolHost } from '../src/adapter.js';

function objectContent(result: { content: unknown; isError: boolean }): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result.content)).toBe(false);
  expect(result.content).toBeTypeOf('object');
  return result.content as Record<string, unknown>;
}

async function waitForServer(metadataPath: string, child: ChildProcess, stderr: () => string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Mailbox project server exited before ready (${child.exitCode}): ${stderr()}`,
      );
    }
    try {
      await access(metadataPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Mailbox project server readiness timed out: ${stderr()}`);
}

describe('Mailbox MCP full-access IPC integration', () => {
  let projectDir = '';
  let serverProcess: ChildProcess | undefined;
  let mailbox: ReturnType<typeof createProjectMailbox> | undefined;
  let emitter: MailboxEventEmitter | undefined;

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'wrongstack-mailbox-mcp-'));
    const projectServer = fileURLToPath(
      new URL('../../core/dist/coordination/mailbox-project-server.js', import.meta.url),
    );
    let stderr = '';
    serverProcess = spawn(process.execPath, [projectServer, '--project-dir', projectDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NODE_ENV: 'production', VITEST: 'false' },
    });
    serverProcess.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    await waitForServer(join(projectDir, '.mailbox-server.json'), serverProcess, () => stderr);

    emitter = new MailboxEventEmitter();
    mailbox = createProjectMailbox({ projectDir, eventEmitter: emitter, isolatedConnection: true });
    await mailbox.initialize();
  });

  afterAll(async () => {
    await mailbox?.close().catch(() => {});
    emitter?.clear();
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        serverProcess?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('manages messages, events, receipts, deletion, restore, and credentials over IPC', async () => {
    if (!mailbox || !emitter) throw new Error('Mailbox test backend was not initialized');
    const host = createMailboxMcpToolHost(mailbox, emitter, {
      actor: 'external-agent',
      sessionId: 'mcp-integration',
      actorName: 'External integration agent',
      admin: true,
    });
    expect((await host.listTools()).map((tool) => tool.name)).toEqual([
      'mailbox_read',
      'mailbox_watch',
      'mailbox_manage',
      'mailbox_admin',
    ]);

    objectContent(
      await host.callTool('mailbox_manage', {
        action: 'register_self',
        role: 'integration',
      }),
    );
    objectContent(
      await host.callTool('mailbox_manage', {
        action: 'heartbeat_self',
        status: 'running',
        currentTask: 'Mailbox MCP integration',
        iterations: 1,
        toolCalls: 1,
      }),
    );

    const agentsResult = objectContent(await host.callTool('mailbox_read', { action: 'agents' }));
    expect(agentsResult['agents']).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'external-agent' })]),
    );
    objectContent(await host.callTool('mailbox_read', { action: 'online_agents' }));
    objectContent(await host.callTool('mailbox_read', { action: 'clients' }));
    const statusResult = objectContent(await host.callTool('mailbox_read', { action: 'status' }));
    expect(statusResult['status']).toMatchObject({ storageKind: 'sqlite' });

    const sendResult = objectContent(
      await host.callTool('mailbox_manage', {
        action: 'send',
        to: 'external-agent',
        type: 'note',
        subject: 'External MCP integration',
        body: 'Created through the Mailbox MCP management tier.',
      }),
    );
    const message = sendResult['message'] as { id: string; from: string };
    expect(message).toMatchObject({ from: 'external-agent' });
    expect(message.id).toBeTruthy();

    const unreadResult = objectContent(await host.callTool('mailbox_read', { action: 'unread' }));
    expect(unreadResult['unread']).toBe(1);

    const readResult = objectContent(
      await host.callTool('mailbox_read', { action: 'query', includeDeleted: true }),
    );
    expect(readResult['messages']).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: message.id })]),
    );

    const ackResult = objectContent(
      await host.callTool('mailbox_manage', {
        action: 'ack',
        messageId: message.id,
        read: true,
        completed: true,
        outcome: 'Verified through MCP',
      }),
    );
    expect(ackResult['message']).toMatchObject({ id: message.id });

    const secondSendResult = objectContent(
      await host.callTool('mailbox_manage', {
        action: 'send',
        to: 'external-agent',
        type: 'result',
        subject: 'Batch receipt integration',
        body: 'Acknowledged through ack_many.',
      }),
    );
    const secondMessage = secondSendResult['message'] as { id: string };
    const ackManyResult = objectContent(
      await host.callTool('mailbox_manage', {
        action: 'ack_many',
        messageIds: [message.id, secondMessage.id],
        read: true,
      }),
    );
    expect(ackManyResult['messages']).toHaveLength(2);

    const watchDeleted = host.callTool('mailbox_watch', {
      eventType: 'message.deleted',
      timeoutMs: 5_000,
    });
    await expect.poll(() => emitter?.subscriberCount).toBe(1);
    objectContent(
      await host.callTool('mailbox_manage', {
        action: 'soft_delete',
        messageId: message.id,
      }),
    );
    await expect(watchDeleted).resolves.toMatchObject({
      content: { changed: true, event: { type: 'message.deleted', messageId: message.id } },
      isError: false,
    });

    const deletedResult = objectContent(
      await host.callTool('mailbox_read', { action: 'query', includeDeleted: true }),
    );
    expect(deletedResult['messages']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: message.id,
          deletedAt: expect.any(String),
          deletedBy: 'external-agent',
        }),
      ]),
    );

    objectContent(
      await host.callTool('mailbox_manage', { action: 'restore', messageId: message.id }),
    );

    const credentialNotBefore = new Date(Date.now() - 1_000).toISOString();
    const issueResult = objectContent(
      await host.callTool('mailbox_admin', {
        action: 'credential_issue',
        credentialOptions: {
          principalId: 'external-agent',
          projectId: 'mailbox-mcp-integration-project',
          kind: 'agent',
          capabilities: ['mail.read.self', 'mail.send.informational'],
          ttlMs: 60_000,
          notBefore: credentialNotBefore,
          issuedBy: 'mailbox-mcp-integration',
        },
      }),
    );
    const issued = issueResult['result'] as {
      credential: { credentialId: string };
      secret: string;
    };
    expect(issued.credential.credentialId).toBeTruthy();
    expect(issued.secret).toBeTruthy();

    const verifyResult = objectContent(
      await host.callTool('mailbox_admin', {
        action: 'credential_verify',
        credentialId: issued.credential.credentialId,
        secret: issued.secret,
      }),
    );
    expect(verifyResult['result']).toMatchObject({ valid: true });

    const getResult = objectContent(
      await host.callTool('mailbox_admin', {
        action: 'credential_get',
        credentialId: issued.credential.credentialId,
      }),
    );
    expect(getResult['credential']).toMatchObject({
      credentialId: issued.credential.credentialId,
      notBefore: credentialNotBefore,
    });
    const listResult = objectContent(
      await host.callTool('mailbox_admin', { action: 'credential_list' }),
    );
    expect(listResult['credentials']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ credentialId: issued.credential.credentialId }),
      ]),
    );
    const activeCounts = objectContent(
      await host.callTool('mailbox_admin', { action: 'credential_status_counts' }),
    );
    expect(activeCounts['counts']).toMatchObject({ active: 1 });

    const rotatedNotBefore = new Date(Date.now() - 500).toISOString();
    const rotateResult = objectContent(
      await host.callTool('mailbox_admin', {
        action: 'credential_rotate',
        credentialId: issued.credential.credentialId,
        credentialOptions: {
          capabilities: ['mail.read.self'],
          ttlMs: 60_000,
          notBefore: rotatedNotBefore,
          issuedBy: 'mailbox-mcp-integration',
        },
      }),
    );
    const rotated = rotateResult['result'] as {
      credential: { credentialId: string; notBefore?: string };
      secret: string;
    };
    expect(rotated.credential).toMatchObject({ notBefore: rotatedNotBefore });
    expect(rotated.credential.credentialId).not.toBe(issued.credential.credentialId);

    const rotatedVerifyResult = objectContent(
      await host.callTool('mailbox_admin', {
        action: 'credential_verify',
        credentialId: rotated.credential.credentialId,
        secret: rotated.secret,
      }),
    );
    expect(rotatedVerifyResult['result']).toMatchObject({ valid: true });

    const revokeResult = objectContent(
      await host.callTool('mailbox_admin', {
        action: 'credential_revoke',
        credentialId: rotated.credential.credentialId,
        reason: 'Integration test complete',
      }),
    );
    expect(revokeResult['revoked']).toBe(true);

    const revokedVerifyResult = objectContent(
      await host.callTool('mailbox_admin', {
        action: 'credential_verify',
        credentialId: rotated.credential.credentialId,
        secret: rotated.secret,
      }),
    );
    expect(revokedVerifyResult['result']).toMatchObject({ valid: false });

    objectContent(
      await host.callTool('mailbox_admin', {
        action: 'purge_stale',
        completedMaxAgeMs: 31_536_000_000,
        incompleteMaxAgeMs: 31_536_000_000,
      }),
    );
    objectContent(
      await host.callTool('mailbox_admin', {
        action: 'auto_compact',
        readMaxAgeMs: 31_536_000_000,
        defaultTtlMs: 31_536_000_000,
      }),
    );
    objectContent(
      await host.callTool('mailbox_admin', {
        action: 'purge_agents',
        maxAgeMs: 31_536_000_000,
      }),
    );
    objectContent(await host.callTool('mailbox_admin', { action: 'purge_clients' }));

    objectContent(await host.callTool('mailbox_admin', { action: 'clear_all' }));
    const emptyResult = objectContent(
      await host.callTool('mailbox_read', { action: 'query', includeDeleted: true }),
    );
    expect(emptyResult['messages']).toEqual([]);
    objectContent(await host.callTool('mailbox_manage', { action: 'deregister_self' }));
  });
});
