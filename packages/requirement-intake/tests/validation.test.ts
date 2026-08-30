import { describe, expect, it } from 'vitest';
import {
  MAX_ANSWER_LENGTH,
  MAX_METADATA_BYTES,
  MAX_METADATA_ENTRIES,
  MAX_REQUEST_LENGTH,
  MAX_TITLE_LENGTH,
  REQUEST_TYPES,
} from '../src/constants.js';
import { IntakeValidationError } from '../src/errors.js';
import {
  createIntakeSchema,
  deterministicSummary,
  deterministicTitle,
  normalizeRequestType,
  validateAnswerInput,
  validateAttachResourceInput,
  validateCreateInput,
  validateUpdateInput,
} from '../src/validation.js';

const VALID_CREATE = {
  projectId: 'proj_alpha',
  originalRequest: 'Add email-based password reset',
  requestedBy: 'user-alice',
};

describe('create intake validation', () => {
  it('accepts a valid create payload', () => {
    const parsed = validateCreateInput(VALID_CREATE);
    expect(parsed.originalRequest).toBe('Add email-based password reset');
  });

  it('rejects an empty request', () => {
    expect(() => validateCreateInput({ ...VALID_CREATE, originalRequest: '' })).toThrow(
      IntakeValidationError,
    );
  });

  it('rejects a whitespace-only request', () => {
    expect(() => validateCreateInput({ ...VALID_CREATE, originalRequest: '   \n\t ' })).toThrow(
      IntakeValidationError,
    );
  });

  it('rejects a request exceeding the maximum length', () => {
    const tooLong = 'x'.repeat(MAX_REQUEST_LENGTH + 1);
    expect(() => validateCreateInput({ ...VALID_CREATE, originalRequest: tooLong })).toThrow(
      IntakeValidationError,
    );
  });

  it('accepts a request exactly at the maximum length', () => {
    const atLimit = 'x'.repeat(MAX_REQUEST_LENGTH);
    expect(
      validateCreateInput({ ...VALID_CREATE, originalRequest: atLimit }).originalRequest,
    ).toHaveLength(MAX_REQUEST_LENGTH);
  });

  it('rejects an oversized title', () => {
    expect(() =>
      validateCreateInput({ ...VALID_CREATE, title: 't'.repeat(MAX_TITLE_LENGTH + 1) }),
    ).toThrow(IntakeValidationError);
  });

  it('rejects a blank requester', () => {
    expect(() => validateCreateInput({ ...VALID_CREATE, requestedBy: '  ' })).toThrow(
      IntakeValidationError,
    );
  });

  it('rejects unknown keys (strict schema protects the original request)', () => {
    expect(() =>
      validateCreateInput({ ...VALID_CREATE, original_request: 'snake_case must be rejected' }),
    ).toThrow(IntakeValidationError);
  });

  it('collects field-level issues', () => {
    try {
      validateCreateInput({ projectId: '', originalRequest: '', requestedBy: '' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(IntakeValidationError);
      const issues = (error as IntakeValidationError).issues.map((issue) => issue.field);
      expect(issues).toContain('createIntake.projectId');
      expect(issues).toContain('createIntake.originalRequest');
      expect(issues).toContain('createIntake.requestedBy');
    }
  });
});

describe('request type normalization', () => {
  it('keeps every supported value', () => {
    for (const type of REQUEST_TYPES) {
      expect(normalizeRequestType(type)).toBe(type);
    }
  });

  it('is case/whitespace-insensitive', () => {
    expect(normalizeRequestType('  Bug_Fix ')).toBe('bug_fix');
  });

  it('maps unknown values to other', () => {
    expect(normalizeRequestType('banana')).toBe('other');
  });

  it('maps missing/non-string values to unspecified', () => {
    expect(normalizeRequestType(undefined)).toBe('unspecified');
    expect(normalizeRequestType(42)).toBe('unspecified');
    expect(normalizeRequestType(null)).toBe('unspecified');
    expect(normalizeRequestType('')).toBe('unspecified');
  });

  it('never persists an uncontrolled string', () => {
    expect(normalizeRequestType('FEATURE!')).toBe('other');
  });
});

describe('metadata validation', () => {
  it('rejects metadata with too many entries', () => {
    const metadata: Record<string, unknown> = {};
    for (let index = 0; index < MAX_METADATA_ENTRIES + 1; index += 1) metadata[`k${index}`] = index;
    expect(() => validateCreateInput({ ...VALID_CREATE, metadata })).toThrow(IntakeValidationError);
  });

  it('rejects metadata over the byte limit', () => {
    const metadata = { blob: 'x'.repeat(MAX_METADATA_BYTES + 1) };
    expect(() => validateCreateInput({ ...VALID_CREATE, metadata })).toThrow(IntakeValidationError);
  });

  it('rejects non-serializable metadata', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => validateCreateInput({ ...VALID_CREATE, metadata: circular })).toThrow(
      IntakeValidationError,
    );
  });
});

describe('attachment & related-resource validation', () => {
  it('rejects an attachment without exactly one of path/url', () => {
    expect(() => validateAttachResourceInput({ attachment: { name: 'x', kind: 'file' } })).toThrow(
      IntakeValidationError,
    );
  });

  it('accepts a file attachment with a path', () => {
    const parsed = validateAttachResourceInput({
      attachment: { name: 'screenshot.png', kind: 'image', path: '/tmp/screenshot.png' },
    });
    expect(parsed.attachment?.kind).toBe('image');
  });

  it('rejects a link attachment with a non-http url', () => {
    expect(() =>
      validateAttachResourceInput({
        attachment: { name: 'x', kind: 'link', url: 'ftp://example.com' },
      }),
    ).toThrow(IntakeValidationError);
  });

  it('rejects attach payloads with both or neither resource', () => {
    expect(() => validateAttachResourceInput({})).toThrow(IntakeValidationError);
    expect(() =>
      validateAttachResourceInput({
        attachment: { name: 'x', kind: 'file', path: '/tmp/x' },
        relatedResource: { kind: 'issue', reference: 'GH-1' },
      }),
    ).toThrow(IntakeValidationError);
  });

  it('rejects a related resource with a blank reference', () => {
    expect(() =>
      validateAttachResourceInput({ relatedResource: { kind: 'url', reference: '  ' } }),
    ).toThrow(IntakeValidationError);
  });

  it('accepts a URL related resource with a valid http url', () => {
    const parsed = validateAttachResourceInput({
      relatedResource: { kind: 'url', reference: 'https://example.com' },
    });
    expect(parsed.relatedResource?.reference).toBe('https://example.com');
  });
});

describe('answer validation', () => {
  it('rejects a blank answer', () => {
    expect(() => validateAnswerInput({ field: 'business_goal', answer: '   ' })).toThrow(
      IntakeValidationError,
    );
  });

  it('rejects an answer over the maximum length', () => {
    expect(() =>
      validateAnswerInput({ field: 'business_goal', answer: 'a'.repeat(MAX_ANSWER_LENGTH + 1) }),
    ).toThrow(IntakeValidationError);
  });
});

describe('update validation', () => {
  it('accepts an empty patch', () => {
    expect(validateUpdateInput({})).toEqual({});
  });

  it('rejects unknown keys including originalRequest', () => {
    expect(() => validateUpdateInput({ originalRequest: 'attempted overwrite' } as never)).toThrow(
      IntakeValidationError,
    );
    expect(() => validateUpdateInput({ status: 'submitted' } as never)).toThrow(
      IntakeValidationError,
    );
  });

  it('accepts valid patches', () => {
    expect(validateUpdateInput({ title: 'New title' }).title).toBe('New title');
    expect(validateUpdateInput({ priority: 'high' }).priority).toBe('high');
    expect(validateUpdateInput({ constraints: ['a', 'b'] }).constraints).toEqual(['a', 'b']);
  });
});

describe('deterministic normalization', () => {
  it('derives a title from the first line', () => {
    expect(deterministicTitle('Add email-based password reset\nMore detail here')).toBe(
      'Add email-based password reset',
    );
  });

  it('falls back to a default title for blank input', () => {
    expect(deterministicTitle('   ')).toBe('Untitled request');
  });

  it('truncates long titles with an ellipsis', () => {
    const title = deterministicTitle('x'.repeat(MAX_TITLE_LENGTH + 10));
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(title.endsWith('…')).toBe(true);
  });

  it('collapses whitespace in the deterministic summary', () => {
    expect(deterministicSummary('a\n\n  b\tc', 240)).toBe('a b c');
  });

  it('truncates long summaries with an ellipsis', () => {
    const summary = deterministicSummary('word '.repeat(200), 100);
    expect(summary.length).toBeLessThanOrEqual(100);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('schema exports', () => {
  it('exposes a usable zod create schema', () => {
    const result = createIntakeSchema.safeParse(VALID_CREATE);
    expect(result.success).toBe(true);
  });
});

describe('normalizeRequestType', () => {
  it('normalizes valid and hyphenated request types', () => {
    expect(normalizeRequestType('feature')).toBe('feature');
    expect(normalizeRequestType('bug-fix')).toBe('bug_fix');
    expect(normalizeRequestType('UI-CHANGE')).toBe('ui_change');
    expect(normalizeRequestType('api-change')).toBe('api_change');
    expect(normalizeRequestType('unknown-custom')).toBe('other');
    expect(normalizeRequestType('')).toBe('unspecified');
    expect(normalizeRequestType(null)).toBe('unspecified');
  });
});
