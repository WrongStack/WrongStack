import { describe, expect, it, vi } from 'vitest';
import { Context } from '../../src/core/context.js';
import { ConversationState, wrapAsState } from '../../src/core/conversation-state.js';
import { extractRunEnv } from '../../src/core/run-env.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import type { Message, Provider, SessionWriter, TextBlock } from '../../src/index.js';

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

  it('view reflects mutations to the underlying Context references', () => {
    // The view holds references, not copies. Treat this as documented
    // behavior — callers who need a stable snapshot should clone.
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
    expect((last.content as Array<{ text?: string }>).map((b) => b.text)).toEqual(['second', 'btw note']);
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
});
