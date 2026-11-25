import { describe, expect, it } from 'vitest';
import { parseCodexCliAuth } from '../src/codex-cli-quota.js';

describe('parseCodexCliAuth account_id trimming', () => {
  it('returns trimmed accountId when auth.json has surrounding whitespace', () => {
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url');
    const jwt = `eyJhbGciOiJub25lIn0.${payload}.sig`;
    const res = parseCodexCliAuth({
      auth_mode: 'chatgpt',
      tokens: { access_token: jwt, account_id: '  acc_1  ' },
    });
    expect(res?.accountId).toBe('acc_1');
  });
});
