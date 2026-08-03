import { describe, expect, it } from 'vitest';
import { IntakeSuggestionError } from '../src/errors.js';
import { toProposals, validateLlmSuggestionOutput } from '../src/suggestions.js';

const VALID_OUTPUT = {
  suggested_title: 'Add email-based password reset',
  normalized_summary: 'Allow users to reset forgotten passwords through an email link.',
  suggested_request_type: 'feature',
  extracted_constraints: ['Must not require SMS'],
  extracted_target_users: ['All registered users'],
  suggested_outcome: 'Users can self-service password resets.',
  suggested_questions: [
    { field: 'target_users', question: 'Which users should be able to use password reset?' },
  ],
};

describe('validateLlmSuggestionOutput', () => {
  it('accepts a valid structured output', () => {
    const normalized = validateLlmSuggestionOutput(VALID_OUTPUT);
    expect(normalized.suggestedTitle).toBe('Add email-based password reset');
    expect(normalized.suggestedRequestType).toBe('feature');
    expect(normalized.extractedConstraints).toEqual(['Must not require SMS']);
    expect(normalized.suggestedQuestions).toHaveLength(1);
  });

  it('rejects malformed output (non-object)', () => {
    expect(() => validateLlmSuggestionOutput('just a string')).toThrow(IntakeSuggestionError);
    expect(() => validateLlmSuggestionOutput(null)).toThrow(IntakeSuggestionError);
    expect(() => validateLlmSuggestionOutput([])).toThrow(IntakeSuggestionError);
  });

  it('rejects malformed output (wrong value types)', () => {
    expect(() => validateLlmSuggestionOutput({ suggested_title: 123 })).toThrow(
      IntakeSuggestionError,
    );
    expect(() => validateLlmSuggestionOutput({ extracted_constraints: ['ok', 7] })).toThrow(
      IntakeSuggestionError,
    );
    expect(() =>
      validateLlmSuggestionOutput({ suggested_questions: [{ question: 'missing field' }] }),
    ).toThrow(IntakeSuggestionError);
  });

  it('rejects oversized strings', () => {
    expect(() => validateLlmSuggestionOutput({ suggested_title: 't'.repeat(201) })).toThrow(
      IntakeSuggestionError,
    );
  });

  it('normalizes unknown request types to other', () => {
    const normalized = validateLlmSuggestionOutput({ suggested_request_type: 'weird-thing' });
    expect(normalized.suggestedRequestType).toBe('other');
  });

  it('drops unknown priorities instead of persisting them', () => {
    const normalized = validateLlmSuggestionOutput({ suggested_priority: 'urgentest' });
    expect(normalized.suggestedPriority).toBeUndefined();
  });

  it('accepts valid priorities', () => {
    const normalized = validateLlmSuggestionOutput({ suggested_priority: 'critical' });
    expect(normalized.suggestedPriority).toBe('critical');
  });

  it('trims strings during validation', () => {
    const normalized = validateLlmSuggestionOutput({ suggested_title: '  Reset password  ' });
    expect(normalized.suggestedTitle).toBe('Reset password');
  });

  it('handles empty optional fields', () => {
    const normalized = validateLlmSuggestionOutput({});
    expect(normalized.suggestedTitle).toBeUndefined();
    expect(normalized.extractedConstraints).toEqual([]);
    expect(normalized.extractedTargetUsers).toEqual([]);
    expect(normalized.suggestedQuestions).toEqual([]);
  });
});

describe('toProposals', () => {
  it('creates one pending proposal per suggestion', () => {
    const proposals = toProposals(validateLlmSuggestionOutput(VALID_OUTPUT));
    expect(proposals.length).toBe(7);
    expect(proposals.every((proposal) => proposal.status === 'pending')).toBe(true);
    expect(proposals.every((proposal) => proposal.id.startsWith('sug_'))).toBe(true);
  });

  it('maps each kind to the right target field', () => {
    const proposals = toProposals(validateLlmSuggestionOutput(VALID_OUTPUT));
    const byKind = new Map(proposals.map((proposal) => [proposal.kind, proposal]));
    expect(byKind.get('title')?.field).toBe('title');
    expect(byKind.get('summary')?.field).toBe('normalized_summary');
    expect(byKind.get('request_type')?.field).toBe('request_type');
    expect(byKind.get('constraint')?.field).toBe('constraints');
    expect(byKind.get('target_user')?.field).toBe('target_users');
    expect(byKind.get('outcome')?.field).toBe('expected_outcome');
    expect(byKind.get('question')?.field).toBe('target_users');
  });

  it('produces one proposal per constraint and target user', () => {
    const normalized = validateLlmSuggestionOutput({
      extracted_constraints: ['a', 'b'],
      extracted_target_users: ['x', 'y', 'z'],
    });
    const proposals = toProposals(normalized);
    expect(proposals.filter((proposal) => proposal.kind === 'constraint')).toHaveLength(2);
    expect(proposals.filter((proposal) => proposal.kind === 'target_user')).toHaveLength(3);
  });

  it('returns an empty list for an empty suggestion', () => {
    expect(toProposals(validateLlmSuggestionOutput({}))).toEqual([]);
  });
});
