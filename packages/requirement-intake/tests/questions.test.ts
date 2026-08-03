import { describe, expect, it } from 'vitest';
import { DEFAULT_INTAKE_QUESTIONS } from '../src/constants.js';
import { buildInitialQuestions, pendingQuestions, upsertQuestion } from '../src/questions.js';
import type { CreateIntakeInput, RequirementIntakeRecord } from '../src/types.js';

function baseInput(overrides: Partial<CreateIntakeInput> = {}): CreateIntakeInput {
  return {
    projectId: 'proj_alpha',
    originalRequest: 'Add email-based password reset',
    requestedBy: 'user-alice',
    ...overrides,
  };
}

function recordWithQuestions(input: CreateIntakeInput): RequirementIntakeRecord {
  return {
    id: 'reqi_test',
    projectId: input.projectId,
    title: 't',
    originalRequest: input.originalRequest,
    normalizedSummary: 's',
    requestType: 'feature',
    status: 'draft',
    priority: 'unspecified',
    requestedBy: input.requestedBy,
    targetUsers: [],
    constraints: [],
    providedContext: [],
    attachments: [],
    relatedResources: [],
    answers: [],
    questions: buildInitialQuestions(input),
    llmSuggestions: [],
    metadata: {},
    fieldSources: {},
    version: 1,
    history: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('buildInitialQuestions', () => {
  it('keeps every catalog question', () => {
    const questions = buildInitialQuestions(baseInput());
    expect(questions).toHaveLength(DEFAULT_INTAKE_QUESTIONS.length);
  });

  it('always skips description_scope (answered by the original request)', () => {
    const questions = buildInitialQuestions(baseInput());
    const scope = questions.find((question) => question.field === 'description_scope');
    expect(scope?.status).toBe('skipped');
  });

  it('skips questions for fields the user already provided', () => {
    const questions = buildInitialQuestions(
      baseInput({ businessGoal: 'Reduce password reset support tickets', priority: 'high' }),
    );
    expect(questions.find((q) => q.field === 'business_goal')?.status).toBe('skipped');
    expect(questions.find((q) => q.field === 'priority')?.status).toBe('skipped');
    expect(questions.find((q) => q.field === 'target_users')?.status).toBe('unanswered');
  });

  it('skips questions for known fields from project data', () => {
    const questions = buildInitialQuestions(
      baseInput({ knownFields: ['project_component', 'constraints'] }),
    );
    expect(questions.find((q) => q.field === 'project_component')?.status).toBe('skipped');
    expect(questions.find((q) => q.field === 'constraints')?.status).toBe('skipped');
  });

  it('preserves catalog order', () => {
    const questions = buildInitialQuestions(baseInput());
    const order = questions.map((question) => question.order);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(questions[0]?.field).toBe(DEFAULT_INTAKE_QUESTIONS[0]?.field);
  });

  it('generates stable question ids', () => {
    const questions = buildInitialQuestions(baseInput());
    for (const question of questions) {
      expect(question.id).toMatch(/^q_[A-Z0-9]+$/i);
    }
  });
});

describe('pendingQuestions', () => {
  it('only surfaces unanswered questions', () => {
    const record = recordWithQuestions(baseInput());
    const pending = pendingQuestions(record);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((question) => question.status === 'unanswered')).toBe(true);
    expect(pending.some((question) => question.field === 'description_scope')).toBe(false);
  });

  it('does not re-ask answered questions', () => {
    const record = recordWithQuestions(baseInput());
    const answered = record.questions.find((question) => question.field === 'business_goal');
    if (answered) {
      answered.status = 'answered';
      answered.answer = 'Reduce support tickets';
    }
    const pending = pendingQuestions(record);
    expect(pending.some((question) => question.field === 'business_goal')).toBe(false);
  });
});

describe('upsertQuestion', () => {
  it('adds a new question and reports the addition', () => {
    const record = recordWithQuestions(baseInput());
    const added = upsertQuestion(record, {
      field: 'security',
      question: 'Any security concerns?',
      required: false,
    });
    expect(added).toBe(true);
    expect(record.questions.some((question) => question.field === 'security')).toBe(true);
  });

  it('does not duplicate an existing active question', () => {
    const record = recordWithQuestions(baseInput());
    const before = record.questions.length;
    const added = upsertQuestion(record, {
      field: DEFAULT_INTAKE_QUESTIONS[1]!.field,
      question: DEFAULT_INTAKE_QUESTIONS[1]!.question,
      required: false,
    });
    expect(added).toBe(false);
    expect(record.questions).toHaveLength(before);
  });
});
