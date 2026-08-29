import { describe, expect, it, vi } from 'vitest';
import { Context } from '../../src/core/context.js';
import type { StateChange } from '../../src/core/conversation-state.js';
import { HybridCompactor } from '../../src/execution/compactor.js';
import { IntelligentCompactor } from '../../src/execution/intelligent-compactor.js';
import type { Message, Provider, SessionWriter, TextBlock } from '../../src/index.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';

/**
 * L1-A regression: prove the reactive-state migration actually fires
 * onChange events for every state-mutating path. If a future commit
 * reintroduces a direct `ctx.messages.push(...)`, the subscriber sees
 * fewer changes than expected and this test fails.
 */

const fakeProvider = {} as Provider;
const fakeSession: SessionWriter = {
  id: 'sess-l1a',
  pendingToolUses: [],
  append: async () => undefined,
  appendBatch: async () => undefined,
  flush: async () => undefined,
  close: async () => undefined,
};

function mkContext(): Context {
  return new Context({
    systemPrompt: [{ type: 'text', text: 'sys' } as TextBlock],
    provider: fakeProvider,
    session: fakeSession,
    signal: new AbortController().signal,
    tokenCounter: new DefaultTokenCounter(),
    cwd: '/cwd',
    projectRoot: '/root',
    model: 'm',
  });
}

function bigMessages(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', content: `user message ${i} ${'x'.repeat(500)}` });
    out.push({ role: 'assistant', content: `assistant reply ${i} ${'y'.repeat(500)}` });
  }
  return out;
}

describe('L1-A: ctx.state is the single source of reactive truth', () => {
  it('Context exposes a stable .state ConversationState wrapper', () => {
    const ctx = mkContext();
    expect(ctx.state).toBeDefined();
    // Accessing twice returns the same instance (lazy cache).
    expect(ctx.state).toBe(ctx.state);
    // Mutating through state is visible on ctx.messages.
    ctx.state.appendMessage({ role: 'user', content: 'hi' });
    expect(ctx.messages).toHaveLength(1);
  });

  it('serializes exact journal events in state-mutation order and retries an append failure', async () => {
    const persisted: Array<{ type: string; message?: Message }> = [];
    let calls = 0;
    const session = {
      ...fakeSession,
      append: vi.fn(async (event: Parameters<SessionWriter['append']>[0]) => {
        calls += 1;
        if (calls === 2) throw new Error('transient write failure');
        persisted.push(event as { type: string; message?: Message });
      }),
    } satisfies SessionWriter;
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'sys' }],
      provider: fakeProvider,
      session,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/cwd',
      projectRoot: '/root',
      model: 'm',
    });

    ctx.state.appendMessage({ role: 'user', content: 'one' });
    ctx.state.appendMessage({ role: 'assistant', content: 'two' });
    ctx.state.appendMessage({ role: 'user', content: 'three' });
    await ctx.flushConversationJournal();

    expect(session.append).toHaveBeenCalledTimes(4);
    expect(persisted.map((event) => event.message?.content)).toEqual(['one', 'two', 'three']);
  });

  it('keeps failed journal events queued and surfaces persistent append failure on flush', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const session = {
      ...fakeSession,
      append: vi.fn(async () => {
        throw new Error('disk unavailable');
      }),
    } satisfies SessionWriter;
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'sys' }],
      provider: fakeProvider,
      session,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/cwd',
      projectRoot: '/root',
      model: 'm',
    });

    ctx.state.appendMessage({ role: 'user', content: 'must survive' });
    await expect(ctx.flushConversationJournal()).rejects.toThrow('disk unavailable');

    expect(session.append).toHaveBeenCalledTimes(3);
    expect(ctx._conversationJournalQueue).toHaveLength(1);
    expect(ctx._conversationJournalQueue[0]?.event).toMatchObject({
      type: 'message_appended',
      message: expect.objectContaining({ content: 'must survive' }),
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"event":"session.conversation_journal_write_failed"'),
    );
    warn.mockRestore();
  });

  it('captures the writer active at mutation time when a session is swapped', async () => {
    const oldAppend = vi.fn(async () => undefined);
    const nextAppend = vi.fn(async () => undefined);
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'sys' }],
      provider: fakeProvider,
      session: { ...fakeSession, id: 'old', append: oldAppend },
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/cwd',
      projectRoot: '/root',
      model: 'm',
    });

    ctx.state.appendMessage({ role: 'user', content: 'old session' });
    ctx.session = { ...fakeSession, id: 'next', append: nextAppend };
    ctx.state.appendMessage({ role: 'user', content: 'next session' });
    await ctx.flushConversationJournal();

    expect(oldAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message_appended',
        message: expect.objectContaining({ content: 'old session' }),
      }),
    );
    expect(nextAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message_appended',
        message: expect.objectContaining({ content: 'next session' }),
      }),
    );
  });

  it('drops conversation journal events when a placeholder writer has no append function', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'sys' }],
      provider: fakeProvider,
      session: { id: 'placeholder' } as SessionWriter,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/cwd',
      projectRoot: '/root',
      model: 'm',
    });

    ctx.state.replaceMessages([{ role: 'user', content: 'restored' }]);
    await expect(ctx.flushConversationJournal()).resolves.toBeUndefined();

    expect(ctx._conversationJournalQueue).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"event":"session.conversation_journal_drop"'),
    );
    warn.mockRestore();
  });

  it('bounds pending journal work and collapses pressure into a snapshot', async () => {
    let releaseFirstWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const session = {
      ...fakeSession,
      append: vi.fn(async () => firstWrite),
    } satisfies SessionWriter;
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'sys' }],
      provider: fakeProvider,
      session,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/cwd',
      projectRoot: '/root',
      model: 'm',
    });

    for (let index = 0; index < 400; index += 1) {
      ctx.state.appendMessage({ role: 'user', content: `message ${index}` });
    }

    const pending = Reflect.get(ctx, '_conversationJournalQueue') as Array<{
      event: { type: string };
    }>;
    expect(pending.length).toBeLessThanOrEqual(256);
    expect(pending.some(({ event }) => event.type === 'messages_replaced')).toBe(true);

    releaseFirstWrite?.();
    await ctx.flushConversationJournal();
  });

  it('appendMessage via ctx.state fires onChange', () => {
    const ctx = mkContext();
    const changes: StateChange[] = [];
    ctx.state.onChange((c) => changes.push(c));
    ctx.state.appendMessage({ role: 'user', content: 'one' });
    ctx.state.appendMessage({ role: 'assistant', content: 'two' });
    expect(changes).toHaveLength(2);
    expect(changes[0]!.kind).toBe('message_appended');
    expect(changes[1]!.kind).toBe('message_appended');
  });

  it('HybridCompactor.compact rewrites via replaceMessages (onChange fires once)', async () => {
    const ctx = mkContext();
    // Seed enough turns that the compactor decides to collapse.
    for (const m of bigMessages(40)) ctx.state.appendMessage(m);

    const baseline = [...ctx.messages];
    expect(baseline.length).toBeGreaterThan(20);

    const seen: StateChange[] = [];
    ctx.state.onChange((c) => seen.push(c));

    const compactor = new HybridCompactor({ preserveK: 3 });
    await compactor.compact(ctx, { aggressive: true });

    // The compactor must produce at least one messages_replaced change.
    expect(seen.some((c) => c.kind === 'messages_replaced')).toBe(true);
    // And the messages list actually shrank.
    expect(ctx.messages.length).toBeLessThan(baseline.length);
  });

  it('IntelligentCompactor.compact rewrites via replaceMessages', async () => {
    const ctx = mkContext();
    for (const m of bigMessages(40)) ctx.state.appendMessage(m);

    const seen: StateChange[] = [];
    ctx.state.onChange((c) => seen.push(c));

    const ic = new IntelligentCompactor({ preserveK: 3 });
    await ic.compact(ctx, { aggressive: true });

    expect(seen.some((c) => c.kind === 'messages_replaced')).toBe(true);
  });

  it('unsubscribe stops further callbacks', () => {
    const ctx = mkContext();
    const cb = vi.fn();
    const off = ctx.state.onChange(cb);
    ctx.state.appendMessage({ role: 'user', content: 'a' });
    off();
    ctx.state.appendMessage({ role: 'user', content: 'b' });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
