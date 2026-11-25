import { describe, expect, it } from 'vitest';
import { IntakeValidationError } from '../src/errors.js';
import {
  validateAttachmentInput,
  validateCreateInput,
  validateRelatedResourceInput,
} from '../src/validation.js';

describe('requirement-intake NUL byte validation (F1830)', () => {
  it('accepts clean paths, references, and identifiers', () => {
    expect(
      validateAttachmentInput({ name: 'spec.md', kind: 'file', path: 'docs/spec.md' }).path,
    ).toBe('docs/spec.md');
    expect(
      validateRelatedResourceInput({ kind: 'doc', reference: 'docs/design.md' }).reference,
    ).toBe('docs/design.md');
    expect(
      validateCreateInput({
        projectId: 'proj-1',
        originalRequest: 'Add search bar',
        requestedBy: 'user-1',
      }).projectId,
    ).toBe('proj-1');
  });

  it('rejects NUL bytes in attachment paths, related resource references, and IDs', () => {
    expect(() =>
      validateAttachmentInput({ name: 'spec.md', kind: 'file', path: 'docs/spec.md\0.png' }),
    ).toThrow(IntakeValidationError);
    expect(() =>
      validateRelatedResourceInput({ kind: 'doc', reference: 'docs/design.md\0.bak' }),
    ).toThrow(IntakeValidationError);
    expect(() =>
      validateCreateInput({
        projectId: 'proj-1\0evil',
        originalRequest: 'Add search bar',
        requestedBy: 'user-1',
      }),
    ).toThrow(IntakeValidationError);
    expect(() =>
      validateCreateInput({
        projectId: 'proj-1',
        originalRequest: 'Add search bar',
        requestedBy: 'user-1\0evil',
      }),
    ).toThrow(IntakeValidationError);
  });
});
