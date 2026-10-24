import type { CouncilLLMCaller } from '@wrongstack/contracts/types/council';
import type { OneShotLLMResult } from '@wrongstack/contracts/types/one-shot-llm';
import { describe, expect, it } from 'vitest';
import { COUNCIL_TOOL_NAME, createCouncilTool } from '../../src/management/council-tool.js';

function response(body: object): OneShotLLMResult {
  return {
    text: JSON.stringify(body),
    provider: 'provider',
    model: 'model',
    tokens: { input: 1, output: 1, total: 2 },
    durationMs: 1,
    fromFallback: false,
  };
}

function caller(): CouncilLLMCaller {
  return {
    async call() {
      return response({ stance: 'Proceed carefully.', rationale: 'Reversible.' });
    },
  };
}

describe('createCouncilTool', () => {
  it('exposes a safe council tool with no invented input limits', () => {
    const tool = createCouncilTool({ caller: caller(), defaultProfile: 'fast' });
    expect(tool.name).toBe(COUNCIL_TOOL_NAME);
    expect(tool.permission).toBe('auto');
    expect(tool.mutating).toBe(false);
    expect(tool.riskTier).toBe('safe');
    expect(tool.managesOwnTimeout).toBe(true);
    expect(tool.inputSchema.required).toEqual(['question']);
    expect(tool.inputSchema.properties?.['options']?.maxItems).toBeUndefined();
    expect(tool.inputSchema.properties?.['question']?.maxLength).toBeUndefined();
    expect(tool.inputSchema.properties?.['context']?.maxLength).toBeUndefined();
  });

  it('executes an open question and composes the executor signal', async () => {
    let received: AbortSignal | undefined;
    let receivedPrompt = '';
    const tool = createCouncilTool({
      defaultProfile: 'fast',
      caller: {
        async call(input) {
          received = input.signal;
          receivedPrompt = input.userPrompt ?? '';
          return response({ stance: 'Proceed carefully.', rationale: 'Reversible.' });
        },
      },
    });
    const controller = new AbortController();
    const result = await tool.execute(
      {
        question: 'What should we do?',
        context: 'The rollout must be reversible.',
        profile: 'fast',
      },
      {} as never,
      { signal: controller.signal },
    );

    expect(result).toMatchObject({
      status: 'decided',
      answer: 'Proceed carefully.',
      resolution: 'first_stance',
    });
    expect(received).toBeInstanceOf(AbortSignal);
    expect(receivedPrompt).toContain('The rollout must be reversible.');
  });

  it('uses the built-in default profile and forwards context plus consequences', async () => {
    const prompts: string[] = [];
    const tool = createCouncilTool({
      caller: {
        async call(input) {
          prompts.push(input.userPrompt ?? '');
          return response({ optionId: 'go', rationale: 'Best trade-off.' });
        },
      },
    });

    const result = await tool.execute(
      {
        question: 'Ship now?',
        context: 'The release is reversible.',
        options: [
          { id: 'go', label: 'Ship', consequence: 'Users receive the fix today.' },
          { id: 'wait', label: 'Wait', consequence: 'The fix is delayed.' },
        ],
      },
      {} as never,
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({
      status: 'decided',
      optionId: 'go',
      answer: 'Ship',
      resolution: 'majority',
      configuredSeatCount: 3,
    });
    // Three seats x two deliberation rounds.
    expect(prompts).toHaveLength(6);
    expect(prompts.every((prompt) => prompt.includes('The release is reversible.'))).toBe(true);
    expect(prompts.every((prompt) => prompt.includes('Users receive the fix today.'))).toBe(true);
    // Round 1 is independent — no seat may see another's ballot.
    expect(prompts.slice(0, 3).some((prompt) => prompt.includes('council-deliberation'))).toBe(
      false,
    );
    // Round 2 shows the previous ballots as delimited untrusted data.
    expect(prompts.slice(3).every((prompt) => prompt.includes('<council-deliberation>'))).toBe(
      true,
    );
    expect(prompts[3]).toContain('Round 2 of 2');
  });

  it('throws when every seat call fails instead of returning a verdict-shaped result', async () => {
    const tool = createCouncilTool({
      defaultProfile: 'fast',
      caller: {
        async call() {
          throw new Error('provider unreachable');
        },
      },
    });

    await expect(
      tool.execute({ question: 'What should we do?' }, {} as never, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Council failed[\s\S]*provider unreachable/);
  });

  it('rejects empty and duplicate inputs, but not large ones', () => {
    const tool = createCouncilTool({ caller: caller() });
    expect(tool.validate?.({ question: '   ' })).toContain('`question` must not be empty.');
    expect(
      tool.validate?.({
        question: 'Choose',
        options: [
          { id: 'same', label: 'One' },
          { id: 'same', label: 'Two' },
        ],
      }),
    ).toContain('Duplicate option id "same".');
    expect(tool.validate?.({ question: 'x'.repeat(20_001) }) ?? []).toEqual([]);
    expect(tool.validate?.({ question: 'Choose', context: 'x'.repeat(80_001) }) ?? []).toEqual([]);
  });
});
