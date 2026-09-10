import { describe, expect, it } from 'vitest';
import { sessionApiError } from '../../src/components/SessionsDashboard';

describe('sessionApiError', () => {
  it('redacts credential-shaped API errors before rendering', async () => {
    const secret = ['s' + 'k', 'proj', '1234567890123456789012345678901234567890'].join('-');
    const response = {
      clone: () => ({ json: async () => ({ error: `provider rejected ${secret}` }) }),
      status: 502,
      statusText: 'Bad Gateway',
    } as unknown as Response;

    const message = await sessionApiError(response);

    expect(message).toContain('provider rejected');
    expect(message).not.toContain(secret);
  });
});
