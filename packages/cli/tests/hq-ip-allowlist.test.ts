import { describe, expect, it, vi } from 'vitest';
import { createHqIpAllowlist, parseHqIpAllowlist } from '../src/hq-server/ip-allowlist.js';
import { createHqRouter } from '../src/hq-server/routes.js';
import { handleHqUpgrade } from '../src/hq-server/upgrade-handler.js';

describe('HQ IP allowlist', () => {
  it('is disabled by default', () => {
    expect(createHqIpAllowlist(undefined)).toBeUndefined();
    expect(parseHqIpAllowlist('  ')).toBeUndefined();
  });

  it('accepts exact IPv4/IPv6 addresses and CIDR networks', () => {
    const allowlist = createHqIpAllowlist(['203.0.113.9', '10.20.0.0/16', '2001:db8::/32'])!;
    expect(allowlist.allows('203.0.113.9')).toBe(true);
    expect(allowlist.allows('10.20.44.8')).toBe(true);
    expect(allowlist.allows('10.21.0.1')).toBe(false);
    expect(allowlist.allows('2001:db8::42')).toBe(true);
    expect(allowlist.allows('2001:db9::42')).toBe(false);
  });

  it('always retains local administration and normalizes mapped IPv4 peers', () => {
    const allowlist = createHqIpAllowlist(['203.0.113.9'])!;
    expect(allowlist.allows('127.0.0.1')).toBe(true);
    expect(allowlist.allows('::1')).toBe(true);
    expect(allowlist.allows('::ffff:203.0.113.9')).toBe(true);
  });

  it.each(['example.com', '10.0.0.0/33', '2001:db8::/129', '10.0.0.0/nope', ','])(
    'rejects invalid rule %s before bind',
    (rule) => {
      expect(() => parseHqIpAllowlist(rule)).toThrow(/allowlist/);
    },
  );

  it('rejects HTTP before origin and authentication handlers run', async () => {
    const writeHead = vi.fn();
    const end = vi.fn();
    const router = createHqRouter({
      host: '0.0.0.0',
      listeningPort: () => 3499,
      trustedPublicOrigins: new Set(),
      ipAllowlist: createHqIpAllowlist(['203.0.113.9']),
    } as never);
    await router(
      {
        url: '/api/auth/status',
        headers: { host: '127.0.0.1:3499', 'x-forwarded-for': '203.0.113.9' },
        socket: { remoteAddress: '198.51.100.20' },
      } as never,
      { setHeader: vi.fn(), writeHead, end } as never,
    );
    expect(writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' });
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({ error: 'forbidden: source IP is not allowed' }),
    );
  });

  it('serves only a data-free health response before browser authentication', async () => {
    const writeHead = vi.fn();
    const end = vi.fn();
    const router = createHqRouter({
      host: '0.0.0.0',
      listeningPort: () => 3499,
      trustedPublicOrigins: new Set(),
    } as never);
    await router(
      {
        method: 'GET',
        url: '/healthz',
        headers: { host: '127.0.0.1:3499' },
        socket: { remoteAddress: '127.0.0.1' },
      } as never,
      { setHeader: vi.fn(), writeHead, end } as never,
    );
    expect(writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    expect(end).toHaveBeenCalledWith(JSON.stringify({ status: 'ok' }));
  });

  it('rejects both WebSocket surfaces before their auth handshake', () => {
    for (const pathname of ['/ws/browser', '/ws/client']) {
      const write = vi.fn();
      const destroy = vi.fn();
      handleHqUpgrade(
        {
          url: pathname,
          headers: { host: '127.0.0.1:3499', 'x-forwarded-for': '203.0.113.9' },
          socket: { remoteAddress: '198.51.100.20' },
        } as never,
        { write, destroy } as never,
        Buffer.alloc(0),
        {
          host: '0.0.0.0',
          port: 3499,
          listeningPort: () => 3499,
          trustedPublicOrigins: new Set(),
          ipAllowlist: createHqIpAllowlist(['203.0.113.9']),
        } as never,
      );
      expect(write).toHaveBeenCalledWith(expect.stringContaining('IP_NOT_ALLOWED'));
      expect(destroy).toHaveBeenCalledOnce();
    }
  });
});
