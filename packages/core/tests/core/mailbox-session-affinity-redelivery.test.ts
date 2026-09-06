/**
 * Regression: session-affinity-dropped mail must stay redeliverable across an
 * in-process session swap.
 *
 * The inline mailbox checker in mailbox-attach.ts is created with
 * `ack: false` and wrapped in `applySessionAffinityFilter(…, true, …)`, which
 * filters messages whose `sessionAffinity` token names another session and
 * acks only the accepted ones. The inner checker's closure-level
 * `injectedIds` set used to consume wrapper-DROPPED messages on their first
 * poll, so after an in-process session swap (resume / session.new / project
 * switch) to the matching session — which the wrapper re-derives live by
 * design — the message could never redeliver: silently lost for the
 * swapped-into session. The fix is `trackInjected: false` on the inline inner
 * checker plus wrapper-owned delivered-message dedup.
 *
 * These tests exercise the REAL production composition: createMailboxChecker
 * (fixed options) + the exported applySessionAffinityFilter.
 */
import { describe, expect, it } from 'vitest';
import type { Mailbox, MailboxMessage } from '../../src/coordination/mailbox-types.js';
import { createMailboxChecker } from '../../src/core/mailbox-loop.js';
import { applySessionAffinityFilter } from '../../src/mailbox-attach.js';

const SESSION_A = 'sess-aaaaaaaaaaaaaaaa';
const SESSION_B = 'sess-bbbbbbbbbbbbbbbb';

function msg(partial: Partial<MailboxMessage> & Pick<MailboxMessage, 'type'>): MailboxMessage {
  return {
    id: partial.id ?? 'm1',
    from: partial.from ?? 'chimera-reviewer@rev1',
    to: partial.to ?? 'leader',
    type: partial.type,
    subject: partial.subject ?? 'Chimera report ready',
    body: partial.body ?? 'b',
    priority: partial.priority ?? 'normal',
    readBy: partial.readBy ?? {},
    completed: partial.completed ?? false,
    timestamp: partial.timestamp ?? '2026-09-06T00:00:00.000Z',
    ...(partial.sessionAffinity !== undefined ? { sessionAffinity: partial.sessionAffinity } : {}),
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Minimal in-memory mailbox: query filters by address + readBy (what the
 * server does), ackMany stamps the receipt. `parkAcks` holds acks in flight
 * to expose the read-receipt latency window the wrapper dedup must cover.
 */
function fakeMailbox(seed: MailboxMessage[]) {
  const store = new Map(seed.map((m) => [m.id, { ...m }]));
  const ackCalls: Array<{ readerId: string; messageIds: string[] }> = [];
  let parked = false;
  let waiters: Array<() => void> = [];
  const stub = {
    query: async (q: { to: string; unreadBy?: string }) =>
      [...store.values()].filter(
        (m) => m.to === q.to && !(q.unreadBy !== undefined && m.readBy[q.unreadBy] !== undefined),
      ),
    ackMany: async (input: { acks: Array<{ messageId: string; readerId: string }> }) => {
      if (parked) await new Promise<void>((resolve) => waiters.push(resolve));
      ackCalls.push({
        readerId: input.acks[0]!.readerId,
        messageIds: input.acks.map((a) => a.messageId),
      });
      for (const a of input.acks) {
        const m = store.get(a.messageId);
        if (m) m.readBy[a.readerId] = new Date().toISOString();
      }
      return input.acks.map(() => null);
    },
  };
  return {
    mailbox: stub as unknown as Mailbox,
    ackCalls,
    parkAcks: (): void => {
      parked = true;
    },
    releaseAcks: async (): Promise<void> => {
      parked = false;
      const release = waiters;
      waiters = [];
      for (const w of release) w();
      await flush();
    },
  };
}

describe('session-affinity redelivery (inline checker composition)', () => {
  it('redelivers a session-affinity-dropped message after an in-process session swap', async () => {
    const { mailbox, ackCalls } = fakeMailbox([
      msg({ type: 'review', sessionAffinity: { sessionId: SESSION_B } }),
    ]);
    let currentSession = SESSION_A;
    let currentIdentity = 'leader@tagA';

    // Exactly the FIXED production inline construction (mailbox-attach.ts).
    const checkMailbox = createMailboxChecker({
      mailbox,
      agentId: () => currentIdentity,
      aliases: ['leader'],
      sessionId: () => currentSession,
      ack: false,
      trackInjected: false,
    });
    const inline = applySessionAffinityFilter(checkMailbox, true, {
      getSessionId: () => currentSession,
      getAgentId: () => currentIdentity,
      getMailbox: () => mailbox,
      affinityCtx: { resolveChimeraReportSessionId: async () => undefined },
    });

    // While in session A the session-B message is dropped, unacked.
    expect(await inline()).toEqual([]);
    expect(ackCalls).toEqual([]);

    // In-process session swap to the matching session — the message MUST
    // redeliver (this is the assertion that failed pre-fix: the inner
    // injectedIds set had consumed it on the first poll).
    currentSession = SESSION_B;
    currentIdentity = 'leader@tagB';
    expect((await inline()).map((m) => m.id)).toEqual(['m1']);

    // Acked exactly once, under the session-B identity.
    await flush();
    expect(ackCalls).toEqual([{ readerId: 'leader@tagB', messageIds: ['m1'] }]);

    // No duplicate delivery once the ack has landed.
    expect(await inline()).toEqual([]);
  });

  it('does not double-deliver while the ack is still in flight (wrapper-owned dedup)', async () => {
    const { mailbox, ackCalls, parkAcks, releaseAcks } = fakeMailbox([
      msg({ type: 'review', id: 'm2', sessionAffinity: { sessionId: SESSION_A } }),
    ]);
    parkAcks();
    const checkMailbox = createMailboxChecker({
      mailbox,
      agentId: () => 'leader@tagA',
      aliases: ['leader'],
      sessionId: () => SESSION_A,
      ack: false,
      trackInjected: false,
    });
    const inline = applySessionAffinityFilter(checkMailbox, true, {
      getSessionId: () => SESSION_A,
      getAgentId: () => 'leader@tagA',
      getMailbox: () => mailbox,
      affinityCtx: { resolveChimeraReportSessionId: async () => undefined },
    });

    expect((await inline()).map((m) => m.id)).toEqual(['m2']);
    // The ack is parked (unreadBy not yet flipped server-side), but the
    // message must not be delivered a second time.
    expect(await inline()).toEqual([]);

    await releaseAcks();
    expect(ackCalls).toEqual([{ readerId: 'leader@tagA', messageIds: ['m2'] }]);
  });

  it('the awareness wrapper filters but never acks', async () => {
    const { mailbox, ackCalls } = fakeMailbox([
      msg({ type: 'review', id: 'm3', sessionAffinity: { sessionId: SESSION_A } }),
      msg({ type: 'review', id: 'm4', sessionAffinity: { sessionId: SESSION_B } }),
    ]);
    const checkMailbox = createMailboxChecker({
      mailbox,
      agentId: () => 'leader@tagA',
      aliases: ['leader'],
      sessionId: () => SESSION_A,
      ack: false,
    });
    const awareness = applySessionAffinityFilter(checkMailbox, false, {
      getSessionId: () => SESSION_A,
      getAgentId: () => 'leader@tagA',
      getMailbox: () => mailbox,
      affinityCtx: { resolveChimeraReportSessionId: async () => undefined },
    });

    expect((await awareness()).map((m) => m.id)).toEqual(['m3']);
    await flush();
    expect(ackCalls).toEqual([]);
  });

  it('checker-level pin: default injected-tracking suppresses a wrapper-dropped message forever', async () => {
    // Documents WHY the inline checker must pass trackInjected:false — with
    // default tracking (and ack deferred to the wrapper), the first poll
    // consumes the message even though it was never acked or delivered.
    const { mailbox, ackCalls } = fakeMailbox([
      msg({ type: 'review', id: 'm5', sessionAffinity: { sessionId: SESSION_B } }),
    ]);
    let currentSession = SESSION_A;
    const checkMailbox = createMailboxChecker({
      mailbox,
      agentId: () => 'leader@tagA',
      aliases: ['leader'],
      sessionId: () => currentSession,
      ack: false,
    });
    const inline = applySessionAffinityFilter(checkMailbox, true, {
      getSessionId: () => currentSession,
      getAgentId: () => 'leader@tagA',
      getMailbox: () => mailbox,
      affinityCtx: { resolveChimeraReportSessionId: async () => undefined },
    });

    expect(await inline()).toEqual([]);
    currentSession = SESSION_B;
    expect(await inline()).toEqual([]);
    expect(ackCalls).toEqual([]);
  });
});
