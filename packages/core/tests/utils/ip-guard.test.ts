import { afterEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({ lookup: (...a: unknown[]) => lookupMock(...a) }));

import {
  assertNotPrivateHost,
  expandIPv6,
  isLoopbackHost,
  isPrivateIPv4,
  isPrivateIPv6,
} from '../../src/utils/ip-guard.js';

describe('isPrivateIPv4', () => {
  it('blocks every reserved/private/loopback range', () => {
    for (const addr of [
      '0.0.0.0',
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254', // cloud metadata
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '192.0.0.1',
      '100.64.0.1', // CGNAT
      '224.0.0.1', // multicast
      '240.0.0.1', // reserved
    ]) {
      expect(isPrivateIPv4(addr), addr).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const addr of [
      '8.8.8.8',
      '1.1.1.1',
      '172.15.0.1',
      '172.32.0.1',
      '100.63.0.1',
      '93.184.216.34',
    ]) {
      expect(isPrivateIPv4(addr), addr).toBe(false);
    }
  });

  it('blocks malformed input defensively', () => {
    expect(isPrivateIPv4('1.2.3')).toBe(true); // too few octets
    expect(isPrivateIPv4('1.2.3.999')).toBe(true); // out of range
    expect(isPrivateIPv4('a.b.c.d')).toBe(true); // NaN
    expect(isPrivateIPv4('0177.0.0.1')).toBe(true); // octal notation
    expect(isPrivateIPv4('127.0.0.1abc')).toBe(true); // trailing non-digits
  });
});

describe('expandIPv6', () => {
  it('expands a full 8-group address', () => {
    expect(expandIPv6('2001:db8:0:0:0:0:0:1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
  });

  it('expands :: compression', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('fe80::1')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it.each([
    '2001:db8::1g',
    '2001:db8::+1',
    '2001:db8:: 1',
    '2001:db8::0x1',
    '2001:db8::1\n',
    '2001:db8::1\r',
    '2001:db8:0:0:0:0:0:1g',
    '2001:db8g::1',
  ])('rejects a group that only starts with valid hex: %s', (address) => {
    expect(expandIPv6(address)).toBeNull();
    expect(isPrivateIPv6(address)).toBe(true);
  });

  it('accepts complete uppercase and zero-padded hex groups', () => {
    const groups = [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0xabcd];
    expect(expandIPv6('2001:0DB8::ABCD')).toEqual(groups);
    expect(expandIPv6('2001:0DB8:0000:0000:0000:0000:0000:ABCD')).toEqual(groups);
    expect(isPrivateIPv6('2001:0DB8::ABCD')).toBe(false);
  });

  it('returns null on malformed input', () => {
    expect(expandIPv6('::a::b')).toBeNull(); // two '::'
    expect(expandIPv6('12345::')).toBeNull(); // group too long
    expect(expandIPv6('xyz::')).toBeNull(); // non-hex group
    expect(expandIPv6('1:2:3')).toBeNull(); // too few groups, no '::'
    expect(expandIPv6('1:2:3:4:5:6:7:8:9::')).toBeNull(); // fill < 0
  });
});

describe('isPrivateIPv6', () => {
  it('blocks loopback/unspecified', () => {
    expect(isPrivateIPv6('::')).toBe(true);
    expect(isPrivateIPv6('::1')).toBe(true);
  });

  it('blocks unique-local, link-local, and multicast', () => {
    expect(isPrivateIPv6('fc00::1')).toBe(true);
    expect(isPrivateIPv6('fd12:3456::1')).toBe(true);
    expect(isPrivateIPv6('fe80::abcd')).toBe(true);
    expect(isPrivateIPv6('ff02::1')).toBe(true);
  });

  it('blocks IPv4-mapped private addresses', () => {
    expect(isPrivateIPv6('::ffff:7f00:1')).toBe(true); // ::ffff:127.0.0.1
  });

  it('allows IPv4-mapped public and global unicast', () => {
    expect(isPrivateIPv6('::ffff:808:808')).toBe(false); // ::ffff:8.8.8.8
    expect(isPrivateIPv6('2001:db8::1')).toBe(false);
  });

  it('blocks malformed input defensively', () => {
    expect(isPrivateIPv6('12345::xyz')).toBe(true); // expandIPv6 → null
  });

  // WS-095. Only the IPv4-MAPPED form (::ffff:a.b.c.d) was decoded. The other
  // transition formats carry an IPv4 address too and sailed past every range
  // check below it, so a private or link-local IPv4 could be smuggled through
  // in IPv6 clothing.
  describe('IPv4 embedded in other transition formats', () => {
    it('blocks the cloud metadata address over NAT64', () => {
      // 64:ff9b::/96 is the RFC 6052 well-known prefix; a9fe:a9fe is
      // 169.254.169.254.
      expect(isPrivateIPv6('64:ff9b::a9fe:a9fe')).toBe(true);
    });

    it('blocks loopback and RFC1918 over NAT64', () => {
      expect(isPrivateIPv6('64:ff9b::7f00:1')).toBe(true); // 127.0.0.1
      expect(isPrivateIPv6('64:ff9b::c0a8:1')).toBe(true); // 192.168.0.1
    });

    it('conservatively blocks the RFC 8215 local-use NAT64 prefix', () => {
      // The configured translation layout is unavailable to this guard, so the
      // whole 64:ff9b:1::/48 range must be rejected, including its boundaries.
      expect(isPrivateIPv6('64:ff9b:1::')).toBe(true);
      expect(isPrivateIPv6('64:ff9b:1:7f00:1::')).toBe(true); // loopback destination
      expect(isPrivateIPv6('64:ff9b:1:c0a8:1::')).toBe(true); // RFC1918 destination
      expect(isPrivateIPv6('64:ff9b:1:a9fe:a9fe::')).toBe(true); // link-local destination
      expect(isPrivateIPv6('64:ff9b:1:ffff:ffff:ffff:ffff:ffff')).toBe(true);
      expect(isPrivateIPv6('64:ff9b:2::')).toBe(false); // outside the reserved /48
    });

    it('blocks loopback over 6to4', () => {
      expect(isPrivateIPv6('2002:7f00:1::')).toBe(true); // 127.0.0.1
      expect(isPrivateIPv6('2002:a9fe:a9fe::')).toBe(true); // 169.254.169.254
    });

    it('blocks loopback over ISATAP', () => {
      // ::5efe:<ipv4> — the IANA IID marker 0x5efe precedes the embedded IPv4.
      expect(isPrivateIPv6('::5efe:7f00:1')).toBe(true); // 127.0.0.1
      expect(isPrivateIPv6('2001:db8::5efe:a9fe:a9fe')).toBe(true); // 169.254.169.254
      // Public address over the same format stays reachable.
      expect(isPrivateIPv6('::5efe:808:808')).toBe(false); // 8.8.8.8
    });

    it('blocks loopback over Teredo', () => {
      // 2001:0000::/32 — the client IPv4 in the last 32 bits is XOR-obfuscated
      // with 0xffffffff, so 127.0.0.1 (0x7f000001) appears as 0x80fffffe.
      expect(isPrivateIPv6('2001::80ff:fffe')).toBe(true); // 127.0.0.1
      expect(isPrivateIPv6('2001:0:4136:e378:8000:63bf:80ff:fffe')).toBe(true);
      // 169.254.169.254 (0xa9fea9fe) XOR 0xffffffff = 0x56015601.
      expect(isPrivateIPv6('2001::5601:5601')).toBe(true);
      // Ordering pin: group 5 is the attacker-chosen obscured UDP port — when
      // it collides with the ISATAP 0x5efe marker, Teredo must win (checked
      // first), or ISATAP would read the *obscured* client IPv4 as plain and
      // let a private destination through.
      expect(isPrivateIPv6('2001:0:0:0:0:5efe:5601:5601')).toBe(true); // 169.254.169.254
    });

    it('blocks loopback in the IPv4-translated form', () => {
      // 0xffff sits in group 4 here, not group 5 — a different shape from the
      // mapped form the original check handled.
      expect(isPrivateIPv6('::ffff:0:7f00:1')).toBe(true);
    });

    it('blocks loopback in the deprecated IPv4-compatible form', () => {
      expect(isPrivateIPv6('::7f00:1')).toBe(true); // ::127.0.0.1
    });

    it('still allows a PUBLIC address in each of those formats', () => {
      // The embedded address is what is judged, so these prefixes are not
      // blocked wholesale.
      expect(isPrivateIPv6('64:ff9b::808:808')).toBe(false); // 8.8.8.8
      expect(isPrivateIPv6('2002:808:808::')).toBe(false); // 8.8.8.8
      expect(isPrivateIPv6('::ffff:0:808:808')).toBe(false);
    });
  });
});

describe('isLoopbackHost', () => {
  it('accepts localhost and the whole 127/8 IPv4 block', () => {
    for (const host of ['localhost', '127.0.0.1', '127.42.7.9', '127.255.255.255']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('accepts every legal spelling of the IPv6 loopback address', () => {
    for (const host of ['::1', '[::1]', '0:0:0:0:0:0:0:1', '[0:0:0:0:0:0:0:1]']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('accepts the IPv4-mapped loopback in dotted, hex and expanded forms', () => {
    for (const host of [
      '::ffff:127.0.0.1',
      '[::ffff:127.0.0.1]',
      // WHATWG URL serialises IPv4-mapped addresses in hex; this is the shape
      // settings.ts and ws-auth.ts actually hand the guard.
      '::ffff:7f00:1',
      '[::ffff:7f00:1]',
      '0:0:0:0:0:ffff:7f00:1',
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    expect(isLoopbackHost(new URL('http://[::ffff:127.0.0.1]:8080/').hostname)).toBe(true);
  });

  it('rejects remote addresses in both families', () => {
    for (const host of [
      '10.0.0.5',
      '8.8.8.8',
      '0.0.0.0',
      'example.com',
      '::',
      '::2',
      '[2001:db8::1]',
      '::ffff:808:808', // ::ffff:8.8.8.8
      '::ffff:c0a8:1', // ::ffff:192.168.0.1 — private, but not loopback
      '::ffff:a9fe:a9fe', // ::ffff:169.254.169.254
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe('assertNotPrivateHost', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    lookupMock.mockReset();
  });

  it('blocks localhost and .localhost', async () => {
    await expect(assertNotPrivateHost('localhost')).rejects.toThrow(/localhost/);
    await expect(assertNotPrivateHost('foo.localhost')).rejects.toThrow(/localhost/);
  });

  it('blocks a private IPv4 literal', async () => {
    await expect(assertNotPrivateHost('127.0.0.1')).rejects.toThrow(/private\/loopback/);
  });

  it('allows a public IPv4 literal', async () => {
    await expect(assertNotPrivateHost('8.8.8.8')).resolves.toBeUndefined();
  });

  it('blocks a bracketed private IPv6 literal', async () => {
    await expect(assertNotPrivateHost('[::1]')).rejects.toThrow(/private\/loopback/);
  });

  it('allows a public IPv6 literal', async () => {
    await expect(assertNotPrivateHost('2001:db8::1')).resolves.toBeUndefined();
  });

  it('rejects a hostname that resolves to a private address', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
    await expect(assertNotPrivateHost('evil.example.com')).rejects.toThrow(/resolved to private/);
  });

  it('rejects a hostname that resolves to a private IPv6 address', async () => {
    lookupMock.mockResolvedValue([{ address: 'fc00::1', family: 6 }] as never);
    await expect(assertNotPrivateHost('evil6.example.com')).rejects.toThrow(/resolved to private/);
  });

  it('allows a hostname that resolves to public addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    await expect(assertNotPrivateHost('example.com')).resolves.toBeUndefined();
  });

  it('swallows a DNS resolution failure (lets fetch surface it)', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertNotPrivateHost('nope.invalid')).resolves.toBeUndefined();
  });
});

describe('private IPv6 prefixes with an ISATAP-shaped interface ID', () => {
  // `…:5efe:<ipv4>` is valid under any prefix; a public embedded IPv4 must not
  // vouch for a link-local / unique-local / multicast destination.
  it('stays blocked whatever IPv4 the interface ID embeds', async () => {
    for (const addr of ['fe80::5efe:808:808', 'fd00::200:5efe:808:808', 'ff02::5efe:808:808']) {
      expect(isPrivateIPv6(addr), addr).toBe(true);
    }
    expect(isPrivateIPv6('2001:db8::5efe:808:808')).toBe(false);
    lookupMock.mockResolvedValue([{ address: 'fe80::5efe:808:808', family: 6 }] as never);
    await expect(assertNotPrivateHost('isatap.example.com')).rejects.toThrow(/resolved to private/);
  });
});
