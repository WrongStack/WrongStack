/**
 * Shared IP-address guards for SSRF protection.
 *
 * Exported so `fetch.ts` (tools), `web-search/index.ts` (plugins), and any
 * other package that needs to validate IPs can all consume the same logic.
 * Any future additions (e.g. extra CIDR blocks) need only be made here.
 */

import * as dns from 'node:dns/promises';
import * as net from 'node:net';

/**
 * True if `addr` is in a private / loopback / link-local / reserved / CGNAT /
 * multicast range.  `net.isIP` is called by the caller first so `addr` is
 * guaranteed to be a canonical dotted-quad at this point.
 */
export function isPrivateIPv4(addr: string): boolean {
  if (typeof addr !== 'string') return true;
  const parts = addr.split('.').map((p) => {
    if (!/^\d+$/.test(p)) return Number.NaN;
    if (p.length > 1 && p.startsWith('0')) return Number.NaN;
    return Number.parseInt(p, 10);
  });
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // defensive: malformed → block
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + AWS/GCE/Azure IMDS
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 reserved
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

/**
 * True if `raw` (an IPv6 literal, already lowercased) is loopback / unique-local /
 * link-local / unspecified / IPv4-mapped-private.
 */
export function isPrivateIPv6(raw: string): boolean {
  if (typeof raw !== 'string') return true;
  const lower = raw.toLowerCase();
  if (lower === '::' || lower === '::1') return true; // loopback / unspecified

  // Expand to 8-group canonical form so range checks don't have to handle every
  // shorthand notation.  Returns null on malformed input — we conservatively
  // block in that case rather than leaking.
  const groups = expandIPv6(lower);
  if (!groups) return true;

  // RFC 8215 reserves 64:ff9b:1::/48 for local-use NAT64. Its network-specific
  // translation layout cannot be decoded safely without the configured prefix,
  // so block the entire range rather than risk a private IPv4 destination.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001) return true;

  // IPv4-mapped: ::ffff:0:0/96 → groups[0..5] all 0, groups[6..7] hold the
  // embedded IPv4 as two 16-bit words.  Node URL normalises the dotted form to
  // this representation (e.g. ::ffff:127.0.0.1 → ::ffff:7f00:1).
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const a = (groups[6] ?? 0) >> 8;
    const b = (groups[6] ?? 0) & 0xff;
    const c = (groups[7] ?? 0) >> 8;
    const d = (groups[7] ?? 0) & 0xff;
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
  }

  // Other transition formats that carry an IPv4 address inside an IPv6 one.
  // Each was reachable past the mapped-address branch above, so a private or
  // link-local IPv4 could be smuggled through in IPv6 clothing — most sharply
  // `64:ff9b::a9fe:a9fe`, which embeds 169.254.169.254 (WS-095).
  //
  // The embedded address is checked rather than the prefix being blocked
  // outright, so `2002:808:808::` (8.8.8.8 over 6to4) stays reachable while
  // `2002:7f00:1::` (127.0.0.1) does not.
  const embedded = embeddedIPv4(groups);
  if (embedded) return isPrivateIPv4(embedded);

  const high = groups[0] ?? 0;
  if ((high & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (fc..fd)
  if ((high & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((high & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** Render two 16-bit groups as a dotted IPv4 quad. */
function quad(hi: number | undefined, lo: number | undefined): string {
  return `${(hi ?? 0) >> 8}.${(hi ?? 0) & 0xff}.${(lo ?? 0) >> 8}.${(lo ?? 0) & 0xff}`;
}

/**
 * Extract the IPv4 address embedded in an IPv6 transition format, or undefined
 * when the address carries none.
 *
 * Covers the formats the mapped-address branch does not:
 *   - `64:ff9b::/96`   NAT64 well-known prefix (RFC 6052)
 *   - `2002::/16`      6to4 (RFC 3056) — the IPv4 sits in groups 1-2
 *   - `::ffff:0:0:0/96` IPv4-translated — 0xffff in group 4, not group 5
 *   - `::/96`          IPv4-compatible (deprecated, RFC 4291)
 */
export function embeddedIPv4(groups: number[]): string | undefined {
  const g = (i: number): number => groups[i] ?? 0;

  // NAT64 well-known prefix: 0064:ff9b:0:0:0:0:<ipv4> (RFC 6052 /96)
  if (g(0) === 0x0064 && g(1) === 0xff9b) {
    if (g(2) === 0 && g(3) === 0 && g(4) === 0 && g(5) === 0) {
      return quad(g(6), g(7));
    }
  }
  // 6to4: 2002:<ipv4>::/48
  if (g(0) === 0x2002) return quad(g(1), g(2));

  // Teredo (RFC 4380): 2001:0000::/32 — the client IPv4 in the last 32 bits
  // is stored XOR-obfuscated with 0xffffffff. MUST be checked before ISATAP:
  // group 5 holds the attacker-chosen obscured UDP port, which can collide
  // with the ISATAP 0x5efe marker and make ISATAP read the *obscured* client
  // IPv4 as plain (SSRF bypass + false positives).
  if (g(0) === 0x2001 && g(1) === 0) {
    return quad(~g(6) & 0xffff, ~g(7) & 0xffff);
  }

  // ISATAP (RFC 5214): the embedded IPv4 sits in the last 32 bits, preceded
  // by the IANA IID marker 0x5efe. The IID is `g(4):g(5) = 0000:5efe` (or the
  // u-bit variant 0200:5efe); requiring both words avoids false positives on
  // unrelated addresses that merely contain 0x5efe somewhere.
  if ((g(4) === 0x0000 || g(4) === 0x0200) && g(5) === 0x5efe) {
    return quad(g(6), g(7));
  }

  const highZero = g(0) === 0 && g(1) === 0 && g(2) === 0 && g(3) === 0;
  // IPv4-translated: ::ffff:0:<ipv4>
  if (highZero && g(4) === 0xffff && g(5) === 0) return quad(g(6), g(7));
  // IPv4-compatible: ::<ipv4>. `::` and `::1` are handled by the early return.
  if (highZero && g(4) === 0 && g(5) === 0) return quad(g(6), g(7));

  return undefined;
}

/**
 * Expand an IPv6 string into exactly 8 16-bit numbers.  Handles `::` compression.
 * Returns null on malformed input — caller should treat that as "block".
 */
export function expandIPv6(addr: string): number[] | null {
  const parts = addr.split('::');
  if (parts.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (g.length === 0 || g.length > 4) return null;
      const n = Number.parseInt(g, 16);
      if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
      out.push(n);
    }
    return out;
  };

  if (parts.length === 1) {
    const groups = parseGroups(parts[0] ?? '');
    if (groups?.length !== 8) return null;
    return groups;
  }

  const head = parseGroups(parts[0] ?? '');
  const tail = parseGroups(parts[1] ?? '');
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * Convenience: throw if `hostname` resolves to a private / loopback IP.
 * Use as a pre-flight check before opening a socket.
 *
 * ⚠️  This is not sufficient alone — connections must also use a pinned
 * dispatcher (so the OS re-uses the already-resolved address) or the same
 * check must be applied after every redirect hop.  See `guardedLookup` in
 * `fetch.ts` for the connection-level enforcement.
 */
export async function assertNotPrivateHost(hostname: string): Promise<void> {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('fetch: blocked localhost target');
  }

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    if (isPrivateIPv4(host)) {
      throw new Error(`fetch: blocked private/loopback address "${host}"`);
    }
  } else if (ipVersion === 6) {
    if (isPrivateIPv6(host)) {
      throw new Error(`fetch: blocked private/loopback address "${host}"`);
    }
  } else {
    // Hostname — resolve and reject if ANY record is private.
    try {
      const records = await dns.lookup(host, { all: true });
      for (const r of records) {
        // dns.lookup family: 4 = IPv4, 6 = IPv6
        const bad = r.family === 4 ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address);
        if (bad) {
          throw new Error(`fetch: resolved to private address ${r.address}`);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('fetch:')) throw err;
      // DNS failure — let fetch handle it rather than doubling the error.
    }
  }
}
