import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import { assertNotPrivateHost, isPrivateIPv4, isPrivateIPv6 } from '@wrongstack/core/utils';

const SAFE_SUBRESOURCE_PROTOCOLS = new Set(['about:', 'blob:', 'data:']);

/**
 * Allowlist entry that approves every loopback origin (localhost, *.localhost,
 * 127.0.0.0/8, ::1) on any port. Dev servers, HMR sockets and API ports each
 * have their own origin, and approving them one by one meant a new prompt for
 * every port. It never covers LAN, link-local or metadata addresses, and it
 * matches only a host that is literally loopback: a public name that resolves
 * to 127.0.0.1 is the DNS-rebinding shape and stays blocked.
 */
export const LOOPBACK_ALLOWANCE = 'loopback';

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
  if (!opts.allowPrivateHosts && !isPrivateOriginApproved(url, opts.allowedPrivateOrigins)) {
    const normalizedHost = unbracket(url.hostname).replace(/\.+$/, '').toLowerCase();
    if (normalizedHost === 'localhost' || normalizedHost.endsWith('.localhost')) {
      throw new Error(`browser: blocked localhost target${allowHint(url)}`);
    }
    // The shared guard labels its refusals "fetch:", which read as if the
    // browser tool had called fetch.
    await assertNotPrivateHost(url.hostname).catch((err: unknown) => {
      if (err instanceof Error && err.message.startsWith('fetch: ')) {
        const hint = /private|loopback/i.test(err.message) ? allowHint(url) : '';
        throw new Error(`browser: ${err.message.slice('fetch: '.length)}${hint}`, { cause: err });
      }
      throw err;
    });
  }
  return url;
}

export interface BrowserResolvedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
  /**
   * Every validated answer, in resolver order, `address` first. A socket may
   * fall back to the next one (localhost answers ::1 before 127.0.0.1, and a
   * dev server often listens on only one of them) but never to an address
   * outside this list.
   */
  candidates: readonly { address: string; family: 4 | 6 }[];
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
  const exactOrigin =
    opts.allowPrivateHosts === true || (opts.allowedPrivateOrigins?.includes(url.origin) ?? false);
  const allowPrivate = exactOrigin || isPrivateOriginApproved(url, opts.allowedPrivateOrigins);
  const hostname = unbracket(url.hostname);
  const literalFamily = net.isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!allowPrivate && isPrivateAddress(hostname, literalFamily)) {
      throw new Error(`browser: blocked private/loopback address "${hostname}"${allowHint(url)}`);
    }
    return {
      url,
      address: hostname,
      family: literalFamily,
      candidates: [{ address: hostname, family: literalFamily }],
    };
  }
  const normalizedHost = hostname.replace(/\.+$/, '').toLowerCase();
  if ((normalizedHost === 'localhost' || normalizedHost.endsWith('.localhost')) && !allowPrivate) {
    throw new Error(`browser: blocked localhost target${allowHint(url)}`);
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
      throw new Error(`browser: resolved to private address ${record.address}${allowHint(url)}`);
    }
    // Approved only as loopback: a `*.localhost` name the hosts file points
    // somewhere else is not loopback any more.
    if (!exactOrigin && allowPrivate && !isLoopbackAddress(record.address, record.family)) {
      throw new Error(
        `browser: "${hostname}" resolved to non-loopback address ${record.address}, which the loopback allowance does not cover. Allow this exact origin with /browser allow ${url.origin}`,
      );
    }
  }
  const selected = records[0]!;
  return {
    url,
    address: selected.address,
    family: selected.family as 4 | 6,
    candidates: records.map((record) => ({
      address: record.address,
      family: record.family as 4 | 6,
    })),
  };
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
    if (candidate.toLowerCase() === LOOPBACK_ALLOWANCE) {
      origins.add(LOOPBACK_ALLOWANCE);
      continue;
    }
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

function allowHint(url: URL): string {
  const exact = `. Allow this project origin with /browser allow ${url.origin}`;
  return isLoopbackHostname(url.hostname)
    ? `${exact}, or every local port with /browser allow loopback`
    : exact;
}

/** The fetch/read_url_content wording of the same hint. */
export function networkAllowHint(url: URL): string {
  const exact = `For a trusted development origin, run /network allow ${url.origin}`;
  return isLoopbackHostname(url.hostname)
    ? `${exact}, or /network allow loopback for every local port`
    : exact;
}

/** True when the exact origin, or the loopback allowance for a loopback host, is listed. */
export function isPrivateOriginApproved(url: URL, origins: readonly string[] | undefined): boolean {
  if (!origins) return false;
  if (origins.includes(url.origin)) return true;
  return (
    origins.includes(LOOPBACK_ALLOWANCE) &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    isLoopbackHostname(url.hostname)
  );
}

/** localhost, *.localhost, 127.0.0.0/8, ::1 and IPv4-mapped loopback, as written. */
export function isLoopbackHostname(rawHostname: string): boolean {
  const host = unbracket(rawHostname).replace(/\.+$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const family = net.isIP(host);
  return family === 4 || family === 6 ? isLoopbackAddress(host, family) : false;
}

function isLoopbackAddress(address: string, family: number): boolean {
  if (family === 4) return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
  const lower = address.toLowerCase();
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped) return isLoopbackAddress(mapped[1]!, 4);
  // WHATWG URL serialises [::ffff:127.0.0.1] as [::ffff:7f00:1].
  return /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(lower);
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
  return (
    text
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      // An unquoted Cookie / Set-Cookie value is a `;`-separated list of
      // credentials; the generic value pattern below stops at the first `;`
      // and would leave every later pair in the clear. Quoted values are
      // handled whole by the generic rule.
      .replace(/\b(set[-_ ]?cookie|cookie)([ \t]*[:=][ \t]*)(?!["'])[^\r\n]+/gi, '$1$2[REDACTED]')
      // The optional `prefix_` segments cover compound names (GITHUB_TOKEN,
      // db_password, stripe-secret): `_` is a word character, so a bare `\b`
      // before the name never matched them and their values passed through.
      .replace(
        /(["']?)\b((?:[A-Za-z0-9]+[-_.]){0,6}(?:authorization|set[-_ ]?cookie|cookie|api[-_ ]?key|secret[-_ ]?access[-_ ]?key|private[-_ ]?key|client[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|session[-_ ]?token|auth[-_ ]?token|token|password|secret))\b\1(\s*[:=]\s*)((?:"[^"\r\n]*"|'[^'\r\n]*'|(?:Basic|Bearer)\s+[^\s,;]+|[^\s,;]+))/gi,
        (_match, q1, key, sep, val) => {
          const quote = val.startsWith('"') ? '"' : val.startsWith("'") ? "'" : '';
          return `${q1}${key}${q1}${sep}${quote}[REDACTED]${quote}`;
        },
      )
  );
}
