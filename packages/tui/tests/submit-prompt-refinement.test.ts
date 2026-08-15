import type { Provider, Request } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { refineSubmittedPrompt } from '../src/submit-prompt-refinement.js';

function provider(id: string, complete: Provider['complete']): Provider {
  return { id, complete } as Provider;
}

describe('refineSubmittedPrompt model-specific reasoning', () => {
  it('resolves and forwards a low-effort hint for the dedicated refiner model', async () => {
    const text = 'fix the parser bug now';
    const complete = vi.fn(async (request: Request) => ({
      content: [{ type: 'text' as const, text: `${text}\n---\n${text}` }],
      stopReason: 'end_turn' as const,
      usage: { input: 1, output: 1 },
      model: request.model,
    }));
    const live = provider('openai-codex', complete);
    const dedicated = provider('zai-coding-plan', complete);
    const getEnhancerReasoning = vi.fn(async (providerId?: string, modelId?: string) =>
      providerId === 'zai-coding-plan' && modelId === 'glm-5.2'
        ? { effort: 'low' as const }
        : undefined,
    );
    const buildEnhancerProvider = vi.fn(async () => dedicated);

    const result = await refineSubmittedPrompt(
      {
        capabilities: {
          agent: {
            ctx: { provider: live, model: 'gpt-5.6-sol', messages: [] },
          } as never,
          getConfiguredRefinerRef: () => 'zai-coding-plan/glm-5.2',
          buildEnhancerProvider,
          getEnhancerReasoning,
        },
        status: 'idle',
        enabled: { current: true },
        original: { current: '' },
        abortController: { current: null },
        cancelled: { current: false },
        preRefineSeconds: 0,
        dispatch: vi.fn(),
        clearDraft: vi.fn(),
        setDraft: vi.fn(),
        setStartedAt: vi.fn(),
        setDuration: vi.fn(),
        setProviderId: vi.fn(),
        setModel: vi.fn(),
      },
      text,
      { steering: false, continuationResolved: false },
    );

    expect(result).toEqual({ kind: 'send', effectiveText: text });
    expect(buildEnhancerProvider).toHaveBeenCalledWith('zai-coding-plan', 'glm-5.2');
    expect(getEnhancerReasoning).toHaveBeenCalledWith('zai-coding-plan', 'glm-5.2');
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'glm-5.2',
        reasoning: { effort: 'low' },
      }),
      expect.any(Object),
    );
  });

  it('keeps [VIBE] in the refiner input instead of stripping it as an attachment chip', async () => {
    const text = '[VIBE] increment the cart when the button is clicked';
    const complete = vi.fn(async (request: Request) => {
      const userText = request.messages
        .flatMap((message) =>
          typeof message.content === 'string'
            ? [message.content]
            : Array.isArray(message.content)
              ? message.content
                  .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
                  .map((block) => block.text)
              : [],
        )
        .join('\n');
      expect(userText).toContain('[VIBE]');
      return {
        content: [{ type: 'text' as const, text: `${text}\n---\n${text}` }],
        stopReason: 'end_turn' as const,
        usage: { input: 1, output: 1 },
        model: request.model,
      };
    });
    const live = provider('openai-codex', complete);

    const result = await refineSubmittedPrompt(
      {
        capabilities: {
          agent: {
            ctx: { provider: live, model: 'gpt-5.6-sol', messages: [] },
          } as never,
        },
        status: 'idle',
        enabled: { current: true },
        original: { current: '' },
        abortController: { current: null },
        cancelled: { current: false },
        preRefineSeconds: 0,
        dispatch: vi.fn(),
        clearDraft: vi.fn(),
        setDraft: vi.fn(),
        setStartedAt: vi.fn(),
        setDuration: vi.fn(),
        setProviderId: vi.fn(),
        setModel: vi.fn(),
      },
      text,
      { steering: false, continuationResolved: false },
    );

    expect(result).toEqual({ kind: 'send', effectiveText: text });
    expect(complete).toHaveBeenCalled();
  });
});
