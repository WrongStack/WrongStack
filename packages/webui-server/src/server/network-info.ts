/**
 * Network interface discovery for the startup banner.
 *
 * When the server binds to a wildcard address (`0.0.0.0` / `::`), the
 * operator needs to know which external IPs are reachable so they can
 * construct browser URLs for Tailscale/LAN peers without manually
 * running `ip addr` or `ipconfig`.
 *
 * Extracted as a pure function (with an injectable `os.networkInterfaces`
 * seam) so it can be unit-tested without mocking the OS.
 */
import * as os from 'node:os';
import { isWildcardBind } from './ws-auth.js';

export interface NetworkAddress {
  /** IPv4 or IPv6 address (no brackets). */
  address: string;
  /** Interface name (e.g. `eth0`, `tailscale0`). */
  interface: string;
  /** Address family — `'IPv4'` or `'IPv6'`. */
  family: 'IPv4' | 'IPv6';
  /** True when this address belongs to the Tailscale CGNAT / ULA range. */
  tailscale: boolean;
}

/** Tailscale IPv4 CGNAT prefix: 100.64.0.0/10 (100.64.0.0 – 100.127.255.255). */
function isTailscaleIPv4(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  const octet = Number.parseInt(parts[0] ?? '', 10);
  const second = Number.parseInt(parts[1] ?? '', 10);
  return octet === 100 && second >= 64 && second <= 127;
}

/** Tailscale IPv6 ULA prefix: fd7a:115c:a1e0::/48. */
function isTailscaleIPv6(addr: string): boolean {
  return addr.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

/**
 * Enumerate all external (non-internal) network addresses on this machine.
 *
 * Returns addresses grouped and sorted:
 *   1. Tailscale addresses first (IPv4 then IPv6)
 *   2. Other external addresses (IPv4 then IPv6)
 *
 * Loopback, link-local, and internal addresses are filtered out.
 *
 * @param getInterfaces — Injectable seam for testing; defaults to
 *   `os.networkInterfaces()`.
 */
export function getExternalAddresses(
  getInterfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces,
): NetworkAddress[] {
  const interfaces = getInterfaces();
  const result: NetworkAddress[] = [];

  for (const [ifName, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      const family = addr.family === 'IPv6' ? 'IPv6' : 'IPv4';
      // Skip link-local IPv6 (fe80::) and IPv4 APIPA (169.254.x.x).
      if (family === 'IPv6' && addr.address.toLowerCase().startsWith('fe80:')) continue;
      if (family === 'IPv4' && addr.address.startsWith('169.254.')) continue;
      const tailscale =
        family === 'IPv4' ? isTailscaleIPv4(addr.address) : isTailscaleIPv6(addr.address);
      result.push({ address: addr.address, interface: ifName, family, tailscale });
    }
  }

  // Sort: Tailscale first, then other external. Within each group, IPv4 before IPv6.
  result.sort((a, b) => {
    if (a.tailscale !== b.tailscale) return a.tailscale ? -1 : 1;
    if (a.family !== b.family) return a.family === 'IPv4' ? -1 : 1;
    return 0;
  });

  return result;
}

/**
 * Format the extra access-URL lines for a wildcard bind.
 *
 * Returns a list of indented, ready-to-print lines showing the external
 * IPs and their access URLs. Authentication tokens are deliberately excluded
 * because these lines are written to terminal and session logs.
 */
export function formatExternalAccessUrls(opts: {
  bindHost: string;
  port: number;
  publicUrl?: string | undefined;
  getInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}): string[] {
  if (!isWildcardBind(opts.bindHost)) return [];
  const addresses = getExternalAddresses(opts.getInterfaces);
  if (addresses.length === 0) return [];

  const lines: string[] = [];
  const seen = new Set<string>();
  for (const addr of addresses) {
    const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
    if (seen.has(host)) continue;
    seen.add(host);
    const label = addr.tailscale ? 'Tailscale' : addr.interface;
    const url = `http://${host}:${opts.port}`;
    lines.push(`    ▸ ${label}: ${url}`);
  }
  return lines;
}
