import type { MailboxEventEmitter, RemoteMailbox } from '@wrongstack/coordination';
import { describe, expect, it } from 'vitest';
import { createMailboxMcpToolHost } from '../src/adapter.js';

describe('mailbox_watch synchronous event settle abort-listener cleanup (F1865)', () => {
  it('does not attach an abort listener after subscribe() settles synchronously', async () => {
    const mailbox = {} as RemoteMailbox;
    const ac = new AbortController();
    let addCallsAfterSettle = 0;
    let settledSync = false;
    let unsubCalls = 0;

    const origAdd = ac.signal.addEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((...args: Parameters<typeof origAdd>) => {
      if (settledSync) addCallsAfterSettle += 1;
      return origAdd(...args);
    }) as typeof ac.signal.addEventListener;

    const syncEmitter = {
      subscribe: (listener: Parameters<MailboxEventEmitter['subscribe']>[0]) => {
        listener({ type: 'message.sent' } as never);
        settledSync = true;
        return () => {
          unsubCalls += 1;
        };
      },
    } as unknown as MailboxEventEmitter;
    const host = createMailboxMcpToolHost(mailbox, syncEmitter, { actor: 'agent-1' });
    const res = await host.callTool('mailbox_watch', { timeoutMs: 500 }, { signal: ac.signal });

    expect(res.isError).toBe(false);
    expect(addCallsAfterSettle).toBe(0);
    expect(unsubCalls).toBe(1);
  });
});
