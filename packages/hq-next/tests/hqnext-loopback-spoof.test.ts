import { describe, expect, it } from 'vitest';
import { isLoopbackBrowserOrigin } from '../src/hq/data/transport/loopback';

describe('isLoopbackBrowserOrigin IPv4-mapped validation (F2271)', () => {
  it('rejects spoofed ::ffff:127. hostnames while accepting valid IPv4-mapped loopback', () => {
    expect(isLoopbackBrowserOrigin('::ffff:127.evil.com')).toBe(false);
    expect(isLoopbackBrowserOrigin('::ffff:127.999.0.1')).toBe(false);
    expect(isLoopbackBrowserOrigin('::ffff:127.0.0.1')).toBe(true);
  });
});
