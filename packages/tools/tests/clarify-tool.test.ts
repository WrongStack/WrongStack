import { describe, expect, it, vi } from 'vitest';
import { clarifyTool } from '../src/index.js';

const makeOpts = () => ({ signal: new AbortController().signal });

describe('clarify tool', () => {
  it('auto-selects recommended option in headless mode', async () => {
    const output = await clarifyTool.execute(
      {
        question: 'How should phone numbers be stored in the User table?',
        context: 'Affects index uniqueness and validation rules.',
        options: [
          '(Recommended) E.164 international format with unique index',
          'Freeform string, non-unique',
          'E.164 with separate country code column',
        ],
        recommendedOption: '(Recommended) E.164 international format with unique index',
      },
      {} as never,
      makeOpts(),
    );

    expect(output.status).toBe('auto_decided');
    expect(output.selectedOptions).toContain(
      '(Recommended) E.164 international format with unique index',
    );
    expect(output.decisionSummary).toContain('Auto-selected');
  });

  it('delegates to host interactive callback when available', async () => {
    const mockHostAsk = vi.fn().mockResolvedValue({
      selected: ['E.164 with separate country code column'],
      custom: 'Must support landlines',
    });

    const ctx = {
      askUserChoices: mockHostAsk,
    };

    const output = await clarifyTool.execute(
      {
        question: 'How should phone numbers be stored?',
        options: ['Option A', 'Option B'],
      },
      ctx as never,
      makeOpts(),
    );

    expect(mockHostAsk).toHaveBeenCalledOnce();
    expect(output.status).toBe('answered');
    expect(output.selectedOptions).toContain('E.164 with separate country code column');
    expect(output.customResponse).toBe('Must support landlines');
  });

  it('handles invalid option count defensively', async () => {
    const output = await clarifyTool.execute(
      {
        question: 'Single option?',
        options: ['Only one'],
      },
      {} as never,
      makeOpts(),
    );

    expect(output.status).toBe('skipped');
    expect(output.error).toContain('at least 2');
  });
});
