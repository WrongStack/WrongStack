import { describe, expect, it } from 'vitest';
import { requestWithRetry } from '../src/registry/http-fetch.js';

const options = { hostname: '127.0.0.1', port: 1, path: '/', timeoutMs: 200 };

async function errorOf(overrides: Record<string, unknown>): Promise<string> {
  try {
    await requestWithRetry({ ...options, ...overrides } as never);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * F2641: `maxAttempts` is read with `Math.max(1, options.maxAttempts ?? 3)`. A
 * NaN value survives and `attempt < NaN` is false, so the retry loop never runs
 * and the request fails with the generic fallback instead of a network error —
 * one malformed option turns every registry fetch into a no-op failure.
 */
describe('http retry attempts typing (F2641)', () => {
  it('still attempts once when maxAttempts is not finite', async () => {
    const message = await errorOf({ maxAttempts: Number.NaN });

    expect(message).not.toBe('');
    expect(message.startsWith('Request failed for')).toBe(false);
  });

  it('attempts with a finite override (control)', async () => {
    const message = await errorOf({ maxAttempts: 1 });

    expect(message.startsWith('Request failed for')).toBe(false);
  });

  it('falls back to the default attempts when the option is absent', async () => {
    const message = await errorOf({});

    expect(message.startsWith('Request failed for')).toBe(false);
  });
});
