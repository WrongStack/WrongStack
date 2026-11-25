import { describe, expect, it } from 'vitest';
import { shouldCloseBrowserSocket } from '../src/auth-revocation.js';

describe('shouldCloseBrowserSocket blank boundSessionId guard (F2297)', () => {
  it('fails closed for whitespace-only boundSessionId', () => {
    expect(shouldCloseBrowserSocket('   ', new Set())).toBe(true);
    expect(shouldCloseBrowserSocket('s1', new Set())).toBe(false);
  });
});
