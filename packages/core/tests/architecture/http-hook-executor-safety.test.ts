/**
 * Regression for J4 (SSRF-003): the HTTP hook executor pre-checks the
 * URL with `assertNotPrivateHost` (good) and sets `redirect: 'error'`
 * (good), but uses the global `fetch` — which means the dial-time IP
 * can differ from the pre-check IP. Until `guardedFetch`'s pinned
 * dispatcher is wired in, this test pins the two mitigations that
 * ARE in place so a future "let's just call `fetch` directly"
 * refactor breaks the build instead of the user's machine.
 *
 * Specifically, the guard contracts:
 *   1. HTTPS-only for non-loopback (loopback HTTP is allowed for
 *      local dev/hooks only).
 *   2. `assertNotPrivateHost(url.hostname)` for the HTTPS path.
 *   3. `redirect: 'error'` so a 30x to a private host is rejected.
 *   4. The pre-check is in `isAllowedUrl` (lines 25-41) — the
 *      fetch call must reuse the same gate.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '../../../..');
const source = readFileSync(
  resolve(repoRoot, 'packages/core/src/hooks/http-executor.ts'),
  'utf8',
);

describe('J4 / HTTP hook executor — SSRF guard rail is wired', () => {
  it('rejects non-https for non-loopback hosts', () => {
    expect(source).toMatch(/url\.protocol === 'https:'/);
  });

  it('uses assertNotPrivateHost for the HTTPS path', () => {
    // The pre-check must run before fetch — a future refactor that
    // checks at fetch-time (when it is too late for the URL) would
    // pass the source check but lose the contract. The call site
    // must therefore be in `isAllowedUrl` (the gate), not in
    // `runHttpHookDetailed` (the executor).
    expect(source).toMatch(/await assertNotPrivateHost\(url\.hostname\)/);
  });

  it('refuses redirects (no 30x-to-private-host follow)', () => {
    // Without `redirect: 'error'`, a hostile hook that 302s to
    // `http://169.254.169.254/…` would silently drain the input
    // (which can include the user's secrets) to AWS IMDS.
    expect(source).toMatch(/redirect:\s*['"]error['"]/);
  });

  it('the fetch call in runHttpHookDetailed is gated by isAllowedUrl', () => {
    // Structural check: the executor must invoke the URL gate before
    // fetching. We assert that the gate name appears in source *and*
    // that a `fetch(spec.url, ...)` literal exists — a future
    // refactor that drops either is the regression we are catching.
    expect(source).toContain('isAllowedUrl(spec.url)');
    expect(source).toMatch(/await fetch\(spec\.url/);
  });
});
