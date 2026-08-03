import { describe, expect, it, vi } from 'vitest';
import type { RequirementIntakeRecord } from '@wrongstack/requirement-intake';
import { intakeToInterviewKickoff, startInterviewFromIntake } from '../src/intake-kickoff.js';
import type { SddInterviewDriver } from '../src/sdd-interview-driver.js';

function fixtureRecord(overrides: Partial<RequirementIntakeRecord> = {}): RequirementIntakeRecord {
  const now = Date.now();
  return {
    id: 'reqi_test',
    projectId: 'proj_alpha',
    title: 'Add email-based password reset',
    originalRequest: 'Please add email-based password reset so users can recover access.',
    normalizedSummary: 'Allow users to reset forgotten passwords through an email link.',
    requestType: 'feature',
    status: 'submitted',
    priority: 'high',
    requestedBy: 'user-alice',
    businessGoal: 'Reduce password reset support tickets',
    expectedOutcome: 'Users can self-service password resets.',
    targetUsers: ['All registered users'],
    constraints: ['Must not require SMS'],
    providedContext: ['Auth service in packages/auth'],
    attachments: [],
    relatedResources: [],
    answers: [],
    questions: [],
    llmSuggestions: [],
    metadata: {},
    fieldSources: {},
    version: 3,
    history: [],
    createdAt: now,
    updatedAt: now,
    submittedAt: now,
    submittedBy: 'user-alice',
    submittedByType: 'user',
    ...overrides,
  };
}

describe('intakeToInterviewKickoff', () => {
  it('uses the exact original request as the interview intent', () => {
    const kickoff = intakeToInterviewKickoff(fixtureRecord());
    expect(kickoff.intent).toBe(
      'Please add email-based password reset so users can recover access.',
    );
  });

  it('derives a short title from the record title', () => {
    const kickoff = intakeToInterviewKickoff(fixtureRecord());
    expect(kickoff.title).toBe('Add email-based password reset');
    expect(kickoff.title.length).toBeLessThanOrEqual(64);
  });

  it('truncates very long titles', () => {
    const kickoff = intakeToInterviewKickoff(fixtureRecord({ title: 'x'.repeat(200) }));
    expect(kickoff.title.length).toBeLessThanOrEqual(64);
    expect(kickoff.title.endsWith('…')).toBe(true);
  });

  it('folds collected facts into the project context', () => {
    const kickoff = intakeToInterviewKickoff(fixtureRecord());
    expect(kickoff.projectContext).toContain(
      'Business goal: Reduce password reset support tickets',
    );
    expect(kickoff.projectContext).toContain(
      'Expected outcome: Users can self-service password resets.',
    );
    expect(kickoff.projectContext).toContain('Target user: All registered users');
    expect(kickoff.projectContext).toContain('Constraint: Must not require SMS');
    expect(kickoff.projectContext).toContain('Context: Auth service in packages/auth');
  });

  it('returns an empty context when no facts were collected', () => {
    const kickoff = intakeToInterviewKickoff(
      fixtureRecord({
        businessGoal: undefined,
        expectedOutcome: undefined,
        scopeNotes: undefined,
        targetUsers: [],
        constraints: [],
        providedContext: [],
      }),
    );
    expect(kickoff.projectContext).toBe('');
  });
});

describe('startInterviewFromIntake', () => {
  it('kicks off the driver with the intake title and verbatim intent', () => {
    const start = vi.fn(() => 'first question prompt');
    const driver = { start } as unknown as Pick<SddInterviewDriver, 'start'>;
    const prompt = startInterviewFromIntake(driver, fixtureRecord());
    expect(start).toHaveBeenCalledWith(
      'Add email-based password reset',
      'Please add email-based password reset so users can recover access.',
    );
    expect(prompt).toBe('first question prompt');
  });
});
