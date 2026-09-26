// @vitest-environment jsdom
/**
 * Settings panels call `authorizedFetch` directly, so a lost session used to
 * show as an inline error on a panel the operator could no longer use. A 401
 * that means "credential gone" must raise the auth gate; a 401 for a wrong
 * input (current password, TOTP) must stay an inline message.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useHqStore } from '../src/data/store/index.js';
import { errorMessage } from '../src/views/settings/shared.js';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('settings errorMessage', () => {
  beforeEach(() => {
    useHqStore.setState({ authRequired: false });
  });

  it('raises the auth gate when the session is gone', async () => {
    const text = await errorMessage(
      response(401, { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } }),
    );
    expect(text).toBe('Authentication required.');
    expect(useHqStore.getState().authRequired).toBe(true);
  });

  it('keeps a wrong-input 401 inline', async () => {
    const text = await errorMessage(
      response(401, { error: { code: 'INVALID_CURRENT_PASSWORD', message: 'Wrong password.' } }),
    );
    expect(text).toBe('Wrong password.');
    expect(useHqStore.getState().authRequired).toBe(false);
  });
});
