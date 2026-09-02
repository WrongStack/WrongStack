import { test, expect } from '@playwright/test';

/**
 * Smoke test — verifies the WebUI server starts and the page loads
 * without crashing. This is the baseline sanity check; all component-
 * specific tests go in their own files.
 *
 * Known non-critical errors (ignored):
 *  - CSP errors for port mismatches during initial WS handshake — race condition
 *    in the port-injection meta tag vs the CSP header timing
 *  - "Connecting to 'ws://...3457/' violates CSP" — test env uses auto-assigned
 *    ports so the injected meta tag and the actual WS port may briefly mismatch
 */
const IGNORED_ERRORS = [
  'violates the following Content Security Policy',
  '[object Event]', // internal ws-client error during handshake
];

function isIgnoredError(text: string): boolean {
  return IGNORED_ERRORS.some((pat) => text.includes(pat));
}

test.describe('WebUI smoke', () => {
  test('page loads without crash', async ({ page }) => {
    const res = await page.goto('/');
    expect(res?.status()).toBeLessThan(400);
  });

  test('no critical console errors on load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const critical = errors.filter((e) => !e.includes('favicon') && !isIgnoredError(e));
    expect(critical).toHaveLength(0);
  });
});
