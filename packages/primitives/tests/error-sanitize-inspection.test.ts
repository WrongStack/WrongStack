import { describe, expect, it } from 'vitest';
import { sanitizeApiError, scrubErrorDetail } from '../src/error-sanitize.js';

const hostileValues: Array<[string, () => unknown]> = [
  [
    'an Error with a throwing message getter',
    () => {
      const error = new Error('fixture failure');
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('message getter failed');
        },
      });
      return error;
    },
  ],
  [
    'a revoked proxy',
    () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    },
  ],
  [
    'a proxy whose prototype inspection throws',
    () =>
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('prototype inspection failed');
          },
        },
      ),
  ],
];

describe('error sanitization when thrown-value inspection fails', () => {
  it.each(hostileValues)('keeps the HTTP response opaque for %s', (_label, make) => {
    expect(sanitizeApiError(make())).toBe('internal error');
  });

  it.each(hostileValues)('keeps authenticated error detail usable for %s', (_label, make) => {
    expect(scrubErrorDetail(make())).toBe('unknown error');
  });

  it('retains existing behavior for failed String conversion', () => {
    const error = {
      toString() {
        throw new Error('conversion failed');
      },
    };
    expect(sanitizeApiError(error)).toBe('internal error');
    expect(scrubErrorDetail(error)).toBe('unknown error');
  });

  it('preserves normal classification, readable detail, and empty messages', () => {
    expect(sanitizeApiError(new Error('ENOENT: missing fixture'))).toBe('resource not found');
    expect(sanitizeApiError('EACCES: fixture permission failure')).toBe('permission denied');
    expect(scrubErrorDetail(new Error('fixture failure'))).toBe('fixture failure');
    expect(scrubErrorDetail(new Error(''))).toBe('');
  });
});
