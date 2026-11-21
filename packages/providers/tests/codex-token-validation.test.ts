import { describe, expect, it } from 'vitest';
import { readCodexTokenResponse } from '../src/oauth/codex-protocol.js';

const valid = {
  access_token: 'fixture-access',
  refresh_token: 'fixture-refresh',
  expires_in: 3600,
};
const response = (body: unknown) => new Response(JSON.stringify(body));

describe('Codex token response credential validation', () => {
  it('accepts valid exchange credentials unchanged', async () => {
    const tokens = await readCodexTokenResponse(response(valid), 'exchange');
    expect(tokens.access).toBe(valid.access_token);
    expect(tokens.refresh).toBe(valid.refresh_token);
    expect(Number.isFinite(tokens.expires)).toBe(true);
  });

  it('keeps the stored refresh token when rotation is omitted or null', async () => {
    for (const refresh_token of [undefined, null]) {
      const tokens = await readCodexTokenResponse(
        response({ access_token: 'next-access', refresh_token }),
        'refresh',
        'stored-refresh',
      );
      expect(tokens.access).toBe('next-access');
      expect(tokens.refresh).toBe('stored-refresh');
    }
  });

  it('accepts a valid rotated refresh token', async () => {
    const tokens = await readCodexTokenResponse(response(valid), 'refresh', 'stored-refresh');
    expect(tokens.refresh).toBe(valid.refresh_token);
  });

  for (const field of ['access_token', 'refresh_token']) {
    it.each([{}, [], 42, true, '', '   ', '\t\n'])(
      `rejects malformed ${field}: %j`,
      async (value) => {
        await expect(
          readCodexTokenResponse(response({ ...valid, [field]: value }), 'exchange'),
        ).rejects.toMatchObject({ name: 'ParseError', source: 'openai-codex-token-response' });
      },
    );
  }

  it('rejects a malformed rotated refresh token rather than overwriting stored credentials', async () => {
    await expect(
      readCodexTokenResponse(
        response({ ...valid, refresh_token: { unexpected: true } }),
        'refresh',
        'stored-refresh',
      ),
    ).rejects.toMatchObject({ name: 'ParseError' });
  });

  it('requires a refresh token when neither response nor storage supplies one', async () => {
    await expect(
      readCodexTokenResponse(response({ access_token: 'next-access' }), 'refresh'),
    ).rejects.toMatchObject({ name: 'ParseError' });
  });
});
