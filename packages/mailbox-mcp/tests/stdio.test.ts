import { PassThrough } from 'node:stream';
import { MailboxEventEmitter, type RemoteMailbox } from '@wrongstack/core/coordination';
import { serveStdio } from '@wrongstack/mcp';
import { describe, expect, it, vi } from 'vitest';
import { createMailboxMcpServer } from '../src/adapter.js';

describe('Mailbox MCP stdio transport', () => {
  it('initializes, lists full-access tools, and calls Mailbox status over JSON-RPC', async () => {
    const mailbox = {
      status: vi.fn().mockResolvedValue({ storageKind: 'sqlite', pid: 1234 }),
    } as unknown as RemoteMailbox;
    const server = createMailboxMcpServer(mailbox, new MailboxEventEmitter(), {
      actor: 'stdio-agent',
      admin: true,
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const handle = serveStdio(server, { stdin, stdout });
    const responses = new Map<number, Record<string, unknown>>();
    let buffer = '';
    stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n');
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const response = JSON.parse(line) as { id?: number } & Record<string, unknown>;
        if (response.id !== undefined) responses.set(response.id, response);
      }
    });

    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
    );
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'mailbox_read', arguments: { action: 'status' } },
      })}\n`,
    );

    await vi.waitFor(() => expect(responses.size).toBe(3));
    stdin.end();
    await handle.done;

    const initialized = responses.get(1)?.['result'] as {
      serverInfo: { name: string };
    };
    expect(initialized.serverInfo.name).toBe('wrongstack-mailbox-mcp');

    const listed = responses.get(2)?.['result'] as {
      tools: Array<{ name: string }>;
    };
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'mailbox_read',
      'mailbox_watch',
      'mailbox_manage',
      'mailbox_admin',
    ]);

    const called = responses.get(3)?.['result'] as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(called.isError).toBe(false);
    expect(called.content[0]).toMatchObject({ type: 'text' });
    expect(called.content[0]?.text).toContain('sqlite');
    expect(mailbox.status).toHaveBeenCalledOnce();
  });
});
