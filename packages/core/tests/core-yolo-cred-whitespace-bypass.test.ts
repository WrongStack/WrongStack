import { describe, expect, it } from 'vitest';
import { attachesWellKnownCredential } from '../src/security/yolo-credentials.js';

describe('attachesWellKnownCredential whitespace trimming (F2287)', () => {
  it('detects whitespace-padded well-known credential env var names', () => {
    expect(attachesWellKnownCredential({ envVars: [' OPENAI_API_KEY '] })).toBe(true);
    expect(attachesWellKnownCredential({ env: { ' ANTHROPIC_API_KEY ': '1' } })).toBe(true);
  });
});
