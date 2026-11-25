import { describe, expect, it } from 'vitest';
import { hubAddressAdvice } from '../src/lib/hub-address';

describe('hubAddressAdvice IPv4-mapped loopback recognition (F2273)', () => {
  it('classifies IPv4-mapped loopback origins as loopback', () => {
    expect(hubAddressAdvice('http://[::ffff:7f00:1]:3000').kind).toBe('loopback');
  });
});
