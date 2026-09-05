import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import { ConfigError } from '@wrongstack/core/types';
import { isPrivateIPv4, isPrivateIPv6 } from '@wrongstack/core/utils';

export function isTlsUnsafeAllowed(): boolean {
  return process.env['WRONGSTACK_UNSAFE_MCP_TLS'] === '1';
}

/**
 * Validate that an MCP transport URL is not targeting private/internal
 * addresses. This is a defense-in-depth SSRF check — MCP servers are
 * typically local or LAN, but config manipulation could point to metadata
 * endpoints (169.254.169.254) or internal services.
 *
 * The check is intentionally lighter than fetch.ts's assertNotPrivate:
 * MCP URLs are admin-configured, not LLM-supplied, so we only block
 * the most obvious attack vectors.
 */
export function validateTransportUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError({
      message: `MCP transport: invalid URL "${rawUrl}"`,
      code: 'CONFIG_INVALID',
      context: { field: 'url', rawUrl },
    });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError({
      message: `MCP transport: unsupported protocol "${url.protocol}" — only http/https allowed`,
      code: 'CONFIG_INVALID',
      context: { field: 'url', rawUrl, protocol: url.protocol },
    });
  }

  const hostname = url.hostname;
  // URL.hostname keeps the brackets on IPv6 literals; strip them so net.isIP
  // and prefix checks see the bare address.
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  // Block cloud metadata endpoints (IMDS) — these are never valid MCP servers
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const parts = host.split('.').map(Number);
    // 169.254.x.x (link-local / IMDS)
    if (parts[0] === 169 && parts[1] === 254) {
      throw new ConfigError({
        message: `MCP transport: blocked link-local/IMDS address "${hostname}" — likely not a valid MCP server`,
        code: 'CONFIG_INVALID',
        context: { field: 'url', rawUrl, hostname },
      });
    }
  } else if (ipVersion === 6) {
    const lower = host.toLowerCase();
    // fe80::/10 link-local (first hextet fe80–febf) and the AWS IPv6 IMDS
    // address fd00:ec2::254 — the IPv6 counterparts of the IPv4 block above.
    const linkLocal = /^fe[89ab]/.test(lower);
    if (linkLocal || lower === 'fd00:ec2::254') {
      throw new ConfigError({
        message: `MCP transport: blocked link-local/IMDS address "${hostname}" — likely not a valid MCP server`,
        code: 'CONFIG_INVALID',
        context: { field: 'url', rawUrl, hostname },
      });
    }
  }

  // Plaintext http: is only permitted for loopback addresses where the
  // attacker would already need machine-level access. Remote HTTP MCP servers
  // must use TLS so an active network attacker cannot read or modify tool
  // calls and responses.
  if (url.protocol === 'http:') {
    const isLoopback =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]';
    if (!isLoopback) {
      throw new ConfigError({
        message: `MCP transport: http:// is only allowed for loopback addresses; use https:// for "${hostname}"`,
        code: 'CONFIG_INVALID',
        context: { field: 'url', rawUrl, hostname, protocol: url.protocol },
      });
    }
  }
}

// ── Resolution-bound dial policy (spike b1a8814a) ──────────────────────────
// validateTransportUrl inspects the URL string only. The layer below performs
// the SINGLE DNS resolution the TCP dial uses and classifies every returned
// address, so DNS rebinding cannot swap in a private target between
// validation and connect. Address classification reuses the shared guards
// from @wrongstack/core/utils (isPrivateIPv4/isPrivateIPv6) — the same
// classifier tools/_fetch-guard.ts and MCP OAuth discovery already use; this
// module only adds MCP transport policy on top of it.

/** Global escape hatch, mirroring the fetch tool's WRONGSTACK_FETCH_ALLOW_PRIVATE. */
export const ALLOW_MCP_PRIVATE_NETWORKS = process.env['WRONGSTACK_MCP_ALLOW_PRIVATE'] === '1';
/* v8 ignore next 7 -- module-load opt-in warning; env not set in tests. */
if (ALLOW_MCP_PRIVATE_NETWORKS && !process.env['CI']) {
  console.warn(
    '[WrongStack] WARNING: WRONGSTACK_MCP_ALLOW_PRIVATE=1 is active —\n' +
      '  MCP HTTP transports may dial private/LAN addresses (10.x, 192.168.x,\n' +
      '  172.16-31.x, ULA) when a server config sets allowPrivateNetworks. ' +
      'Link-local/IMDS targets stay blocked.',
  );
}

/** One resolved DNS record for an MCP transport hostname. */
export interface TransportDnsRecord {
  address: string;
  family: number;
}

/** DNS seam: production uses dns.lookup(host, { all: true }); tests inject. */
export type TransportDnsLookup = (hostname: string) => Promise<readonly TransportDnsRecord[]>;

/** Policy verdict for one resolved address. */
export type TransportAddressClass = 'loopback' | 'private' | 'blocked' | 'public';

/**
 * Classify one resolved address under MCP transport policy:
 *  - `blocked`  — link-local / IMDS (169.254/16, fe80::/10, fd00:ec2::254);
 *                 never a valid MCP target, regardless of opt-in.
 *  - `loopback` — 127/8, ::1; the documented local topology, always allowed.
 *  - `private`  — other private/reserved ranges (10/8, 172.16/12, 192.168/16,
 *                 CGNAT, ULA, ...); allowed only with allowPrivateNetworks.
 *  - `public`   — no dial-time restriction beyond the string-level checks.
 */
export function classifyTransportAddress(address: string, family: number): TransportAddressClass {
  if (family === 4) {
    const v4 = address.toLowerCase();
    if (v4.startsWith('169.254.')) return 'blocked';
    if (v4.startsWith('127.')) return 'loopback';
    return isPrivateIPv4(address) ? 'private' : 'public';
  }
  if (family === 6) {
    const v6 = address.toLowerCase();
    if (v6 === '::1') return 'loopback';
    // fe80::/10 (zone suffixes like %eth0 still start fe8-feb) and the AWS
    // IPv6 IMDS literal — the ranges validateTransportUrl never allows.
    if (/^fe[89ab]/.test(v6) || v6 === 'fd00:ec2::254') return 'blocked';
    // IPv4-mapped IPv6 (::ffff:a.b.c.d, normalized by Node's DNS to
    // ::ffff:hextet:hextet) must inherit the embedded IPv4 verdict, or a
    // mapped 169.254.169.254 would slip past the unconditional IMDS block as
    // a mere opt-in-able "private" hit.
    if (v6.startsWith('::ffff:')) {
      const tail = v6.slice('::ffff:'.length);
      if (tail.includes('.')) return classifyTransportAddress(tail, 4);
      const hextets = tail.split(':');
      if (hextets.length === 2) {
        const high = Number.parseInt(hextets[0]!, 16);
        const low = Number.parseInt(hextets[1]!, 16);
        if (Number.isFinite(high) && Number.isFinite(low)) {
          return classifyTransportAddress(
            `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
            4,
          );
        }
      }
      return 'blocked';
    }
    return isPrivateIPv6(v6) ? 'private' : 'public';
  }
  return 'blocked';
}

/**
 * Refuse `address` unless the transport policy allows dialing it:
 * link-local/IMDS always throws; other private ranges throw unless opted in
 * via allowPrivateNetworks. `hostname` is the configured name the address was
 * resolved from, kept for error context.
 */
export function assertTransportAddressAllowed(
  address: string,
  family: number,
  hostname: string,
  allowPrivateNetworks: boolean,
): void {
  const classification = classifyTransportAddress(address, family);
  if (classification === 'blocked') {
    throw new ConfigError({
      message: `MCP transport: resolved address "${address}" for "${hostname}" is link-local/IMDS — never a valid MCP target`,
      code: 'CONFIG_INVALID',
      context: { hostname, address },
    });
  }
  if (classification === 'private' && !allowPrivateNetworks) {
    throw new ConfigError({
      message:
        `MCP transport: "${hostname}" resolved to private address ${address}. ` +
        'Private/LAN targets are blocked by default; if this server really runs on ' +
        'your private network, set allowPrivateNetworks: true on its config ' +
        '(or WRONGSTACK_MCP_ALLOW_PRIVATE=1 globally).',
      code: 'CONFIG_INVALID',
      context: { hostname, address },
    });
  }
}

/** Node-style DNS callback for undici Agent connect options. */
type NodeLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | readonly TransportDnsRecord[],
  family?: number,
) => void;

export interface PinnedLookupOptions {
  allowPrivateNetworks: boolean;
  /** Test/host seam. Production omits it: dns.lookup(all: true). */
  lookup?: TransportDnsLookup | undefined;
}

/**
 * The lookup installed into the pinned undici Agent's connect options. It is
 * the single DNS resolution the TCP dial performs: every returned record is
 * classified and refused BEFORE the socket connects, so there is no rebinding
 * window between validation and connect. Mirrors tools/_fetch-guard.ts
 * guardedLookup with MCP policy (loopback allowed, link-local never, opt-in
 * for other private ranges).
 */
export function transportPinnedLookup(
  options: PinnedLookupOptions,
): (
  hostname: string,
  connectOptions: { family?: number | undefined; all?: boolean | undefined },
  callback: NodeLookupCallback,
) => void {
  const lookup = options.lookup ?? (async (host: string) => dns.lookup(host, { all: true }));
  return (hostname, connectOptions, callback) => {
    lookup(hostname)
      .then((records) => {
        if (records.length === 0) {
          callback(
            Object.assign(new Error(`MCP transport: no addresses for "${hostname}"`), {
              code: 'ENOTFOUND',
            }),
          );
          return;
        }
        for (const record of records) {
          assertTransportAddressAllowed(
            record.address,
            record.family,
            hostname,
            options.allowPrivateNetworks,
          );
        }
        const wanted = connectOptions?.family;
        const filtered =
          wanted === 4 || wanted === 6
            ? records.filter((record) => record.family === wanted)
            : records;
        const list = filtered.length > 0 ? filtered : records;
        if (connectOptions?.all) {
          callback(
            null,
            list.map((record) => ({ address: record.address, family: record.family })),
          );
          return;
        }
        const first = list[0]!;
        callback(null, first.address, first.family);
      })
      .catch((error) => callback(error as NodeJS.ErrnoException));
  };
}
