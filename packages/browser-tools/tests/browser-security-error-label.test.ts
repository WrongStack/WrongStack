import { describe, expect, it } from 'vitest';
import { assertBrowserUrlAllowed } from '../src/security.js';

/**
 * browser_open / browser_navigate refused a private target with the shared
 * guard's "fetch: blocked private/loopback address" wording, as if the
 * browser tool had called fetch (audit 2026-09-15).
 */
describe('browser private-host refusal wording', () => {
  it('labels a private-host refusal as a browser error', async () => {
    await expect(
      assertBrowserUrlAllowed('http://127.0.0.1:9/', { navigation: true }),
    ).rejects.toThrow(/^browser: blocked private/);
    await expect(
      assertBrowserUrlAllowed('http://127.0.0.1:9/', { navigation: true }),
    ).rejects.toThrow('/browser allow http://127.0.0.1:9');
  });

  it('still allows an allowlisted private origin', async () => {
    await expect(
      assertBrowserUrlAllowed('http://127.0.0.1:9/page', {
        navigation: true,
        allowedPrivateOrigins: ['http://127.0.0.1:9'],
      }),
    ).resolves.toBeInstanceOf(URL);
  });
});
