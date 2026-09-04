import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import { assertNotPrivateHost, isPrivateIPv4, isPrivateIPv6 } from '@wrongstack/core/utils';

const SAFE_SUBRESOURCE_PROTOCOLS = new Set(['about:', 'blob:', 'data:']);

export async function assertBrowserUrlAllowed(
  rawUrl: string,
  opts: {
    allowPrivateHosts?: boolean | undefined;
    allowedPrivateOrigins?: readonly string[] | undefined;
    navigation?: boolean | undefined;
  },
): Promise<URL> {
  const url = parseBrowserUrl(rawUrl, opts.navigation ?? true);
  if (!opts.navigation && SAFE_SUBRESOURCE_PROTOCOLS.has(url.protocol)) return url;
  if (!opts.allowPrivateHosts && !isAllowedPrivateOrigin(url, opts.allowedPrivateOrigins)) {
    await assertNotPrivateHost(url.hostname);
  }
  return url;
}

export interface BrowserResolvedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export type BrowserDnsLookup = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

/**
 * Resolve once, validate every answer, and return the exact address a socket
 * must use. Callers must connect to `address`, never resolve `url.hostname`
 * again, otherwise DNS rebinding remains possible.
 */
export async function resolvePinnedBrowserTarget(
  rawUrl: string,
  opts: {
    allowPrivateHosts?: boolean | undefined;
    allowedPrivateOrigins?: readonly string[] | undefined;
    lookup?: BrowserDnsLookup | undefined;
  } = {},
): Promise<BrowserResolvedTarget> {
  const url = parseBrowserUrl(rawUrl, true);
  const allowPrivate =
    opts.allowPrivateHosts === true || isAllowedPrivateOrigin(url, opts.allowedPrivateOrigins);
  const hostname = unbracket(url.hostname);
  const literalFamily = net.isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!allowPrivate && isPrivateAddress(hostname, literalFamily)) {
      throw new Error(`browser: blocked private/loopback address "${hostname}"`);
    }
    return { url, address: hostname, family: literalFamily };
  }
  if ((hostname === 'localhost' || hostname.endsWith('.localhost')) && !allowPrivate) {
    throw new Error('browser: blocked localhost target');
  }

  const lookup = opts.lookup ?? ((host) => dns.lookup(host, { all: true }));
  let records: readonly { address: string; family: number }[];
  try {
    records = await lookup(hostname);
  } catch (error) {
    throw new Error(
      `browser: DNS resolution failed for "${hostname}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (records.length === 0) throw new Error(`browser: DNS returned no addresses for "${hostname}"`);

  for (const record of records) {
    if (record.family !== 4 && record.family !== 6) {
      throw new Error(`browser: DNS returned an unsupported address family for "${hostname}"`);
    }
    if (!allowPrivate && isPrivateAddress(record.address, record.family)) {
      throw new Error(`browser: resolved to private address ${record.address}`);
    }
  }
  const selected = records[0]!;
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

export function parsePrivateOriginAllowlist(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const origins = new Set<string>();
  for (const entry of raw.split(',')) {
    // Tolerate surrounding quotes: Windows setx / .env files / PowerShell
    // profiles routinely store `VAR="http://…"` with the quotes embedded in
    // the value, and rejecting that here made EVERY browser tool call throw
    // on such machines (managerFor parses the allowlist per manager).
    const candidate = entry.trim().replace(/^["']+|["']+$/gu, '');
    if (!candidate) continue;
    const url = parseBrowserUrl(candidate, true);
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`browser: private origin allowlist entry must be an origin: "${candidate}"`);
    }
    origins.add(url.origin);
  }
  return [...origins];
}

function parseBrowserUrl(rawUrl: string, navigation: boolean): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('browser: url must be an absolute URL');
  }
  if (!navigation && SAFE_SUBRESOURCE_PROTOCOLS.has(url.protocol)) return url;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`browser: unsupported protocol "${url.protocol}"`);
  }
  if (url.username || url.password) {
    throw new Error('browser: credentials in URLs are not allowed');
  }
  return url;
}

function isAllowedPrivateOrigin(url: URL, origins: readonly string[] | undefined): boolean {
  return origins?.includes(url.origin) ?? false;
}

function isPrivateAddress(address: string, family: 4 | 6): boolean {
  return family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
}

function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Remove credentials, query strings, and fragments before persistence/output. */
export function safeBrowserUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'about:blank';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'about:blank';
  }
}

export function redactBrowserText(text: string): string {
  return text
    .replace(/\bauthorization\b\s*[:=]\s*[^\r\n]+/gi, 'Authorization=[REDACTED]')
    .replace(
      /\bauthorization\b\s*[:=]\s*(?:Basic|Bearer)\s+[^\s,;]+/gi,
      'Authorization=[REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(authorization|set[-_ ]?cookie|cookie|api[-_ ]?key|private[-_ ]?key|client[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|session[-_ ]?token|auth[-_ ]?token|token|password|secret)\b\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    );
}
