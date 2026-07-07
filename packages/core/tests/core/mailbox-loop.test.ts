import { describe, expect, it, vi } from 'vitest';
import {
  buildMailboxBlock,
  buildMailboxBtwAwarenessBlock,
  createMailboxChecker,
  injectPendingMailboxMessages,
} from '../../src/index.js';
import type { Mailbox } from '../../src/coordination/mailbox-types.js';
import type { MailboxMessage } from '../../src/coordination/mailbox-types.js';

function msg(partial: Partial<MailboxMessage> & Pick<MailboxMessage, 'type'>): MailboxMessage {
  return {
    id: partial.id ?? `m_${Math.random().toString(36).slice(2)}`,
    from: partial.from ?? 'human@webui',
    to: partial.to ?? 'leader@abcd',
    type: partial.type,
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
    expect(text).toContain('After your current operation reaches a stopping point, adjust your approach');
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

  it('does not mutate the caller\'s messages array (render order is local)', () => {
    const messages = [
      msg({ type: 'ask', id: 'm_ask' }),
      msg({ type: 'steer', id: 'm_steer' }),
    ];
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
  const queryMock = vi.fn(async () => {
    return queryResponses.shift() ?? [];
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
    purgeStale: vi.fn(async () => ({ completedPurged: 0, incompletePurged: 0, totalPurged: 0, remaining: 0 })),
    registerClient: vi.fn(async () => {}),
    clientHeartbeat: vi.fn(async () => {}),
    getClientStatuses: vi.fn(async () => []),
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
    });
    const result = await check();
    expect(result.map((m) => m.id).sort()).toEqual(['m_bcast', 'm_direct']);
    // Both queries fired (Promise.all), and the dedup collapsed the duplicate broadcast.
    expect(mb.queryMock).toHaveBeenCalledTimes(2);
    expect(mb.queryMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ to: 'leader@a1b2' }),
    );
    expect(mb.queryMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ to: 'leader' }),
    );
  });

  it('skips already-injected messages across calls (injectedIds dedup)', async () => {
    const m1 = msg({ type: 'note', id: 'm_1' });
    const m2 = msg({ type: 'note', id: 'm_2' });
    const mb = fakeMailbox([[m1, m2], [m1, m2]]);
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
    const call = mb.ackManyMock.mock.calls[0]![0] as { acks: Array<{ messageId: string; readerId: string; read: boolean }> };
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
    expect((mb.ackMany as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
