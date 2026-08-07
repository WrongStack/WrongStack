import type { Context } from '@wrongstack/core/agent';
import type { Message, Provider } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { validateAction } from '../src/input-validation.js';
import { startFreshTopicContext, TopicShiftAdvisor } from '../src/topic-shift-advisor.js';

function longHistory(topic = 'authentication session middleware token validation'): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < 9; i++) {
    messages.push({ role: 'user', content: `${topic} task ${i}` });
    messages.push({ role: 'assistant', content: `Worked on ${topic} step ${i}.` });
  }
  return messages;
}

function providerReply(payload: Record<string, unknown>): {
  provider: Provider;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn(async () => ({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  return {
    complete,
    provider: { complete } as unknown as Provider,
  };
}

describe('TopicShiftAdvisor', () => {
  it('validates the busy-state payload boundary', () => {
    expect(validateAction({ type: 'topicCheckBusy', on: true }).valid).toBe(true);
    expect(validateAction({ type: 'topicCheckBusy', on: 'yes' }).valid).toBe(false);
  });

  it('does not call a model while history is short', async () => {
    const { provider, complete } = providerReply({
      decision: 'new_context',
      confidence: 0.99,
      reason: 'different',
    });
    const advisor = new TopicShiftAdvisor();

    const advice = await advisor.advise({
      prompt: 'Plan a completely different deployment architecture.',
      messages: longHistory().slice(0, 6),
      provider,
      model: 'test-model',
    });

    expect(advice.suggestNewContext).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps a related follow-up local even with long history', async () => {
    const { provider, complete } = providerReply({
      decision: 'new_context',
      confidence: 0.99,
      reason: 'different',
    });
    const advisor = new TopicShiftAdvisor();

    const advice = await advisor.advise({
      prompt: 'Run the authentication session middleware tests.',
      messages: longHistory(),
      provider,
      model: 'test-model',
    });

    expect(advice.suggestNewContext).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('asks the bounded classifier for a plausible unrelated topic', async () => {
    const { provider, complete } = providerReply({
      decision: 'new_context',
      confidence: 0.91,
      reason: 'Travel planning is unrelated to the authentication implementation.',
      nextTopic: 'Portugal summer holiday',
    });
    const advisor = new TopicShiftAdvisor();

    const advice = await advisor.advise({
      prompt: 'Plan a summer holiday itinerary for Portugal and estimate the budget.',
      messages: longHistory(),
      provider,
      model: 'test-model',
      contextTokens: 50_000,
      maxContext: 200_000,
    });

    expect(advice).toMatchObject({
      suggestNewContext: true,
      confidence: 0.91,
      source: 'model',
      nextTopic: 'Portugal summer holiday',
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0]?.[0] as {
      system: Array<{ cache_control?: unknown }>;
      messages: Array<{ content: Array<{ text: string }> }>;
      maxTokens: number;
    };
    expect(request.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(request.messages[0]?.content[0]?.text.length).toBeLessThan(9_000);
    expect(request.maxTokens).toBe(180);
  });

  it('reuses a cached decision for duplicate edit/retry submits', async () => {
    const { provider, complete } = providerReply({
      decision: 'same_context',
      confidence: 0.88,
      reason: 'Still part of the active work.',
    });
    const advisor = new TopicShiftAdvisor();
    const input = {
      prompt: 'Explain Kubernetes ingress pricing for an unrelated platform proposal.',
      messages: longHistory(),
      provider,
      model: 'test-model',
    };

    const first = await advisor.advise(input);
    const second = await advisor.advise(input);

    expect(first.source).toBe('model');
    expect(second.source).toBe('cache');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('recognizes an explicit topic switch without a provider call', async () => {
    const advisor = new TopicShiftAdvisor();

    const advice = await advisor.advise({
      prompt: 'Yeni konu: şirket için yemek menüsü planlayalım.',
      messages: longHistory(),
    });

    expect(advice).toMatchObject({
      suggestNewContext: true,
      source: 'explicit',
    });
  });
});

describe('startFreshTopicContext', () => {
  it('drops only provider-bound conversation state and preserves session/config ownership', async () => {
    const messages: Message[] = [{ role: 'user', content: 'old topic' }];
    const todos = [{ id: 'old', content: 'old task', status: 'pending' }];
    const flushConversationJournal = vi.fn(async () => {});
    const clearFileTracking = vi.fn();
    const clearMemoryEvidence = vi.fn();
    const ctx = {
      messages,
      todos,
      state: {
        replaceMessages(next: Message[]) {
          messages.splice(0, messages.length, ...next);
        },
        replaceTodos(next: typeof todos) {
          todos.splice(0, todos.length, ...next);
        },
      },
      flushConversationJournal,
      clearFileTracking,
      clearMemoryEvidence,
      memoryEvidence: [{ source: 'sage.tool-memory', text: 'old memory' }],
      contextEvidence: { stale: true },
      toolAdjacencyDirty: true,
      pendingPostToolContext: { content: 'old' },
      lastRequestTokens: 40_000,
      lastRealInputTokens: 38_000,
      meta: {
        contextWindowPolicy: { mode: 'balanced' },
        lastRequestTokensAt: { msgCount: 1 },
        realAnchorMsgCount: 1,
      },
      session: { id: 'preserved-session' },
    } as unknown as Context;

    await startFreshTopicContext(ctx);

    expect(messages).toEqual([
      {
        role: 'system',
        content: expect.stringContaining('[context_boundary:'),
      },
    ]);
    expect(todos).toEqual([]);
    expect(clearFileTracking).toHaveBeenCalledTimes(1);
    expect(clearMemoryEvidence).toHaveBeenCalledTimes(1);
    expect(flushConversationJournal).toHaveBeenCalledTimes(2);
    expect(ctx.lastRequestTokens).toBeUndefined();
    expect(ctx.lastRealInputTokens).toBeUndefined();
    expect(ctx.pendingPostToolContext).toBeUndefined();
    expect(ctx.meta['lastRequestTokensAt']).toBeUndefined();
    expect(ctx.meta['realAnchorMsgCount']).toBeUndefined();
    expect(ctx.meta['contextWindowPolicy']).toEqual({ mode: 'balanced' });
    expect(ctx.session.id).toBe('preserved-session');
  });
});
