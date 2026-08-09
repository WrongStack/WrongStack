/**
 * Test helper for asserting structured `FetchError` shape from auth/registry
 * code paths. Centralizes the pattern that was duplicated across 7 tests:
 *
 * ```ts
 * // Before:
 * vi.stubGlobal('fetch', vi.fn(async () => new Response('body', { status: 400 })));
 * let caught: unknown;
 * try { await someCall(); } catch (err) { caught = err; }
 * expect(isFetchError(caught)).toBe(true);
 * const fe = caught as FetchError;
 * expect(fe.status).toBe(400);
 * expect(fe.context).toMatchObject({ provider: '...', op: '...' });
 *
 * // After:
 * const fe = await expectFetchError(() => someCall(), {
 *   status: 400,
 *   body: 'body',
 *   context: { provider: '...', op: '...' },
 * });
 * // Optional: assert additional FetchError fields not covered by the helper.
 * expect(fe.message).toMatch(/something/);
 * ```
 *
 * Returns the caught `FetchError` so callers can add per-test assertions
 * (e.g. `fe.cause`, message regex, custom context fields) without having
 * to re-implement the try/catch scaffolding.
 *
 * The `vi.stubGlobal('fetch', ...)` call persists for the rest of the
 * test (the caller is responsible for restoring via `vi.unstubAllGlobals()`
 * in an `afterEach` if subsequent assertions need the real fetch). This
 * matches the existing test pattern.
 */
import { type FetchError, isFetchError } from '@wrongstack/core/types';
import { expect, vi } from 'vitest';

export interface ExpectFetchErrorOptions {
  /**
   * Status code returned by the stubbed `fetch` response. Most production
   * code paths propagate this straight into `FetchError.status`, so
   * `expectedStatus` defaults to the same value.
   */
  status?: number;
  /**
   * Expected `FetchError.status`. Defaults to `status`. Override when the
   * production code remaps the HTTP status before throwing (e.g. a 200 OK
   * response that maps to a 408 timeout FetchError for the
   * device-code-expiry case).
   */
  expectedStatus?: number;
  /**
   * Response body to return from the stubbed `fetch`. Defaults to `''` for
   * cases where the production code doesn't read the body.
   */
  body?: string;
  /**
   * Expected partial `FetchError.context` shape. Asserted via
   * `toMatchObject`, so any context field not in the expected shape is
   * ignored (lets the production code add fields without breaking tests).
   */
  context?: Record<string, unknown>;
}

/**
 * Stub the global `fetch` to return a non-2xx response, invoke `fn`,
 * and assert the thrown error is a `FetchError` with the expected `status`
 * and partial `context`. Returns the `FetchError` for additional
 * per-test assertions.
 */
export async function expectFetchError(
  fn: () => Promise<unknown>,
  opts: ExpectFetchErrorOptions,
): Promise<FetchError> {
  const httpStatus = opts.status ?? opts.expectedStatus ?? 500;
  const expectedStatus = opts.expectedStatus ?? httpStatus;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(opts.body ?? '', { status: httpStatus })),
  );

  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }

  expect(isFetchError(caught)).toBe(true);
  const fe = caught as FetchError;
  expect(fe.status).toBe(expectedStatus);
  if (opts.context) {
    expect(fe.context).toMatchObject(opts.context);
  }
  return fe;
}
