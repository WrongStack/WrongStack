import { describe, expect, it } from 'vitest';
import { validateFleetEventEmission } from '../../src/coordination/fleet-event-validation.js';

describe('validateFleetEventEmission', () => {
  it('returns undefined for unknown event types', () => {
    expect(validateFleetEventEmission('unknown.event', {})).toBeUndefined();
  });

  it('rejects bug.found from wrong role', () => {
    const err = validateFleetEventEmission('bug.found', {}, 'refactor-planner');
    expect(err).toContain('may only be emitted by role bug-hunter');
  });

  it('rejects non-object payload for known events', () => {
    const err = validateFleetEventEmission('bug.found', 'not-an-object', 'bug-hunter');
    expect(err).toContain('payload must be an object');
  });

  it('rejects bug.found with missing finding', () => {
    const err = validateFleetEventEmission('bug.found', {}, 'bug-hunter');
    expect(err).toContain('finding');
  });

  it('rejects bug.found finding without id', () => {
    const err = validateFleetEventEmission(
      'bug.found',
      {
        finding: {
          type: 'security',
          severity: 'high',
          location: { file: 'x.ts', line: 5 },
          description: 'desc',
        },
      },
      'bug-hunter',
    );
    expect(err).toContain('finding.id');
  });

  it('rejects bug.found finding without type', () => {
    const err = validateFleetEventEmission(
      'bug.found',
      {
        finding: {
          id: 'b1',
          severity: 'high',
          location: { file: 'x.ts', line: 5 },
          description: 'desc',
        },
      },
      'bug-hunter',
    );
    expect(err).toContain('finding.type');
  });

  it('rejects bug.found finding with invalid severity', () => {
    const err = validateFleetEventEmission(
      'bug.found',
      {
        finding: {
          id: 'b1',
          type: 'security',
          severity: 'unknown',
          location: { file: 'x.ts', line: 5 },
          description: 'desc',
        },
      },
      'bug-hunter',
    );
    expect(err).toContain('severity');
  });

  it('rejects bug.found finding without location', () => {
    const err = validateFleetEventEmission(
      'bug.found',
      {
        finding: { id: 'b1', type: 'security', severity: 'high', description: 'desc' },
      },
      'bug-hunter',
    );
    expect(err).toContain('location');
  });

  it('rejects bug.found finding without description', () => {
    const err = validateFleetEventEmission(
      'bug.found',
      {
        finding: {
          id: 'b1',
          type: 'security',
          severity: 'high',
          location: { file: 'x.ts', line: 5 },
        },
      },
      'bug-hunter',
    );
    expect(err).toContain('description');
  });

  it('rejects bug.found with non-string suggestedFix', () => {
    const err = validateFleetEventEmission(
      'bug.found',
      {
        finding: {
          id: 'b1',
          type: 'security',
          severity: 'high',
          location: { file: 'x.ts', line: 5 },
          description: 'desc',
          suggestedFix: 123,
        },
      },
      'bug-hunter',
    );
    expect(err).toContain('suggestedFix');
  });

  it('accepts valid bug.found', () => {
    const err = validateFleetEventEmission(
      'bug.found',
      {
        finding: {
          id: 'b1',
          type: 'security',
          severity: 'high',
          location: { file: 'x.ts', line: 5 },
          description: 'desc',
          suggestedFix: 'fix it',
        },
      },
      'bug-hunter',
    );
    expect(err).toBeUndefined();
  });

  it('rejects refactor.plan from wrong role', () => {
    const err = validateFleetEventEmission('refactor.plan', {}, 'bug-hunter');
    expect(err).toContain('may only be emitted by role refactor-planner');
  });

  it('rejects refactor.plan without plan object', () => {
    const err = validateFleetEventEmission('refactor.plan', {}, 'refactor-planner');
    expect(err).toContain('payload.plan');
  });

  it('validates refactor.plan plan.id', () => {
    const err = validateFleetEventEmission(
      'refactor.plan',
      {
        plan: {
          basedOnBugIds: [],
          phases: [],
          riskScore: 'low',
          estimatedChangeCount: 0,
          rollbackStrategy: 'rb',
        },
      },
      'refactor-planner',
    );
    expect(err).toContain('plan.id');
  });

  it('validates refactor.plan basedOnBugIds', () => {
    const err = validateFleetEventEmission(
      'refactor.plan',
      {
        plan: {
          id: 'r1',
          basedOnBugIds: 'not-array',
          phases: [],
          riskScore: 'low',
          estimatedChangeCount: 0,
          rollbackStrategy: 'rb',
        },
      },
      'refactor-planner',
    );
    expect(err).toContain('basedOnBugIds');
  });

  it('validates refactor.plan phases', () => {
    const err = validateFleetEventEmission(
      'refactor.plan',
      {
        plan: {
          id: 'r1',
          basedOnBugIds: [],
          phases: [{ number: 'not-number', title: '', tasks: [], risk: 'low' }],
          riskScore: 'low',
          estimatedChangeCount: 0,
          rollbackStrategy: 'rb',
        },
      },
      'refactor-planner',
    );
    expect(err).toContain('phases');
  });

  it('validates refactor.plan riskScore', () => {
    const err = validateFleetEventEmission(
      'refactor.plan',
      {
        plan: {
          id: 'r1',
          basedOnBugIds: [],
          phases: [],
          riskScore: 'extreme',
          estimatedChangeCount: 0,
          rollbackStrategy: 'rb',
        },
      },
      'refactor-planner',
    );
    expect(err).toContain('riskScore');
  });

  it('validates refactor.plan estimatedChangeCount', () => {
    const err = validateFleetEventEmission(
      'refactor.plan',
      {
        plan: {
          id: 'r1',
          basedOnBugIds: [],
          phases: [],
          riskScore: 'low',
          estimatedChangeCount: -1,
          rollbackStrategy: 'rb',
        },
      },
      'refactor-planner',
    );
    expect(err).toContain('estimatedChangeCount');
  });

  it('validates refactor.plan rollbackStrategy', () => {
    const err = validateFleetEventEmission(
      'refactor.plan',
      {
        plan: {
          id: 'r1',
          basedOnBugIds: [],
          phases: [],
          riskScore: 'low',
          estimatedChangeCount: 0,
          rollbackStrategy: '',
        },
      },
      'refactor-planner',
    );
    expect(err).toContain('rollbackStrategy');
  });

  it('accepts valid refactor.plan', () => {
    const err = validateFleetEventEmission(
      'refactor.plan',
      {
        plan: {
          id: 'r1',
          basedOnBugIds: ['b1'],
          phases: [{ number: 1, title: 'Phase 1', tasks: ['t1'], risk: 'low' }],
          riskScore: 'low',
          estimatedChangeCount: 5,
          rollbackStrategy: 'revert',
        },
      },
      'refactor-planner',
    );
    expect(err).toBeUndefined();
  });

  it('rejects critic.evaluation from wrong role', () => {
    const err = validateFleetEventEmission('critic.evaluation', {}, 'bug-hunter');
    expect(err).toContain('may only be emitted by role critic');
  });

  it('rejects critic.evaluation without evaluation object', () => {
    const err = validateFleetEventEmission('critic.evaluation', {}, 'critic');
    expect(err).toContain('payload.evaluation');
  });

  it('validates critic.evaluation evaluation.id', () => {
    const err = validateFleetEventEmission(
      'critic.evaluation',
      {
        evaluation: {
          subjectType: 'bug_finding',
          subjectId: 's1',
          score: 5,
          verdict: 'approve',
          strengths: [],
          weaknesses: [],
          concerns: [],
        },
      },
      'critic',
    );
    expect(err).toContain('evaluation.id');
  });

  it('validates critic.evaluation subjectType', () => {
    const err = validateFleetEventEmission(
      'critic.evaluation',
      {
        evaluation: {
          id: 'e1',
          subjectType: 'unknown',
          subjectId: 's1',
          score: 5,
          verdict: 'approve',
          strengths: [],
          weaknesses: [],
          concerns: [],
        },
      },
      'critic',
    );
    expect(err).toContain('subjectType');
  });

  it('validates critic.evaluation subjectId', () => {
    const err = validateFleetEventEmission(
      'critic.evaluation',
      {
        evaluation: {
          id: 'e1',
          subjectType: 'bug_finding',
          subjectId: '',
          score: 5,
          verdict: 'approve',
          strengths: [],
          weaknesses: [],
          concerns: [],
        },
      },
      'critic',
    );
    expect(err).toContain('subjectId');
  });

  it('validates critic.evaluation score range', () => {
    const err = validateFleetEventEmission(
      'critic.evaluation',
      {
        evaluation: {
          id: 'e1',
          subjectType: 'bug_finding',
          subjectId: 's1',
          score: 11,
          verdict: 'approve',
          strengths: [],
          weaknesses: [],
          concerns: [],
        },
      },
      'critic',
    );
    expect(err).toContain('score');
  });

  it('validates critic.evaluation verdict', () => {
    const err = validateFleetEventEmission(
      'critic.evaluation',
      {
        evaluation: {
          id: 'e1',
          subjectType: 'bug_finding',
          subjectId: 's1',
          score: 5,
          verdict: 'unknown',
          strengths: [],
          weaknesses: [],
          concerns: [],
        },
      },
      'critic',
    );
    expect(err).toContain('verdict');
  });

  it('validates critic.evaluation strengths and weaknesses', () => {
    const err = validateFleetEventEmission(
      'critic.evaluation',
      {
        evaluation: {
          id: 'e1',
          subjectType: 'bug_finding',
          subjectId: 's1',
          score: 5,
          verdict: 'approve',
          strengths: 'not-array',
          weaknesses: [],
          concerns: [],
        },
      },
      'critic',
    );
    expect(err).toContain('strengths');
  });

  it('validates critic.evaluation concerns', () => {
    const err = validateFleetEventEmission(
      'critic.evaluation',
      {
        evaluation: {
          id: 'e1',
          subjectType: 'bug_finding',
          subjectId: 's1',
          score: 5,
          verdict: 'approve',
          strengths: [],
          weaknesses: [],
          concerns: [{ description: '', severity: 'blocking' }],
        },
      },
      'critic',
    );
    expect(err).toContain('concerns');
  });

  it('accepts valid critic.evaluation', () => {
    const err = validateFleetEventEmission(
      'critic.evaluation',
      {
        evaluation: {
          id: 'e1',
          subjectType: 'bug_finding',
          subjectId: 's1',
          score: 5,
          verdict: 'approve',
          strengths: ['good'],
          weaknesses: ['bad'],
          concerns: [{ description: 'concern', severity: 'advisory' }],
        },
      },
      'critic',
    );
    expect(err).toBeUndefined();
  });

  it('accepts critic.evaluation with optional location', () => {
    const err = validateFleetEventEmission(
      'critic.evaluation',
      {
        evaluation: {
          id: 'e1',
          subjectType: 'bug_finding',
          subjectId: 's1',
          score: 5,
          verdict: 'approve',
          strengths: [],
          weaknesses: [],
          concerns: [
            { description: 'concern', severity: 'blocking', location: { file: 'x.ts', line: 10 } },
          ],
        },
      },
      'critic',
    );
    expect(err).toBeUndefined();
  });
});
