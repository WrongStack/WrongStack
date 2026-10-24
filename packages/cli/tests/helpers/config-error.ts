/**
 * Test helper for asserting structured `ConfigError` shape. Centralizes the
 * try/catch + isConfigError + code/context/cause boilerplate that was
 * duplicated across 5 sites in wiring-provider.test.ts.
 *
 * ```ts
 * // Before:
 * let caught: unknown;
 * try { await setupProvider({ ... }); } catch (err) { caught = err; }
 * expect(isConfigError(caught)).toBe(true);
 * const ce = caught as ConfigError;
 * expect(ce.code).toBe('CONFIG_INVALID');
 * expect(ce.context).toMatchObject({ phase: 'registry-build' });
 * expect(ce.cause).toBeInstanceOf(Error);
 *
 * // After:
 * const ce = await expectConfigError(() => setupProvider({ ... }), {
 *   code: 'CONFIG_INVALID',
 *   context: { phase: 'registry-build' },
 * });
 * // Optional: assert cause, message regex, custom context fields.
 * expect(ce.cause).toBeInstanceOf(Error);
 * ```
 *
 * Returns the caught `ConfigError` so callers can add per-test assertions
 * (cause checks, message regex, custom context fields) without re-
 * implementing the try/catch scaffolding.
 */
import { type ConfigError, isConfigError } from '@wrongstack/contracts/types';
import { expect } from 'vitest';

export interface ExpectConfigErrorOptions {
  /**
   * Expected `ConfigError.code`. Asserted with strict equality.
   * Common values: `CONFIG_INVALID`, `CONFIG_PARSE_FAILED`,
   * `CONFIG_NOT_FOUND`, `CONFIG_MIGRATION_NEEDED`.
   */
  code?: string;
  /**
   * Expected partial `ConfigError.context` shape. Asserted via
   * `toMatchObject`, so any context field not in the expected shape is
   * ignored (lets the production code add fields without breaking tests).
   */
  context?: Record<string, unknown>;
}

/**
 * Invoke `fn`, assert the thrown error is a `ConfigError`, and optionally
 * verify `code` and partial `context`. Returns the `ConfigError` for
 * additional per-test assertions (e.g. `ce.cause`, `ce.message`).
 */
export async function expectConfigError(
  fn: () => Promise<unknown>,
  opts: ExpectConfigErrorOptions = {},
): Promise<ConfigError> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }

  expect(isConfigError(caught)).toBe(true);
  const ce = caught as ConfigError;
  if (opts.code) {
    expect(ce.code).toBe(opts.code);
  }
  if (opts.context) {
    expect(ce.context).toMatchObject(opts.context);
  }
  return ce;
}
