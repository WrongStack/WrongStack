import { describe, expect, it } from 'vitest';
import {
  optionalBoolean,
  optionalNonNegInt,
  optionalString,
  requireString,
} from '../src/mailbox-codec-validators.js';

describe('mailbox-codec-validators prototype-safe field access', () => {
  it('ignores inherited Object.prototype keys', () => {
    expect(optionalString({}, 'toString', 'op')).toBeUndefined();
    expect(optionalBoolean({}, 'toString', 'op')).toBeUndefined();
    expect(optionalNonNegInt({}, 'toString', 'op')).toBeUndefined();
    expect(() => requireString({}, 'toString', 'op')).toThrow(/missing required field/);
  });
});
