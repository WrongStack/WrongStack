import { describe, expect, it } from 'vitest';
import { validateProtocolString } from '../src/client-protocol-helpers.js';

describe('validateProtocolString whitespace guard', () => {
  it('rejects whitespace-only strings when allowEmpty is false', () => {
    expect(() => validateProtocolString('   ', 'cursor')).toThrow(/non-empty string/);
    expect(() => validateProtocolString('abc', 'cursor')).not.toThrow();
    expect(() => validateProtocolString('   ', 'arg', true)).not.toThrow();
  });
});
