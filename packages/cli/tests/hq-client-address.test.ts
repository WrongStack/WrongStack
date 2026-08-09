/**
 * WS-106 — client-address resolution for the HQ login backoff.
 *
 * The property under test is asymmetric on purpose: with no configured proxy
 * hops the forwarded header must be completely inert (an attacker cannot mint
 * rate-limit identities), and with hops configured only the rightmost entries
 * — the ones trusted infrastructure appended — may be read.
 */
import type * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { parseForwardedEntry, resolveClientAddress } from '../src/hq-server/client-address.js';

function req(remoteAddress: string | undefined, xff?: string | string[]): http.IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  } as unknown as http.IncomingMessage;
}

describe('resolveClientAddress — default (hops = 0)', () => {
  it('returns the socket peer and ignores X-Forwarded-For entirely', () => {
    expect(resolveClientAddress(req('203.0.113.7', '1.2.3.4'))).toBe('203.0.113.7');
    expect(resolveClientAddress(req('203.0.113.7', '1.2.3.4, 5.6.7.8'))).toBe('203.0.113.7');
  });

  it('a spoofed header cannot mint a fresh rate-limit identity', () => {
    const a = resolveClientAddress(req('203.0.113.7', '10.0.0.1'));
    const b = resolveClientAddress(req('203.0.113.7', '10.0.0.2'));
    expect(a).toBe(b);
  });

  it('normalizes IPv4-mapped IPv6 so one client is one bucket', () => {
    expect(resolveClientAddress(req('::ffff:203.0.113.7'))).toBe('203.0.113.7');
  });

  it('falls back to a single shared bucket when the socket has no address', () => {
    expect(resolveClientAddress(req(undefined))).toBe('unknown');
  });
});

describe('resolveClientAddress — behind a declared proxy', () => {
  it('hops=1 uses the address the immediate trusted proxy recorded', () => {
    expect(resolveClientAddress(req('10.0.0.1', '198.51.100.5'), 1)).toBe('198.51.100.5');
  });

  it('hops=1 reads the RIGHTMOST entry, not the client-controlled leftmost one', () => {
    // The client claimed `1.1.1.1`; the trusted proxy appended `198.51.100.5`.
    expect(resolveClientAddress(req('10.0.0.1', '1.1.1.1, 198.51.100.5'), 1)).toBe('198.51.100.5');
  });

  it('hops=2 steps one further out through two trusted proxies', () => {
    expect(resolveClientAddress(req('10.0.0.1', '1.1.1.1, 198.51.100.5, 10.0.0.2'), 2)).toBe(
      '198.51.100.5',
    );
  });

  it('separates two clients behind the same tunnel', () => {
    const a = resolveClientAddress(req('10.0.0.1', '198.51.100.5'), 1);
    const b = resolveClientAddress(req('10.0.0.1', '198.51.100.9'), 1);
    expect(a).not.toBe(b);
  });

  it('falls back to the socket peer when the chain is shorter than the hop count', () => {
    // A client that stripped the header must not escape into an unlimited
    // identity — it shares the proxy's bucket instead.
    expect(resolveClientAddress(req('10.0.0.1'), 1)).toBe('10.0.0.1');
    expect(resolveClientAddress(req('10.0.0.1', '198.51.100.5'), 3)).toBe('10.0.0.1');
  });

  it('drops junk entries rather than treating them as identities', () => {
    expect(resolveClientAddress(req('10.0.0.1', 'not-an-ip'), 1)).toBe('10.0.0.1');
  });

  it('joins repeated headers left to right', () => {
    expect(resolveClientAddress(req('10.0.0.1', ['1.1.1.1', '198.51.100.5']), 1)).toBe(
      '198.51.100.5',
    );
  });

  it('treats a negative or fractional hop count as 0', () => {
    expect(resolveClientAddress(req('10.0.0.1', '198.51.100.5'), -1)).toBe('10.0.0.1');
    expect(resolveClientAddress(req('10.0.0.1', '198.51.100.5'), Number.NaN)).toBe('10.0.0.1');
  });
});

describe('parseForwardedEntry', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    [' 203.0.113.7 ', '203.0.113.7'],
    ['203.0.113.7:4711', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8::1', '2001:db8::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['[2001:db8::1]:4711', '2001:db8::1'],
  ])('parses %s', (input, expected) => {
    expect(parseForwardedEntry(input)).toBe(expected);
  });

  it.each(['', '   ', 'unknown', 'not-an-ip', '999.999.999.999', '_hidden'])(
    'rejects %s',
    (input) => {
      expect(parseForwardedEntry(input)).toBeUndefined();
    },
  );
});
