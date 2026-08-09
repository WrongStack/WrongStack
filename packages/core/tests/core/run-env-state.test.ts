import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '../../src/core/context.js';
import { ConversationState, wrapAsState } from '../../src/core/conversation-state.js';
import { extractRunEnv } from '../../src/core/run-env.js';
import type { Message, Provider, SessionWriter, TextBlock } from '../../src/index.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';

const fakeProvider = {} as Provider;
const fakeSession: SessionWriter = {
  id: 'sess-1',
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

const userMessage = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

describe('extractRunEnv', () => {
  it('projects the immutable subset of Context', () => {
    const ctx = mkContext();
    const env = extractRunEnv(ctx);
    expect(env.provider).toBe(ctx.provider);
    expect(env.session).toBe(ctx.session);
    expect(env.cwd).toBe('/cwd');
    expect(env.projectRoot).toBe('/root');
    expect(env.model).toBe('m');
    expect(env.systemPrompt).toBe(ctx.systemPrompt);
  });

  it('returned object is frozen at the top level', () => {
    const env = extractRunEnv(mkContext());
    expect(Object.isFrozen(env)).toBe(true);
    expect(() => {
      // @ts-expect-error readonly
      env.model = 'mutated';
    }).toThrow();
  });

  it('snapshots primitive fields at extract time', () => {
    // The view holds references to mutable objects (e.g. tools array),
    // but primitive fields (model, cwd) are copied at extract time.
    const ctx = mkContext();
    const env = extractRunEnv(ctx);
    ctx.model = 'changed-after-extract';
    expect(env.model).toBe('m'); // top-level was snapshotted at extract time
  });

  it('exposes tools as readonly array', () => {
    const ctx = mkContext();
    const env = extractRunEnv(ctx);
    expect(env.tools).toBe(ctx.tools);
  });
});

describe('ConversationState — read API', () => {
  it('mirrors the underlying Context fields', () => {
    const ctx = mkContext();
    ctx.state.appendMessage(userMessage('hi'));
    ctx.todos.push({ id: 't1', content: 'do', status: 'pending' });
    ctx.meta.foo = 'bar';

    const state = wrapAsState(ctx);
    expect(state.messages).toHaveLength(1);
    expect(state.todos).toHaveLength(1);
    expect(state.meta.foo).toBe('bar');
  });

  it('snapshot() returns shallow copies that are isolated from later mutations', () => {
    const ctx = mkContext();
    ctx.state.appendMessage(userMessage('first'));
    const state = wrapAsState(ctx);

    const snap = state.snapshot();
    state.appendMessage(userMessage('second'));

    expect(snap.messages).toHaveLength(1);
    expect(state.messages).toHaveLength(2);
  });
});

describe('ConversationState — write API and onChange', () => {
  it('appendMessage emits message_appended and updates the array', () => {
    const ctx = mkContext();
    const state = wrapAsState(ctx);
    const observed: unknown[] = [];
    state.onChange((c) => observed.push(c));

    const m = userMessage('hello');
    state.appendMessage(m);

    expect(ctx.messages).toEqual([m]);
    expect(observed).toEqual([{ kind: 'message_appended', message: m }]);
  });

  it('replaceMessages swaps the contents and fires the change', () => {
    const ctx = mkContext();
    ctx.state.appendMessage(userMessage('old'));
    const state = wrapAsState(ctx);
    const cb = vi.fn();
    state.onChange(cb);

    state.replaceMessages([userMessage('new1'), userMessage('new2')]);

    expect(ctx.messages).toHaveLength(2);
    expect(cb).toHaveBeenCalledOnce();
    const [change] = cb.mock.calls[0]!;
    expect((change as { kind: string }).kind).toBe('messages_replaced');
  });

  it('appendBlockToLastUserMessage folds a block without copying the array', () => {
    const ctx = mkContext();
    ctx.state.appendMessage(userMessage('first'));
    ctx.state.appendMessage(userMessage('second'));
    const originalArray = ctx.messages;
    const state = wrapAsState(ctx);
    const cb = vi.fn();
    state.onChange(cb);

    const block = { type: 'text', text: 'btw note' } as TextBlock;
    const folded = state.appendBlockToLastUserMessage(block);

    expect(folded).toBe(true);
    // Same array reference — no O(n) copy/realloc.
    expect(ctx.messages).toBe(originalArray);
    expect(ctx.messages).toHaveLength(2);
    // Last message now has two content blocks.
    const last = ctx.messages[1]!;
    expect(Array.isArray(last.content)).toBe(true);
    expect((last.content as Array<{ text?: string }>).map((b) => b.text)).toEqual([
      'second',
      'btw note',
    ]);
    // Recomputed token estimate is cached for the one changed message.
    expect(last._estTokens).toBeGreaterThan(0);
    // First message's cache is untouched.
    expect(ctx.messages[0]!._estTokens).toBeGreaterThan(0);
    expect(cb).toHaveBeenCalledOnce();
    expect((cb.mock.calls[0]![0] as { kind: string }).kind).toBe('message_updated');
  });

  it('appendBlockToLastUserMessage returns false when there is no trailing user message', () => {
    const ctx = mkContext();
    ctx.state.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] });
    const state = wrapAsState(ctx);
    const cb = vi.fn();
    state.onChange(cb);

    const folded = state.appendBlockToLastUserMessage({ type: 'text', text: 'x' } as TextBlock);
    expect(folded).toBe(false);
    expect(cb).not.toHaveBeenCalled();
  });

  it('replaceTodos updates and notifies', () => {
    const ctx = mkContext();
    const state = wrapAsState(ctx);
    const cb = vi.fn();
    state.onChange(cb);

    state.replaceTodos([{ id: 'a', content: 'A', status: 'pending' }]);

    expect(ctx.todos).toHaveLength(1);
    expect((cb.mock.calls[0]![0] as { kind: string }).kind).toBe('todos_replaced');
  });

  it('preserves the final completed snapshot when the active todo list auto-clears', () => {
    const ctx = mkContext();
    const state = wrapAsState(ctx);
    const cb = vi.fn();
    state.onChange(cb);
    const completed = [{ id: 'a', content: 'A', status: 'completed' as const }];

    state.replaceTodos(completed);

    expect(ctx.todos).toEqual([]);
    expect(cb.mock.calls[0]?.[0]).toMatchObject({
      kind: 'todos_replaced',
      todos: [],
      completedSnapshot: completed,
    });
  });

  it('setMeta sets the value and emits meta_set', () => {
    const ctx = mkContext();
    const state = wrapAsState(ctx);
    const cb = vi.fn();
    state.onChange(cb);

    state.setMeta('k', { nested: 1 });

    expect(ctx.meta.k).toEqual({ nested: 1 });
    expect(cb.mock.calls[0]![0]).toEqual({ kind: 'meta_set', key: 'k', value: { nested: 1 } });
  });

  it('deleteMeta only fires when the key actually existed', () => {
    const ctx = mkContext();
    const state = wrapAsState(ctx);
    const cb = vi.fn();
    state.onChange(cb);

    state.deleteMeta('absent');
    expect(cb).not.toHaveBeenCalled();

    state.setMeta('present', 1);
    cb.mockClear();
    state.deleteMeta('present');
    expect(cb).toHaveBeenCalledOnce();
    expect((cb.mock.calls[0]![0] as { kind: string }).kind).toBe('meta_deleted');
    expect(ctx.meta.present).toBeUndefined();
  });

  it('clearMeta removes all keys and emits once', () => {
    const ctx = mkContext();
    const state = wrapAsState(ctx);
    const cb = vi.fn();
    state.setMeta('a', 1);
    state.setMeta('b', 2);
    state.onChange(cb);

    state.clearMeta();

    expect(ctx.meta).toEqual({});
    expect(cb).toHaveBeenCalledOnce();
    expect((cb.mock.calls[0]![0] as { kind: string }).kind).toBe('meta_cleared');
  });

  it('unsubscribe stops future notifications', () => {
    const state = wrapAsState(mkContext());
    const cb = vi.fn();
    const off = state.onChange(cb);

    state.appendMessage(userMessage('first'));
    off();
    state.appendMessage(userMessage('second'));

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('throwing listener does not block others', () => {
    const state = wrapAsState(mkContext());
    const good = vi.fn();
    state.onChange(() => {
      throw new Error('listener crash');
    });
    state.onChange(good);

    expect(() => state.appendMessage(userMessage('m'))).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });

  it('legacy mutation (ctx.messages.push) bypasses notifications by design', () => {
    // Documenting the migration tradeoff: until call sites switch to
    // state.appendMessage(), direct mutations are invisible. The wrapper
    // still SEES the new data (read accessor reflects it), but onChange
    // doesn't fire.
    const ctx = mkContext();
    const state = wrapAsState(ctx);
    const cb = vi.fn();
    state.onChange(cb);

    ctx.messages.push(userMessage('bypass'));

    expect(state.messages).toHaveLength(1);
    expect(cb).not.toHaveBeenCalled();
  });

  it('ConversationState constructor is the same as wrapAsState helper', () => {
    const ctx = mkContext();
    const a = new ConversationState(ctx);
    const b = wrapAsState(ctx);
    a.appendMessage(userMessage('via-class'));
    expect(b.messages).toEqual(a.messages);
  });

  describe('MAX_MESSAGES cap', () => {
    let ORIG_MAX: number;

    beforeEach(() => {
      ORIG_MAX = Context.MAX_MESSAGES;
      (Context as { MAX_MESSAGES: number }).MAX_MESSAGES = 3;
    });

    afterEach(() => {
      // Safety net: restore unconditionally to prevent static-state leakage
      // across tests if a prior test crashes or bails.
      (Context as { MAX_MESSAGES: number }).MAX_MESSAGES = ORIG_MAX;
    });

    it('drops oldest messages when cap is exceeded', () => {
      const ctx = mkContext();
      const state = new ConversationState(ctx);
      state.appendMessage(userMessage('msg-1'));
      state.appendMessage(userMessage('msg-2'));
      state.appendMessage(userMessage('msg-3'));
      // At 3 — exactly at the cap, no truncation.
      expect(ctx.messages.map((m) => (m.content as TextBlock[])[0]?.text)).toEqual([
        'msg-1',
        'msg-2',
        'msg-3',
      ]);

      // One more pushes the oldest out.
      state.appendMessage(userMessage('msg-4'));
      expect(ctx.messages.map((m) => (m.content as TextBlock[])[0]?.text)).toEqual([
        'msg-2',
        'msg-3',
        'msg-4',
      ]);
    });

    it('sets toolAdjacencyDirty on truncation', () => {
      const ctx = mkContext();
      expect(ctx.toolAdjacencyDirty).toBe(false);
      const state = new ConversationState(ctx);
      const cb = vi.fn();
      state.onChange(cb);
      for (let i = 0; i < 5; i++) {
        state.appendMessage(userMessage(`msg-${i}`));
      }
      // Cap of 3 means 2 were dropped → toolAdjacencyDirty must be true.
      expect(ctx.toolAdjacencyDirty).toBe(true);
      // An overflowing append emits BOTH halves of what it did, in order: the
      // message that arrived, then the eviction it caused. The append half is
      // not optional — it used to ride along inside the `messages_replaced`
      // snapshot, and dropping it when that became a delta silently lost every
      // message that triggered an eviction. The callback receives
      // (change, state); assert only the first argument.
      const kinds = cb.mock.calls.map((call) => (call[0] as { kind: string }).kind);
      expect(kinds.slice(-2)).toEqual(['message_appended', 'messages_dropped']);
      expect(cb).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'messages_dropped', count: 1 }),
        expect.anything(),
      );
    });

    it('does not set toolAdjacencyDirty when no truncation occurs', () => {
      const ctx = mkContext();
      const state = new ConversationState(ctx);
      state.appendMessage(userMessage('only-one'));
      expect(ctx.toolAdjacencyDirty).toBe(false);
    });

    it('applies the same cap to replaceMessages used by resume and rewind', () => {
      const ctx = mkContext();
      const state = new ConversationState(ctx);
      const cb = vi.fn();
      state.onChange(cb);

      state.replaceMessages(Array.from({ length: 8 }, (_, i) => userMessage(`resume-${i}`)));

      expect(ctx.messages).toHaveLength(3);
      expect(JSON.stringify(ctx.messages)).toContain('resume-7');
      expect(JSON.stringify(ctx.messages)).not.toContain('resume-0');
      expect(ctx.toolAdjacencyDirty).toBe(true);
      expect(cb).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: 'messages_replaced',
          messages: expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
        }),
        expect.anything(),
      );
    });
  });

  describe('MAX_MESSAGE_TOKENS cap', () => {
    let ORIG_COUNT: number;
    let ORIG_TOKENS: number;

    beforeEach(() => {
      ORIG_COUNT = Context.MAX_MESSAGES;
      ORIG_TOKENS = Context.MAX_MESSAGE_TOKENS;
      // Count cap out of the way — this block is about the size cap alone.
      (Context as { MAX_MESSAGES: number }).MAX_MESSAGES = 0;
      (Context as { MAX_MESSAGE_TOKENS: number }).MAX_MESSAGE_TOKENS = 100;
    });

    afterEach(() => {
      (Context as { MAX_MESSAGES: number }).MAX_MESSAGES = ORIG_COUNT;
      (Context as { MAX_MESSAGE_TOKENS: number }).MAX_MESSAGE_TOKENS = ORIG_TOKENS;
    });

    /** ~1 token per 4 chars, so 200 chars ≈ 50 tokens. */
    const fatMessage = (tag: string) => userMessage(`${tag}:${'x'.repeat(200)}`);

    it('drops oldest messages once the estimated size cap is exceeded', () => {
      const ctx = mkContext();
      const state = new ConversationState(ctx);
      for (let i = 0; i < 6; i++) state.appendMessage(fatMessage(`m-${i}`));

      const total = ctx.messages.reduce((sum, m) => sum + (m._estTokens ?? 0), 0);
      expect(total).toBeLessThanOrEqual(100);
      // Newest survives, oldest went first.
      expect(JSON.stringify(ctx.messages)).toContain('m-5');
      expect(JSON.stringify(ctx.messages)).not.toContain('m-0');
      expect(ctx.toolAdjacencyDirty).toBe(true);
    });

    it('never drops the message just appended, even if it alone exceeds the cap', () => {
      const ctx = mkContext();
      const state = new ConversationState(ctx);
      state.appendMessage(userMessage(`huge:${'y'.repeat(10_000)}`));

      // Truncating to satisfy the cap must not discard the current turn —
      // an empty history would break the request that is being built.
      expect(ctx.messages).toHaveLength(1);
      expect(JSON.stringify(ctx.messages)).toContain('huge');
    });

    it('bounds an oversized replacement while retaining its newest message', () => {
      const ctx = mkContext();
      const state = new ConversationState(ctx);

      state.replaceMessages(Array.from({ length: 6 }, (_, i) => fatMessage(`replace-${i}`)));

      const total = ctx.messages.reduce((sum, m) => sum + (m._estTokens ?? 0), 0);
      expect(total).toBeLessThanOrEqual(100);
      expect(JSON.stringify(ctx.messages)).toContain('replace-5');
      expect(JSON.stringify(ctx.messages)).not.toContain('replace-0');
      expect(ctx.toolAdjacencyDirty).toBe(true);
    });

    it('leaves an ordinary history untouched', () => {
      (Context as { MAX_MESSAGE_TOKENS: number }).MAX_MESSAGE_TOKENS = ORIG_TOKENS;
      const ctx = mkContext();
      const state = new ConversationState(ctx);
      for (let i = 0; i < 50; i++) state.appendMessage(userMessage(`ordinary-${i}`));

      expect(ctx.messages).toHaveLength(50);
      expect(ctx.toolAdjacencyDirty).toBe(false);
    });
  });
});
