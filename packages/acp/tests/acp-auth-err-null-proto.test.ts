import { describe, expect, it } from 'vitest';
import { isAuthRequiredError } from '../src/client/acp-session-errors.js';

describe('isAuthRequiredError null-prototype guard (F2257)', () => {
  it('returns false without throwing TypeError on null-prototype thrown objects', () => {
    expect(isAuthRequiredError(Object.create(null))).toBe(false);
    expect(isAuthRequiredError(new Error('authentication required'))).toBe(true);
  });
});
