import { describe, expect, it, vi } from 'vitest';
import {
  isMailboxMessageVisibleTo,
  type Mailbox,
  type MailboxMessage,
  type MailboxQuery,
} from '../../src/coordination/mailbox-types.js';
import { removeInjectedMailboxBlocks } from '../../src/core/mailbox-loop.js';
import {
  buildMailboxBlock,
  buildMailboxBtwAwarenessBlock,
  createMailboxChecker,
  injectPendingMailboxMessages,
} from '../../src/index.js';

function msg(partial: Partial<MailboxMessage> & Pick<MailboxMessage, 'type'>): MailboxMessage {
  return {
    id: partial.id ?? `m_${Math.random().toString(36).slice(2)}`,
    from: partial.from ?? 'human@webui',
    to: partial.to ?? 'leader@abcd',
    type: partial.type,
    ...(partial.audience !== undefined ? { audience: partial.audience } : {}),
    subject: partial.subject ?? 's',
    body: partial.body ?? 'b',
    priority: partial.priority ?? 'high',
    readBy: partial.readBy ?? {},
    completed: partial.completed ?? false,
    timestamp: partial.timestamp ?? '2026-06-19T00:00:00.000Z',
  };
}

const noopHost = {
  events: { emit: () => {} },
  logger: { debug: () => {} },
};

describe('injectPendingMailboxMessages', () => {
  it('signals interrupt on a control:interrupt message and does NOT fold it as content', async () => {
    const fold = vi.fn();
    const res = await injectPendingMailboxMessages(
      async () => [msg({ type: 'control', subject: 'interrupt', body: 'stop now' })],
      fold,
      noopHost,
    );
    expect(res.interrupt).toBe(true);
    expect(res.interruptReason).toBe('stop now');
    // control messages are out-of-band signals — never folded into the transcript
    expect(fold).not.toHaveBeenCalled();
  });

  it('folds normal content and does not signal interrupt', async () => {
    const fold = vi.fn();
    const res = await injectPendingMailboxMessages(
      async () => [msg({ type: 'steer', body: 'adjust your approach' })],
      fold,
      noopHost,
    );
    expect(res.interrupt).toBe(false);
    expect(fold).toHaveBeenCalledTimes(1);
  });

  it('folds content but still signals interrupt when both arrive together', async () => {
    const fold = vi.fn();
    const res = await injectPendingMailboxMessages(
      async () => [
        msg({ type: 'note', body: 'fyi' }),
        msg({ type: 'control', subject: 'interrupt', body: 'halt' }),
      ],
      fold,
      noopHost,
    );
    expect(res.interrupt).toBe(true);
    expect(fold).toHaveBeenCalledTimes(1); // only the note is folded
  });

  it('keeps routine mailbox tracking out of context in background mode', async () => {
    const fold = vi.fn();
    const emitted: unknown[] = [];
    const res = await injectPendingMailboxMessages(
      async () => [
        msg({ type: 'status', body: 'worker is running' }),
        msg({ type: 'btw', body: 'routine awareness' }),
        msg({ type: 'note', body: 'presence metadata' }),
      ],
      fold,
      { events: { emit: (_type, payload) => emitted.push(payload) }, logger: {} },
      'background',
    );

    expect(res.interrupt).toBe(false);
    expect(fold).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(3);
  });

  it('still delivers actionable mailbox work in background mode', async () => {
    const fold = vi.fn();
    await injectPendingMailboxMessages(
      async () => [
        msg({ type: 'result', body: 'subagent finding' }),
        msg({ type: 'steer', body: 'change course' }),
      ],
      fold,
      noopHost,
      'background',
    );

    expect(fold).toHaveBeenCalledTimes(1);
    expect(fold.mock.calls[0]?.[0].text).toContain('subagent finding');
    expect(fold.mock.calls[0]?.[0].text).toContain('change course');
  });

  it('returns interrupt:false on empty mailbox and never folds', async () => {
    const fold = vi.fn();
    const res = await injectPendingMailboxMessages(async () => [], fold, noopHost);
    expect(res.interrupt).toBe(false);
    expect(fold).not.toHaveBeenCalled();
  });

  it('swallows a checker error (broken mailbox must not stop the agent)', async () => {
    const fold = vi.fn();
    const res = await injectPendingMailboxMessages(
      async () => {
        throw new Error('mailbox unavailable');
      },
      fold,
      noopHost,
    );
    expect(res.interrupt).toBe(false);
    expect(fold).not.toHaveBeenCalled();
  });
});

describe('buildMailboxBtwAwarenessBlock', () => {
  it('renders a non-interrupting mailbox-system disclaimer', () => {
    const text = buildMailboxBtwAwarenessBlock([msg({ type: 'broadcast', to: '*' })]).text;
    expect(text).toContain('[MAILBOX BTW]');
    expect(text).toContain('sent mail to everyone or to you');
    expect(text).toContain('Do not stop your current work');
    expect(text).toContain('only for awareness');
    expect(text).toContain('WrongStack mailbox system');
    expect(text).toContain('raw awareness block is request-scoped');
    expect(text).toContain('[END MAILBOX BTW]');
  });

  it('shows whether mail was broadcast or directly addressed', () => {
    const text = buildMailboxBtwAwarenessBlock([
      msg({ type: 'status', id: 'm_broadcast', to: '*', subject: 'all-hands' }),
      msg({ type: 'note', id: 'm_direct', to: 'leader@abcd', subject: 'direct-note' }),
    ]).text;
    expect(text).toContain('broadcast to everyone');
    expect(text).toContain('addressed to leader@abcd');
    expect(text).toContain('Subject: all-hands');
    expect(text).toContain('Subject: direct-note');
    expect(text).not.toContain('Action required');
  });
});

describe('buildMailboxBlock', () => {
  // ── Guards ─────────────────────────────────────────────────────────────

  it('throws on empty messages (caller invariant)', () => {
    expect(() => buildMailboxBlock([])).toThrow(/empty messages/);
  });

  // ── Render format ──────────────────────────────────────────────────────

  it('wraps the block in [MAILBOX] / [END MAILBOX] delimiters', () => {
    const text = buildMailboxBlock([msg({ type: 'note' })]).text;
    expect(text.startsWith('[MAILBOX] New message(s) from other agents:')).toBe(true);
    expect(text.endsWith('[END MAILBOX]')).toBe(true);
  });

  it('explains that raw mail is request-scoped and only a concise consequence should persist', () => {
    const text = buildMailboxBlock([msg({ type: 'result', body: 'large raw report' })]).text;
    expect(text).toContain('raw mailbox block is request-scoped');
    expect(text).toContain('removed after you evaluate it');
    expect(text).toContain('retain only one concise conclusion/action');
    expect(text).toContain('otherwise acknowledge it internally and continue');
  });

  it('renders each message with its type emoji, from, subject and body', () => {
    const text = buildMailboxBlock([
      msg({ type: 'note', from: 'human@webui', subject: 'heads up', body: 'cache cleared' }),
    ]).text;
    expect(text).toContain('📨 NOTE from human@webui');
    expect(text).toContain('Subject: heads up');
    expect(text).toContain('cache cleared');
  });

  it('uses the documented emoji for each actionable type', () => {
    const cases: Array<[MailboxMessage['type'], string]> = [
      ['steer', '🔄 STEER'],
      ['btw', '💬 BTW'],
      ['ask', '❓ ASK'],
      ['assign', '📋 ASSIGN'],
      ['result', '✅ RESULT'],
      ['review', '🔍 REVIEW'],
    ];
    for (const [type, label] of cases) {
      const text = buildMailboxBlock([msg({ type, id: `m_${type}` })]).text;
      expect(text).toContain(`--- ${label} from`);
    }
  });

  // ── Type-specific CTA paragraphs ───────────────────────────────────────

  it('appends the steer CTA asking the agent to adjust after the next stopping point', () => {
    const text = buildMailboxBlock([msg({ type: 'steer' })]).text;
    expect(text).toContain(
      'After your current operation reaches a stopping point, adjust your approach',
    );
  });

  it('appends the ask CTA telling the agent to reply', () => {
    const text = buildMailboxBlock([msg({ type: 'ask' })]).text;
    expect(text).toContain('Reply directly or use mailbox action=send to respond');
  });

  it('appends the assign CTA asking the agent to act on the task', () => {
    const text = buildMailboxBlock([msg({ type: 'assign' })]).text;
    expect(text).toContain('Act on it when your current operation allows');
  });

  it('appends the result CTA asking the agent to factor the result in', () => {
    const text = buildMailboxBlock([msg({ type: 'result' })]).text;
    expect(text).toContain('Factor this result into your next decision');
  });

  it('appends the btw CTA saying no reply is needed', () => {
    const text = buildMailboxBlock([msg({ type: 'btw' })]).text;
    expect(text).toContain('FYI only');
    expect(text).toContain('no reply needed');
  });

  it('appends the status CTA about avoiding duplicate work', () => {
    const text = buildMailboxBlock([msg({ type: 'status' })]).text;
    expect(text).toContain('Peer status update');
    expect(text).toContain('no reply needed');
  });

  it('btw/status stay non-actionable (no Action required footer)', () => {
    const text = buildMailboxBlock([
      msg({ type: 'btw', id: 'm_btw' }),
      msg({ type: 'status', id: 'm_status' }),
    ]).text;
    expect(text).not.toContain('Action required');
  });

  it('does NOT add a CTA paragraph for plain note messages', () => {
    const text = buildMailboxBlock([msg({ type: 'note' })]).text;
    expect(text).not.toContain('Action required');
    expect(text).not.toContain('adjust your approach');
    expect(text).not.toContain('Reply directly');
    expect(text).not.toContain('Act on it');
    expect(text).not.toContain('Factor this result');
    expect(text).not.toContain('review request');
  });

  it('appends the review CTA saying an immediate reply is not required', () => {
    const text = buildMailboxBlock([msg({ type: 'review', id: 'm_review' })]).text;
    expect(text).toContain('This is a review request');
    expect(text).toContain('an immediate reply is not required');
  });

  it('treats review messages as actionable (triggers Action required footer)', () => {
    // Review is passive — the model is NOT waiting on a reply — but the
    // operator still wants it acknowledged in the conversation, so it
    // counts toward hasActionable. Pair with note to ensure review
    // (not note) is what flips the flag.
    const text = buildMailboxBlock([
      msg({ type: 'note', id: 'm_note' }),
      msg({ type: 'review', id: 'm_review' }),
    ]).text;
    expect(text).toContain('Action required: address the items above');
  });

  // ── Action footer ──────────────────────────────────────────────────────

  it('omits the "Action required" footer when no ask/assign/result is present', () => {
    const text = buildMailboxBlock([
      msg({ type: 'note', id: 'm_note' }),
      msg({ type: 'btw', id: 'm_btw' }),
      msg({ type: 'steer', id: 'm_steer' }),
    ]).text;
    expect(text).not.toContain('Action required');
  });

  it('includes the "Action required" footer when at least one ask/assign/result is present', () => {
    const text = buildMailboxBlock([
      msg({ type: 'note', id: 'm_note' }),
      msg({ type: 'ask', id: 'm_ask' }),
    ]).text;
    expect(text).toContain('Action required: address the items above');
    expect(text).toContain('mailbox action=ack messageId=<id> completed=true');
  });

  // ── Render order — steer messages always come first ───────────────────

  it('renders a steer message before non-steer messages (steer-first ordering)', () => {
    const text = buildMailboxBlock([
      msg({ type: 'ask', id: 'm_ask', subject: 'ask-first', body: 'b1' }),
      msg({ type: 'result', id: 'm_result', subject: 'result-mid', body: 'b2' }),
      msg({ type: 'steer', id: 'm_steer', subject: 'steer-last-input', body: 'b3' }),
      msg({ type: 'note', id: 'm_note', subject: 'note-mid', body: 'b4' }),
    ]).text;

    // The steer block must appear before the ask/result blocks, even though
    // steer was the third message in the input array. If ordering regresses
    // back to insertion order, the steer block would appear after the ask
    // and result blocks — and these expectations would flip.
    const steerIdx = text.indexOf('--- 🔄 STEER');
    const askIdx = text.indexOf('--- ❓ ASK');
    const resultIdx = text.indexOf('--- ✅ RESULT');
    expect(steerIdx).toBeGreaterThan(-1);
    expect(askIdx).toBeGreaterThan(-1);
    expect(resultIdx).toBeGreaterThan(-1);
    expect(steerIdx).toBeLessThan(askIdx);
    expect(steerIdx).toBeLessThan(resultIdx);
    // Subject must come from the actual steer message, not from any other block.
    expect(text.slice(steerIdx)).toContain('Subject: steer-last-input');
  });

  it("does not mutate the caller's messages array (render order is local)", () => {
    const messages = [msg({ type: 'ask', id: 'm_ask' }), msg({ type: 'steer', id: 'm_steer' })];
    const beforeIds = messages.map((m) => m.id);
    buildMailboxBlock(messages);
    const afterIds = messages.map((m) => m.id);
    expect(afterIds).toEqual(beforeIds);
  });

  it('keeps insertion order among non-steer messages', () => {
    const text = buildMailboxBlock([
      msg({ type: 'note', id: 'm_note_1', subject: 'first-note' }),
      msg({ type: 'btw', id: 'm_btw_1', subject: 'mid-btw' }),
      msg({ type: 'note', id: 'm_note_2', subject: 'last-note' }),
    ]).text;
    const firstNoteIdx = text.indexOf('first-note');
    const btwIdx = text.indexOf('mid-btw');
    const lastNoteIdx = text.indexOf('last-note');
    expect(firstNoteIdx).toBeLessThan(btwIdx);
    expect(btwIdx).toBeLessThan(lastNoteIdx);
  });
});

describe('removeInjectedMailboxBlocks', () => {
  it('removes only the injected raw mail while preserving the original user content', () => {
    const mailboxBlock = buildMailboxBlock([msg({ type: 'result', body: 'raw report' })]);
    const messages = [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'original request' }, mailboxBlock],
        _estTokens: 999,
      },
    ];

    const cleaned = removeInjectedMailboxBlocks(messages, [mailboxBlock]);

    expect(cleaned.changed).toBe(true);
    expect(cleaned.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'original request' }] },
    ]);
  });

  it('drops a synthetic user message that contained only raw mail', () => {
    const mailboxBlock = buildMailboxBlock([msg({ type: 'note', body: 'read and move on' })]);
    const messages = [
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'working' }] },
      { role: 'user' as const, content: [mailboxBlock] },
    ];

    const cleaned = removeInjectedMailboxBlocks(messages, [mailboxBlock]);

    expect(cleaned.messages).toEqual([messages[0]]);
  });

  it('leaves assistant conclusions and tool history untouched', () => {
    const mailboxBlock = buildMailboxBlock([msg({ type: 'steer', body: 'use plan B' })]);
    const messages = [
      { role: 'user' as const, content: [mailboxBlock] },
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'Durable conclusion: use plan B.' }],
      },
    ];

    const cleaned = removeInjectedMailboxBlocks(messages, [mailboxBlock]);

    expect(cleaned.messages).toEqual([messages[1]]);
  });
});

// ── createMailboxChecker ──────────────────────────────────────────────────
// Tests for the per-iteration mailbox probe. The checker is created once
// per agent (attachMailboxChecker) and called at the top of every iteration
// — these tests pin down its dedup, batching, identity-derivation, and
// GC contracts.

/**
 * Build a minimal Mailbox stub. Only `query` and `ackMany` are wired; the
 * rest are vi.fn() no-ops because createMailboxChecker never calls them.
 * Tests inject a queue of query responses and assert on the ackMany batch.
 *
 * The `ackMany` mock returns the full `MailboxMessage` shape (including
 * `readBy` and `timestamp`) so it matches the production signature —
 * tests that don't inspect the return value still benefit from the
 * type-level assurance that we're mocking what the contract promises.
 */
function fakeMailbox(
  queryResponses: MailboxMessage[][],
): Mailbox & { queryMock: ReturnType<typeof vi.fn>; ackManyMock: ReturnType<typeof vi.fn> } {
  const queryMock = vi.fn(async (query: MailboxQuery) => {
    const messages = queryResponses.shift() ?? [];
    const readerId = query.unreadBy;
    if (!readerId) return messages;
    return messages.filter((message) =>
      isMailboxMessageVisibleTo(message, readerId, query.readerRole),
    );
  });
  const ackManyMock = vi.fn(async (input: { acks: Array<{ messageId: string }> }) =>
    input.acks.map((a) =>
      msg({
        id: a.messageId,
        type: 'note',
        readBy: { [a.messageId]: '2026-06-29T00:00:00.000Z' },
      }),
    ),
  );
  const stub = {
    send: vi.fn(),
    query: queryMock,
    ack: vi.fn(),
    ackMany: ackManyMock,
    getAgentStatuses: vi.fn(async () => []),
    getOnlineAgents: vi.fn(async () => []),
    registerAgent: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
    unreadCount: vi.fn(async () => 0),
    close: vi.fn(async () => {}),
    clearAll: vi.fn(async () => {}),
    purgeStale: vi.fn(async () => ({
      completedPurged: 0,
      incompletePurged: 0,
      totalPurged: 0,
      remaining: 0,
    })),
    registerClient: vi.fn(async () => {}),
    clientHeartbeat: vi.fn(async () => {}),
    getClientStatuses: vi.fn(async () => []),
    purgeClients: vi.fn(async () => 0),
  };
  return Object.assign(stub as unknown as Mailbox, { queryMock, ackManyMock });
}

describe('createMailboxChecker', () => {
  it('returns empty when the mailbox has no unread mail for this address', async () => {
    const mb = fakeMailbox([[]]);
    const check = createMailboxChecker({ mailbox: mb, agentId: 'leader@a1b2' });
    const result = await check();
    expect(result).toEqual([]);
    expect(mb.queryMock).toHaveBeenCalledTimes(1);
    expect(mb.queryMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'leader@a1b2', unreadBy: 'leader@a1b2', limit: 10 }),
    );
    expect(mb.ackManyMock).not.toHaveBeenCalled();
  });

  it('queries the agentId address and returns the matching unread messages', async () => {
    const messages = [
      msg({ type: 'note', to: 'leader@a1b2', from: 'worker@b2c3' }),
      msg({ type: 'ask', to: 'leader@a1b2', from: 'reviewer@c3d4' }),
    ];
    const mb = fakeMailbox([messages]);
    const check = createMailboxChecker({ mailbox: mb, agentId: 'leader@a1b2' });
    const result = await check();
    expect(result.map((m) => m.id)).toEqual([messages[0]!.id, messages[1]!.id]);
  });

  it('does not deliver leaders-only mail to a subagent', async () => {
    const leadersOnly = msg({ type: 'broadcast', to: '*', audience: 'leaders', id: 'm_leaders' });
    const mb = fakeMailbox([[leadersOnly]]);
    const check = createMailboxChecker({
      mailbox: mb,
      agentId: 'worker@a1b2',
      role: 'executor',
      broadcastFloor: '1970-01-01T00:00:00.000Z',
    });

    expect(await check()).toEqual([]);
    expect(mb.ackManyMock).not.toHaveBeenCalled();
  });

  it('delivers leaders-only mail to the leader on any surface', async () => {
    const leadersOnly = msg({ type: 'broadcast', to: '*', audience: 'leaders', id: 'm_leaders' });
    const mb = fakeMailbox([[leadersOnly]]);
    const check = createMailboxChecker({
      mailbox: mb,
      agentId: 'leader@a1b2',
      broadcastFloor: '1970-01-01T00:00:00.000Z',
    });

    expect((await check()).map((m) => m.id)).toEqual(['m_leaders']);
    expect(mb.ackManyMock).toHaveBeenCalledTimes(1);
  });

  it('queries the current session address in addition to agentId and aliases', async () => {
    const sessionMessage = msg({
      type: 'broadcast',
      to: '@session:session-a',
      id: 'm_session',
    });
    const mb = fakeMailbox([[], [], [sessionMessage]]);
    const check = createMailboxChecker({
      mailbox: mb,
      agentId: 'leader@a1b2',
      aliases: ['leader'],
      sessionId: 'session-a',
    });

    const result = await check();

    expect(result.map((m) => m.id)).toEqual(['m_session']);
    expect(mb.queryMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ to: '@session:session-a', unreadBy: 'leader@a1b2' }),
    );
  });

  it('queries each alias in addition to agentId and dedups broadcast hits', async () => {
    // The same message arrives via both queries when `to === '*'` matches
    // every address. The checker must dedup by id so the recipient doesn't
    // see the broadcast twice.
    const broadcast = msg({ type: 'broadcast', to: '*', from: 'human@webui', id: 'm_bcast' });
    const direct = msg({ type: 'note', to: 'leader@a1b2', from: 'worker@b2c3', id: 'm_direct' });
    const mb = fakeMailbox([
      // First query call (agentId) returns both — broadcast + direct.
      [broadcast, direct],
      // Second query call (alias) returns the same broadcast again.
      [broadcast],
    ]);
    const check = createMailboxChecker({
      mailbox: mb,
      agentId: 'leader@a1b2',
      aliases: ['leader'],
      // This test is about alias fan-out and dedup, not broadcast retention:
      // open the floor so `msg()`'s fixed past timestamp stays deliverable.
      broadcastFloor: '1970-01-01T00:00:00.000Z',
    });
    const result = await check();
    expect(result.map((m) => m.id).sort()).toEqual(['m_bcast', 'm_direct']);
    // Both queries fired (Promise.all), and the dedup collapsed the duplicate broadcast.
    expect(mb.queryMock).toHaveBeenCalledTimes(2);
    expect(mb.queryMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ to: 'leader@a1b2' }));
    expect(mb.queryMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ to: 'leader' }));
  });

  it('skips already-injected messages across calls (injectedIds dedup)', async () => {
    const m1 = msg({ type: 'note', id: 'm_1' });
    const m2 = msg({ type: 'note', id: 'm_2' });
    const mb = fakeMailbox([
      [m1, m2],
      [m1, m2],
    ]);
    const check = createMailboxChecker({ mailbox: mb, agentId: 'leader@a1b2' });
    const first = await check();
    const second = await check();
    // First call sees both; second call sees both still in the mailbox but
    // already-injected set blocks them from being re-injected.
    expect(first.map((m) => m.id)).toEqual(['m_1', 'm_2']);
    expect(second).toEqual([]);
  });

  it('skips completed messages even when they are unread', async () => {
    // completed messages must NOT be re-injected on subsequent iterations —
    // they're terminal state, not actionable. The filter check is
    // `!m.completed` in addition to `!injectedIds.has(m.id)`.
    const completed = msg({ type: 'result', id: 'm_done', completed: true });
    const fresh = msg({ type: 'note', id: 'm_fresh' });
    const mb = fakeMailbox([[completed, fresh]]);
    const check = createMailboxChecker({ mailbox: mb, agentId: 'leader@a1b2' });
    const result = await check();
    expect(result.map((m) => m.id)).toEqual(['m_fresh']);
  });

  it('applies include filter before injection and read receipts', async () => {
    const messages = [
      msg({ type: 'control', id: 'm_control', subject: 'interrupt' }),
      msg({ type: 'broadcast', id: 'm_broadcast', to: '*' }),
    ];
    const mb = fakeMailbox([messages]);
    const check = createMailboxChecker({
      mailbox: mb,
      agentId: 'leader@a1b2',
      include: (m) => m.type !== 'control',
      // Testing the include predicate, not broadcast retention.
      broadcastFloor: '1970-01-01T00:00:00.000Z',
    });

    const result = await check();

    expect(result.map((m) => m.id)).toEqual(['m_broadcast']);
    expect(mb.ackManyMock).toHaveBeenCalledTimes(1);
    const call = mb.ackManyMock.mock.calls[0]![0] as { acks: Array<{ messageId: string }> };
    expect(call.acks.map((a) => a.messageId)).toEqual(['m_broadcast']);
  });

  it('can peek without acking so background awareness does not consume normal delivery', async () => {
    const messages = [msg({ type: 'ask', id: 'm_ask' })];
    const mb = fakeMailbox([messages]);
    const check = createMailboxChecker({ mailbox: mb, agentId: 'leader@a1b2', ack: false });

    const result = await check();

    expect(result.map((m) => m.id)).toEqual(['m_ask']);
    expect(mb.ackManyMock).not.toHaveBeenCalled();
  });

  it('auto-acks injected messages in a single batched ackMany call', async () => {
    // The checker must NOT call ack() per message — that path does a full
    // read-modify-rewrite of the mailbox file per call. ackMany batches the
    // writes into one lock + one rewrite regardless of how many fresh
    // messages were injected this iteration.
    const messages = [
      msg({ type: 'note', id: 'm_a' }),
      msg({ type: 'ask', id: 'm_b' }),
      msg({ type: 'result', id: 'm_c' }),
    ];
    const mb = fakeMailbox([messages]);
    const check = createMailboxChecker({ mailbox: mb, agentId: 'leader@a1b2' });
    await check();
    expect(mb.ackManyMock).toHaveBeenCalledTimes(1);
    const call = mb.ackManyMock.mock.calls[0]![0] as {
      acks: Array<{ messageId: string; readerId: string; read: boolean }>;
    };
    expect(call.acks.map((a) => a.messageId).sort()).toEqual(['m_a', 'm_b', 'm_c']);
    // Every ack uses the live agentId and the read flag.
    expect(call.acks.every((a) => a.readerId === 'leader@a1b2' && a.read === true)).toBe(true);
  });

  it('re-derives the agentId via the getter on every call (session swap safe)', async () => {
    // The closure must NOT capture the agentId at construction time —
    // attachMailboxChecker passes a getter specifically so an in-process
    // session swap (resume / session.new / project switch) moves the
    // identity with it. If the checker froze on the first id, the second
    // call would query the wrong address.
    let currentId = 'leader@aaaa';
    const mb = fakeMailbox([[], []]);
    const check = createMailboxChecker({
      mailbox: mb,
      agentId: () => currentId,
    });
    await check();
    currentId = 'leader@bbbb';
    await check();
    expect(mb.queryMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ to: 'leader@aaaa', unreadBy: 'leader@aaaa' }),
    );
    expect(mb.queryMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ to: 'leader@bbbb', unreadBy: 'leader@bbbb' }),
    );
  });

  it('handles 1100+ unique message ids without crashing (injectedIds is bounded internally)', async () => {
    // The injectedIds Set lives inside the checker closure and is not
    // directly observable from outside, so we cannot assert on its size
    // post-GC. What we CAN assert: driving the checker through >1000
    // unique ids in a single session completes without crashing and
    // returns the expected total. The internal GC at 1000 (keeping the
    // last 500) is exercised as a side effect.
    //
    // If GC did not exist, the set would grow unbounded — still correct
    // behaviorally, but a slow memory leak in long sessions. Pinning the
    // "no crash, all messages accounted for" contract is what we can
    // verify from the outside.
    const allIds = Array.from({ length: 1100 }, (_, i) => `m_${String(i).padStart(4, '0')}`);
    const responses: MailboxMessage[][] = [];
    for (let i = 0; i < 1100; i += 10) {
      responses.push(allIds.slice(i, i + 10).map((id) => msg({ type: 'note', id })));
    }
    const mb = fakeMailbox(responses);
    const check = createMailboxChecker({ mailbox: mb, agentId: 'leader@a1b2' });
    let injectedCount = 0;
    for (let i = 0; i < 110; i += 1) {
      injectedCount += (await check()).length;
    }
    expect(injectedCount).toBe(1100);
  });

  it('swallows checker errors and returns empty (broken mailbox must not crash)', async () => {
    // attachMailboxChecker wraps creation in a try/catch, but a per-call
    // throw (e.g. mailbox process crash mid-iteration) must also degrade
    // gracefully — the agent loop has zero tolerance for mailbox failures.
    const mb = {
      query: vi.fn(async () => {
        throw new Error('mailbox file disappeared');
      }),
      ackMany: vi.fn(),
    } as unknown as Mailbox;
    const check = createMailboxChecker({ mailbox: mb, agentId: 'leader@a1b2' });
    const result = await check();
    expect(result).toEqual([]);
    // The throw must NOT have propagated an ackMany attempt either.
    expect(mb.ackMany as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

// ── broadcast floor ───────────────────────────────────────────────────────
// Regression: read receipts are keyed by `agentId`, which is derived from the
// session id. A NEW session therefore gets an identity present in no `readBy`
// map, so `unreadBy` matched the entire retained backlog and the leader
// re-processed broadcasts from work that had already shipped.

describe('createMailboxChecker — broadcast floor', () => {
  const FLOOR = '2026-07-21T12:00:00.000Z';

  it('drops broadcasts sent before this session existed', async () => {
    const mb = fakeMailbox([
      [msg({ type: 'broadcast', id: 'm_old', to: '*', timestamp: '2026-07-21T09:48:30.000Z' })],
    ]);
    const check = createMailboxChecker({
      mailbox: mb,
      agentId: 'leader@new1',
      broadcastFloor: FLOOR,
    });

    expect(await check()).toEqual([]);
  });

  it('does NOT ack the broadcasts it drops', async () => {
    // Acking would stamp this session onto the whole backlog on the very
    // first check — the write amplification that produced 26k ack records
    // against 630 messages. Dropped broadcasts must simply age out.
    const mb = fakeMailbox([
      [msg({ type: 'broadcast', id: 'm_old', to: '*', timestamp: '2026-07-20T00:00:00.000Z' })],
    ]);
    const check = createMailboxChecker({
      mailbox: mb,
      agentId: 'leader@new1',
      broadcastFloor: FLOOR,
    });

    await check();
    expect(mb.ackManyMock).not.toHaveBeenCalled();
  });

  it('still delivers broadcasts sent after the floor', async () => {
    const mb = fakeMailbox([
      [msg({ type: 'broadcast', id: 'm_new', to: '*', timestamp: '2026-07-21T12:00:01.000Z' })],
    ]);
    const check = createMailboxChecker({
      mailbox: mb,
      agentId: 'leader@new1',
      broadcastFloor: FLOOR,
    });

    expect((await check()).map((m) => m.id)).toEqual(['m_new']);
  });

  it('never filters DIRECTED mail, however old', async () => {
    // A human running `wstack mailbox send --to leader` and then starting a
    // session expects delivery. Only ambient broadcasts are floored.
    const old = '2026-01-01T00:00:00.000Z';
    const mb = fakeMailbox([
      [
        msg({ type: 'note', id: 'm_direct', to: 'leader@new1', timestamp: old }),
        msg({ type: 'ask', id: 'm_alias', to: 'leader', timestamp: old }),
      ],
    ]);
    const check = createMailboxChecker({
      mailbox: mb,
      agentId: 'leader@new1',
      broadcastFloor: FLOOR,
    });

    expect((await check()).map((m) => m.id).sort()).toEqual(['m_alias', 'm_direct']);
  });

  it('defaults the floor to checker construction time', async () => {
    const mb = fakeMailbox([
      [msg({ type: 'broadcast', id: 'm_past', to: '*', timestamp: '2020-01-01T00:00:00.000Z' })],
    ]);
    const check = createMailboxChecker({ mailbox: mb, agentId: 'leader@new1' });

    expect(await check()).toEqual([]);
  });
});
