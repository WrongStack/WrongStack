/**
 * `parseArgs` splits `--flag=value`, but the switch cases ignored the value:
 * `--writable=false` granted the tier it was written to deny.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/main.js';

vi.spyOn(console, 'warn').mockImplementation(() => undefined);
const parse = (argv: string[]) =>
  parseArgs(argv, {} as never) as unknown as Record<string, unknown>;

describe('mailbox-mcp: privilege switches with an inline value', () => {
  it('true / 1 grant; false / 0 / anything else deny', () => {
    expect(parse(['--writable']).writable).toBe(true);
    expect(parse(['--writable=true']).writable).toBe(true);
    expect(parse(['--writable=1']).writable).toBe(true);
    expect(parse(['--writable=false']).writable).toBe(false);
    expect(parse(['--writable=0']).writable).toBe(false);
    expect(parse(['--writable=yes-please']).writable).toBe(false);
  });

  it('--admin=false grants neither admin nor writable', () => {
    expect(parse(['--admin=false'])).toMatchObject({ admin: false, writable: false });
    expect(parse(['--admin'])).toMatchObject({ admin: true, writable: true });
  });

  it('allows later =false switches to revoke --admin/--writable and rejects non-object args, empty ack_many, and sub-ms credentialOptions.ttlMs (F126)', async () => {
    const { MailboxEventEmitter } = await import('@wrongstack/coordination');
    const { createMailboxMcpToolHost } = await import('../src/adapter.js');

    expect(
      parse(['--admin', '--admin=false', '--writable=false', '--http=false', '--help=false']),
    ).toMatchObject({
      admin: false,
      writable: false,
      transport: 'stdio',
      help: false,
    });

    const host = createMailboxMcpToolHost(
      {
        ackMany: async () => [],
        credentialRotate: async () => null,
      } as never,
      new MailboxEventEmitter(),
      { actor: 'agent-1', writable: true, admin: true },
    );
    const nullRes = await host.callTool('mailbox_read', null as unknown as Record<string, unknown>);
    expect(nullRes.isError).toBe(true);
    expect(String(nullRes.content)).toMatch(/plain object/);

    const emptyAck = await host.callTool('mailbox_manage', {
      action: 'ack_many',
      messageIds: [],
    });
    expect(emptyAck.isError).toBe(true);

    const subMsCred = await host.callTool('mailbox_admin', {
      action: 'credential_rotate',
      credentialId: 'cred-1',
      credentialOptions: { ttlMs: 0.5 },
    });
    expect(subMsCred.isError).toBe(true);
  });
});
