import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BaseHTTPTransport, type HttpTransportOptions } from '../src/transport-base.js';
import {
  assertTransportAddressAllowed,
  classifyTransportAddress,
  type TransportDnsLookup,
  type TransportDnsRecord,
  transportPinnedLookup,
} from '../src/transport-security.js';

// ---------------------------------------------------------------------------
// classifyTransportAddress — the policy table the dial-time lookup enforces.
// ---------------------------------------------------------------------------

describe('classifyTransportAddress', () => {
  it('treats loopback as always-dialable', () => {
    expect(classifyTransportAddress('127.0.0.1', 4)).toBe('loopback');
    expect(classifyTransportAddress('127.8.8.8', 4)).toBe('loopback');
    expect(classifyTransportAddress('::1', 6)).toBe('loopback');
  });

  it('keeps link-local / IMDS in the unconditional blocked bucket', () => {
    expect(classifyTransportAddress('169.254.169.254', 4)).toBe('blocked');
    expect(classifyTransportAddress('fe80::1', 6)).toBe('blocked');
    expect(classifyTransportAddress('fe80::1%eth0', 6)).toBe('blocked');
    expect(classifyTransportAddress('fd00:ec2::254', 6)).toBe('blocked');
  });

  it('bins other private/reserved ranges as private (opt-in only)', () => {
    expect(classifyTransportAddress('10.1.2.3', 4)).toBe('private');
    expect(classifyTransportAddress('192.168.1.5', 4)).toBe('private');
    expect(classifyTransportAddress('172.16.0.9', 4)).toBe('private');
    expect(classifyTransportAddress('100.64.0.1', 4)).toBe('private');
    expect(classifyTransportAddress('0.0.0.0', 4)).toBe('private');
    expect(classifyTransportAddress('224.0.0.1', 4)).toBe('private');
    expect(classifyTransportAddress('fd00::1', 6)).toBe('private');
    expect(classifyTransportAddress('fc00::1', 6)).toBe('private');
  });

  it('leaves public addresses unrestricted', () => {
    expect(classifyTransportAddress('8.8.8.8', 4)).toBe('public');
    expect(classifyTransportAddress('1.1.1.1', 4)).toBe('public');
    expect(classifyTransportAddress('2606:4700::1111', 6)).toBe('public');
  });

  it('inherits the embedded IPv4 verdict for IPv4-mapped IPv6 (Chimera HIGH regression)', () => {
    // Both spellings occur in the wild: Node's DNS normalizes the dotted
    // mapped form to hex. Mapped IMDS/link-local must stay `blocked`, mapped
    // loopback must stay `loopback`, mapped LAN stays `private` — otherwise
    // ::ffff:169.254.169.254 would ride past the unconditional block as a
    // mere opt-in-able "private" hit.
    expect(classifyTransportAddress('::ffff:169.254.169.254', 6)).toBe('blocked');
    expect(classifyTransportAddress('::ffff:a9fe:a9fe', 6)).toBe('blocked');
    expect(classifyTransportAddress('::ffff:127.0.0.1', 6)).toBe('loopback');
    expect(classifyTransportAddress('::ffff:7f00:1', 6)).toBe('loopback');
    expect(classifyTransportAddress('::ffff:10.1.2.3', 6)).toBe('private');
    expect(classifyTransportAddress('::ffff:c0a8:105', 6)).toBe('private'); // 192.168.1.5
    expect(classifyTransportAddress('::ffff:808:808', 6)).toBe('public'); // 8.8.8.8
  });

  it('falls back to blocked for unknown families and malformed mapped tails', () => {
    expect(classifyTransportAddress('10.0.0.1', 0)).toBe('blocked');
    expect(classifyTransportAddress('::ffff:not-an-ip', 6)).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// assertTransportAddressAllowed
// ---------------------------------------------------------------------------

describe('assertTransportAddressAllowed', () => {
  it('throws for link-local/IMDS even when private networks are allowed', () => {
    for (const allow of [false, true]) {
      expect(() => assertTransportAddressAllowed('169.254.169.254', 4, 'imds.test', allow)).toThrow(
        /link-local\/IMDS/,
      );
      expect(() => assertTransportAddressAllowed('fe80::1', 6, 'v6.test', allow)).toThrow(
        /link-local\/IMDS/,
      );
    }
  });

  it('throws for private ranges without opt-in and names the escape hatch', () => {
    expect(() => assertTransportAddressAllowed('10.9.9.9', 4, 'lan.test', false)).toThrow(
      /allowPrivateNetworks/,
    );
  });

  it('allows private ranges with opt-in and loopback/public always', () => {
    expect(() => assertTransportAddressAllowed('10.9.9.9', 4, 'lan.test', true)).not.toThrow();
    expect(() => assertTransportAddressAllowed('127.0.0.1', 4, 'localhost', false)).not.toThrow();
    expect(() => assertTransportAddressAllowed('8.8.8.8', 4, 'dns.test', false)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// transportPinnedLookup — callback semantics + single-resolution seam
// ---------------------------------------------------------------------------

function makeLookup(
  table: Record<string, TransportDnsRecord[]>,
  calls: string[] = [],
): TransportDnsLookup {
  return async (hostname) => {
    calls.push(hostname);
    const records = table[hostname];
    if (!records) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return records;
  };
}

interface LookupResult {
  err: NodeJS.ErrnoException | null;
  address?: string | readonly TransportDnsRecord[] | undefined;
  family?: number | undefined;
}

function invokeOnce(
  lookup: ReturnType<typeof transportPinnedLookup>,
  hostname: string,
  connectOptions: { family?: number | undefined; all?: boolean | undefined } = {},
): Promise<LookupResult> {
  return new Promise((resolve) => {
    lookup(hostname, connectOptions, (err, address, family) => resolve({ err, address, family }));
  });
}

describe('transportPinnedLookup', () => {
  it('calls the resolver exactly once per invocation (no rebinding window)', async () => {
    const calls: string[] = [];
    const lookup = transportPinnedLookup({
      allowPrivateNetworks: false,
      lookup: makeLookup({ 'ok.test': [{ address: '8.8.8.8', family: 4 }] }, calls),
    });
    const result = await invokeOnce(lookup, 'ok.test');
    expect(result.err).toBeNull();
    expect(result.address).toBe('8.8.8.8');
    expect(result.family).toBe(4);
    expect(calls).toEqual(['ok.test']);
  });

  it('refuses before dial when any record is private without opt-in', async () => {
    const lookup = transportPinnedLookup({
      allowPrivateNetworks: false,
      lookup: makeLookup({
        // First record public — a first-record-only check would let this through.
        'mixed.test': [
          { address: '8.8.8.8', family: 4 },
          { address: '192.168.1.5', family: 4 },
        ],
      }),
    });
    const result = await invokeOnce(lookup, 'mixed.test');
    expect(result.err?.message).toMatch(/allowPrivateNetworks/);
  });

  it('allows the dial when every record passes with opt-in', async () => {
    const lookup = transportPinnedLookup({
      allowPrivateNetworks: true,
      lookup: makeLookup({ 'lan.test': [{ address: '10.0.0.7', family: 4 }] }),
    });
    const result = await invokeOnce(lookup, 'lan.test');
    expect(result.err).toBeNull();
    expect(result.address).toBe('10.0.0.7');
  });

  it('never allows link-local/IMDS, even with opt-in (mapped form included)', async () => {
    const lookup = transportPinnedLookup({
      allowPrivateNetworks: true,
      lookup: makeLookup({
        'imds.test': [{ address: '169.254.169.254', family: 4 }],
        'imds6.test': [{ address: '::ffff:a9fe:a9fe', family: 6 }],
      }),
    });
    const via4 = await invokeOnce(lookup, 'imds.test');
    expect(via4.err?.message).toMatch(/link-local\/IMDS/);
    const via6 = await invokeOnce(lookup, 'imds6.test');
    expect(via6.err?.message).toMatch(/link-local\/IMDS/);
  });

  it('honors the requested family when a match exists', async () => {
    const lookup = transportPinnedLookup({
      allowPrivateNetworks: false,
      lookup: makeLookup({
        'dual.test': [
          { address: '2606:4700::1111', family: 6 },
          { address: '8.8.8.8', family: 4 },
        ],
      }),
    });
    const v4 = await invokeOnce(lookup, 'dual.test', { family: 4 });
    expect(v4.address).toBe('8.8.8.8');
    const v6 = await invokeOnce(lookup, 'dual.test', { family: 6 });
    expect(v6.address).toBe('2606:4700::1111');
  });

  it('surfaces ENOTFOUND from the resolver', async () => {
    const lookup = transportPinnedLookup({
      allowPrivateNetworks: false,
      lookup: makeLookup({}),
    });
    const result = await invokeOnce(lookup, 'missing.test');
    expect(result.err?.code).toBe('ENOTFOUND');
  });
});

// ---------------------------------------------------------------------------
// Pinned-dispatcher integration — real loopback server, real undici dial.
// ---------------------------------------------------------------------------

/** Undici wraps dial-time errors as `TypeError: fetch failed` with the real
 *  gate error on `.cause` — flatten the chain for message assertions. */
function errorText(error: unknown, depth = 0): string {
  if (error === null || error === undefined || depth > 4) return '';
  const own = error instanceof Error ? error.message : String(error);
  return `${own}\n${errorText((error as { cause?: unknown }).cause, depth + 1)}`;
}

class TestTransport extends BaseHTTPTransport {
  constructor(opts: HttpTransportOptions) {
    super(opts, 'test');
  }
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async callTool(): Promise<never> {
    throw new Error('unused');
  }
  async request(): Promise<never> {
    throw new Error('unused');
  }
  protected genId(): number {
    return 1;
  }
  drive(url: string): Promise<Response> {
    return this.fetchWithAuthorization(url, { method: 'GET' });
  }
}

describe('resolution-bound dispatcher (live loopback dial)', () => {
  const seen: Array<{ host: string | undefined; url: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url });
    if (req.url === '/redirect-secure') {
      res.writeHead(302, { location: 'https://private.test/ping' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  let port = 0;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('dials the resolved loopback address and preserves the Host header', async () => {
    seen.length = 0;
    const transport = new TestTransport({
      name: 'pin-ok',
      url: `http://localhost:${port}/ping`,
      lookup: makeLookup({ localhost: [{ address: '127.0.0.1', family: 4 }] }),
    });
    const response = await transport.drive(`http://localhost:${port}/ping`);
    expect(response.status).toBe(200);
    // The Host header carries the configured hostname, not the pinned IP —
    // the same property that keeps TLS SNI and cert validation hostname-based.
    expect(seen[0]?.host).toBe(`localhost:${port}`);
  });

  it('refuses a hostname that resolves to a private address before any dial', async () => {
    const before = seen.length;
    const transport = new TestTransport({
      name: 'pin-lan',
      // https so the string-level http gate does not pre-empt the resolution
      // gate — the assertion below proves the DIAL-TIME check fires.
      url: `https://lan.test:${port}/ping`,
      lookup: makeLookup({ 'lan.test': [{ address: '10.9.9.9', family: 4 }] }),
    });
    const error = await transport.drive(`https://lan.test:${port}/ping`).then(
      () => null,
      (e: unknown) => e,
    );
    expect(errorText(error)).toMatch(/allowPrivateNetworks/);
    // The gate fires inside the dial's own lookup — the server never sees it.
    expect(seen.length).toBe(before);
  });

  it('blocks a redirect to a private HTTPS target on the hop (re-resolution per hop)', async () => {
    const transport = new TestTransport({
      name: 'pin-redirect',
      url: `http://localhost:${port}/redirect-secure`,
      lookup: makeLookup({
        localhost: [{ address: '127.0.0.1', family: 4 }],
        'private.test': [{ address: '10.9.9.9', family: 4 }],
      }),
    });
    const error = await transport.drive(`http://localhost:${port}/redirect-secure`).then(
      () => null,
      (e: unknown) => e,
    );
    // undici wraps dial-time errors as `TypeError: fetch failed` with the
    // gate's ConfigError on `.cause` — walk the chain.
    expect(errorText(error)).toMatch(/allowPrivateNetworks/);
  });

  it('blocks a link-local target even when the server opted in', async () => {
    const transport = new TestTransport({
      name: 'pin-imds',
      url: `https://imds.test:${port}/ping`,
      allowPrivateNetworks: true,
      lookup: makeLookup({ 'imds.test': [{ address: '169.254.169.254', family: 4 }] }),
    });
    const error = await transport.drive(`https://imds.test:${port}/ping`).then(
      () => null,
      (e: unknown) => e,
    );
    expect(errorText(error)).toMatch(/link-local\/IMDS/);
  });
});
