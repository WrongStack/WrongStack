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

  it('supports multi-question batching with ask_question parity', async () => {
    const mockHostAsk = vi
      .fn()
      .mockResolvedValueOnce({
        selected: ['PostgreSQL'],
      })
      .mockResolvedValueOnce({
        selected: ['JWT Bearer tokens', 'API Keys'],
        custom: 'OAuth2 in phase 2',
      });

    const ctx = {
      askUserChoices: mockHostAsk,
    };

    const output = await clarifyTool.execute(
      {
        questions: [
          {
            question: 'Which primary database engine to use?',
            options: ['(Recommended) PostgreSQL', 'MySQL', 'SQLite'],
          },
          {
            question: 'What auth strategies to enable?',
            options: ['JWT Bearer tokens', 'Session cookies', 'API Keys'],
            is_multi_select: true,
          },
        ],
      },
      ctx as never,
      makeOpts(),
    );

    expect(mockHostAsk).toHaveBeenCalledTimes(2);
    expect(output.status).toBe('answered');
    expect(output.answers).toHaveLength(2);
    expect(output.answers?.[0]?.selectedOptions).toEqual(['PostgreSQL']);
    expect(output.answers?.[1]?.selectedOptions).toEqual(['JWT Bearer tokens', 'API Keys']);
    expect(output.answers?.[1]?.customResponse).toBe('OAuth2 in phase 2');
    expect(output.decisionSummary).toContain('Which primary database engine to use?');
    expect(output.decisionSummary).toContain('What auth strategies to enable?');
  });

  it('auto-decides multi-question batches in non-interactive mode', async () => {
    const output = await clarifyTool.execute(
      {
        questions: [
          {
            question: 'ORM selection?',
            options: ['(Recommended) Prisma', 'Drizzle', 'Kysely'],
          },
          {
            question: 'Deployment target?',
            options: ['Fly.io', 'Render', 'AWS ECS'],
            recommendedOption: 'AWS ECS',
          },
        ],
      },
      {} as never,
      makeOpts(),
    );

    expect(output.status).toBe('auto_decided');
    expect(output.answers).toHaveLength(2);
    expect(output.answers?.[0]?.selectedOptions).toEqual(['(Recommended) Prisma']);
    expect(output.answers?.[1]?.selectedOptions).toEqual(['AWS ECS']);
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

  it('submits a tabbed mixed form once and reports recommended-answer usage', async () => {
    const requestUserInput = vi.fn(
      async (request: import('@wrongstack/core/types').UserInputRequest) => ({
        requestId: request.id,
        status: 'submitted' as const,
        answers: [
          { questionId: 'database', selectedOptionIds: ['postgres'], usedRecommendation: false },
          {
            questionId: 'features',
            selectedOptionIds: ['audit', 'sso'],
            text: 'SCIM later',
            usedRecommendation: false,
          },
          {
            questionId: 'tenant_name',
            selectedOptionIds: [],
            text: 'Acme',
            usedRecommendation: false,
          },
        ],
      }),
    );
    const output = await clarifyTool.execute(
      {
        title: 'Architecture decisions',
        tabs: [
          {
            label: 'Data',
            questions: [
              {
                id: 'database',
                question: 'Database?',
                options: [
                  { id: 'postgres', label: 'PostgreSQL', description: 'Strong default' },
                  { id: 'sqlite', label: 'SQLite' },
                ],
                recommendedOption: 'postgres',
                recommendationReason: 'Concurrent production writes.',
              },
            ],
          },
          {
            label: 'Product',
            questions: [
              {
                id: 'features',
                question: 'Features?',
                type: 'multi_select',
                options: [
                  { id: 'audit', label: 'Audit log' },
                  { id: 'sso', label: 'SSO' },
                ],
                recommendedOptions: ['audit'],
              },
              {
                id: 'tenant_name',
                question: 'Tenant name?',
                type: 'text',
                recommendedText: 'Example Inc.',
              },
            ],
          },
        ],
      },
      { signal: makeOpts().signal, requestUserInput } as never,
      makeOpts(),
    );

    expect(requestUserInput).toHaveBeenCalledOnce();
    expect(requestUserInput.mock.calls[0]?.[0].tabs).toHaveLength(2);
    expect(output.status).toBe('answered');
    expect(output.answers?.map((answer) => answer.usedRecommendation)).toEqual([
      true,
      false,
      false,
    ]);
    expect(output.answers?.[2]?.customResponse).toBe('Acme');
  });

  it('returns an explicit model delegation without leaking stale answer values', async () => {
    const requestUserInput = vi.fn(
      async (request: import('@wrongstack/core/types').UserInputRequest) => ({
        requestId: request.id,
        status: 'submitted' as const,
        answers: [
          {
            questionId: request.tabs[0]!.questions[0]!.id,
            selectedOptionIds: ['postgres'],
            text: 'stale manual value',
            delegated: true,
            usedRecommendation: true,
          },
        ],
      }),
    );
    const output = await clarifyTool.execute(
      {
        question: 'Database?',
        options: ['PostgreSQL', 'SQLite'],
        recommendedOption: 'PostgreSQL',
      },
      { signal: makeOpts().signal, requestUserInput } as never,
      makeOpts(),
    );

    expect(output.answers?.[0]).toEqual({
      questionId: 'database',
      question: 'Database?',
      selectedOptions: [],
      delegatedToModel: true,
      usedRecommendation: false,
    });
    expect(output.decisionSummary).toContain('model should decide (user delegated)');
  });

  it('generates readable Turkish ids and rejects contradictory select flags', async () => {
    const requestUserInput = vi.fn(
      async (request: import('@wrongstack/core/types').UserInputRequest) => ({
        requestId: request.id,
        status: 'submitted' as const,
        answers: request.tabs.flatMap((tab) =>
          tab.questions.map((question) => ({
            questionId: question.id,
            selectedOptionIds: question.recommendedOptionIds ?? [],
            usedRecommendation: false,
          })),
        ),
      }),
    );
    const output = await clarifyTool.execute(
      {
        question: 'Ödeme şekli nasıl olmalı?',
        options: ['(Recommended) Kredi kartı', 'Banka havalesi'],
      },
      { signal: makeOpts().signal, requestUserInput } as never,
      makeOpts(),
    );
    expect(requestUserInput.mock.calls[0]?.[0].tabs[0]?.questions[0]?.id).toBe(
      'odeme_sekli_nasil_olmali',
    );
    expect(output.answers?.[0]?.usedRecommendation).toBe(true);

    const conflict = await clarifyTool.execute(
      {
        question: 'Choose?',
        type: 'multi_select',
        isMultiSelect: false,
        options: ['A', 'B'],
      },
      {} as never,
      makeOpts(),
    );
    expect(conflict.status).toBe('skipped');
    expect(conflict.error).toContain('conflicting');
  });

  it('returns explicit validation errors for structurally unusable forms', async () => {
    const descriptionOnly = await clarifyTool.execute(
      {
        question: 'Choose?',
        options: [{ description: 'No visible choice' } as never, 'Valid'],
      },
      {} as never,
      makeOpts(),
    );
    expect(descriptionOnly.error).toContain('requires a non-empty `label`');

    const emptyTab = await clarifyTool.execute(
      { tabs: [{ label: 'Empty', questions: [] }] },
      {} as never,
      makeOpts(),
    );
    expect(emptyTab.error).toContain('requires at least one question');
  });
});
