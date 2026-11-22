import * as dns from 'node:dns/promises';

import * as http from 'node:http';

import * as https from 'node:https';

import * as net from 'node:net';

import { isPrivateIPv4, isPrivateIPv6, toErrorMessage } from '@wrongstack/core/utils';

export interface MCPAuthorizationChallenge {
  status: 401;
  resource: string;
  resourceMetadataUrl?: string | undefined;
  scopes: string[];
  rawScheme: 'Bearer';
}

export interface MCPProtectedResourceMetadata {
  resource: string;
  authorizationServers: string[];
  scopesSupported: string[];
}

export interface MCPAuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string | undefined;
  authorizationResponseIssuerParameterSupported?: boolean | undefined;
  scopesSupported: string[];
}

export interface MCPAuthorizationDiscoveryResult {
  resourceMetadataUrl: string;
  authorizationServerMetadataUrl: string;
  protectedResource: MCPProtectedResourceMetadata;
  authorizationServer: MCPAuthorizationServerMetadata;
}

export type MCPAuthorizationJsonFetcher = (
  url: string,
  signal?: AbortSignal | undefined,
) => Promise<unknown | undefined>;

export interface MCPAuthorizationDiscoveryOptions {
  challengeHeader?: string | null | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
  lookup?: BrowserCompatibleDnsLookup | undefined;
  /** Test/host override. Production callers should use the pinned default. */
  fetchJson?: MCPAuthorizationJsonFetcher | undefined;
}

export type BrowserCompatibleDnsLookup = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

/** Non-2xx answer from an OAuth endpoint, carrying the HTTP status. */
export class MCPOAuthHttpError extends Error {
  override readonly name = 'MCPOAuthHttpError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function canonicalMcpResource(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('MCP authorization resource must be an absolute URL');
  }
  if (url.protocol !== 'https:' && !isLoopbackHttp(url)) {
    throw new Error('MCP authorization resource must use HTTPS (except loopback development)');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('MCP authorization resource must not contain credentials or a fragment');
  }
  if (url.pathname === '/' && !url.search) return url.origin;
  return url.toString();
}

export function parseMcpBearerChallenge(
  header: string | null,
  resource: string,
): MCPAuthorizationChallenge {
  const challenge: MCPAuthorizationChallenge = {
    status: 401,
    resource,
    scopes: [],
    rawScheme: 'Bearer',
  };
  if (!header) return challenge;
  const parameters = extractBearerParameters(header);
  if (parameters === undefined) return challenge;
  const resourceMetadata = challengeParameter(parameters, 'resource_metadata');
  if (resourceMetadata) {
    const metadataUrl = validateMetadataUrl(resourceMetadata);
    // The metadata document must be co-located with the resource it describes.
    // Every candidate in `protectedResourceMetadataUrls` is derived from the
    // resource's own origin, so a challenge naming some other host relocates
    // the whole OAuth flow off-origin — and the `resource` equality check in
    // `parseProtectedResourceMetadata` is satisfiable by whoever serves that
    // host, so it cannot say where the document came from. A foreign host is
    // ignored rather than trusted, and discovery falls through to the
    // origin-derived candidates.
    if (metadataUrl && isSameHost(metadataUrl, resource)) {
      challenge.resourceMetadataUrl = metadataUrl;
    }
  }
  const scope = challengeParameter(parameters, 'scope');
  if (scope) {
    challenge.scopes = [...new Set(scope.split(/\s+/).filter(Boolean))].slice(0, 64);
  }
  return challenge;
}

/** RFC 9728 fallback order for an MCP endpoint when no challenge URL exists. */
export function protectedResourceMetadataUrls(resource: string): string[] {
  const url = new URL(canonicalMcpResource(resource));
  const suffix = url.pathname === '/' ? '' : url.pathname;
  const candidates = [
    new URL(`/.well-known/oauth-protected-resource${suffix}`, url.origin).toString(),
    new URL('/.well-known/oauth-protected-resource', url.origin).toString(),
  ];
  return [...new Set(candidates)];
}

/** RFC 8414 + OIDC discovery order required by the MCP authorization spec. */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = secureOAuthUrl(issuer, 'authorization server issuer');
  // RFC 8414 §3.1: a terminating "/" of the issuer path is removed before the
  // well-known segment is inserted (the appended OIDC form already did this).
  const suffix = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  const candidates = [
    new URL(`/.well-known/oauth-authorization-server${suffix}`, url.origin).toString(),
    new URL(`/.well-known/openid-configuration${suffix}`, url.origin).toString(),
  ];
  if (suffix) {
    candidates.push(new URL(`${suffix}/.well-known/openid-configuration`, url.origin).toString());
  }
  return candidates;
}

export function parseProtectedResourceMetadata(
  value: unknown,
  expectedResource: string,
): MCPProtectedResourceMetadata {
  const metadata = record(value, 'protected resource metadata');
  const resource = canonicalMcpResource(requiredString(metadata['resource'], 'resource'));
  if (resource !== canonicalMcpResource(expectedResource)) {
    throw new Error('MCP protected resource metadata resource does not match the target server');
  }
  const authorizationServers = boundedStringArray(
    metadata['authorization_servers'],
    'authorization_servers',
    8,
  ).map((issuer) => secureOAuthUrl(issuer, 'authorization server issuer').toString());
  if (authorizationServers.length === 0) {
    throw new Error('MCP protected resource metadata must declare an authorization server');
  }
  return {
    resource,
    authorizationServers,
    scopesSupported: optionalStringArray(metadata['scopes_supported'], 'scopes_supported', 128),
  };
}

export function parseAuthorizationServerMetadata(
  value: unknown,
  expectedIssuer: string,
): MCPAuthorizationServerMetadata {
  const metadata = record(value, 'authorization server metadata');
  const issuer = secureOAuthUrl(requiredString(metadata['issuer'], 'issuer'), 'issuer').toString();
  if (issuer !== secureOAuthUrl(expectedIssuer, 'expected issuer').toString()) {
    throw new Error('MCP authorization metadata issuer mismatch');
  }
  const methods = boundedStringArray(
    metadata['code_challenge_methods_supported'],
    'code_challenge_methods_supported',
    16,
  );
  if (!methods.includes('S256')) {
    throw new Error('MCP authorization server does not advertise required PKCE S256 support');
  }
  const registration = optionalString(metadata['registration_endpoint'], 'registration_endpoint');
  const authorizationEndpoint = secureOAuthUrl(
    requiredString(metadata['authorization_endpoint'], 'authorization_endpoint'),
    'authorization endpoint',
    true,
  ).toString();
  const tokenEndpoint = secureOAuthUrl(
    requiredString(metadata['token_endpoint'], 'token_endpoint'),
    'token endpoint',
    true,
  ).toString();
  const issuerParameterSupported = optionalBoolean(
    metadata['authorization_response_iss_parameter_supported'],
    'authorization_response_iss_parameter_supported',
  );
  if (
    issuerParameterSupported !== true &&
    (new URL(authorizationEndpoint).origin !== new URL(issuer).origin ||
      new URL(tokenEndpoint).origin !== new URL(issuer).origin)
  ) {
    throw new Error(
      'MCP authorization server with cross-origin endpoints must support the authorization response issuer parameter',
    );
  }
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: registration
      ? secureOAuthUrl(registration, 'registration endpoint').toString()
      : undefined,
    authorizationResponseIssuerParameterSupported: issuerParameterSupported,
    scopesSupported: optionalStringArray(metadata['scopes_supported'], 'scopes_supported', 128),
  };
}

/**
 * Discover and validate MCP OAuth metadata without following redirects. The
 * default fetcher resolves once and opens the socket to that exact IP, making
 * discovery resistant to DNS rebinding.
 */
export async function discoverMcpAuthorization(
  resource: string,
  options: MCPAuthorizationDiscoveryOptions = {},
): Promise<MCPAuthorizationDiscoveryResult> {
  const canonicalResource = canonicalMcpResource(resource);
  const resourceUrl = new URL(canonicalResource);
  const allowedLoopbackHostname = isLoopbackHttp(resourceUrl)
    ? unbracket(resourceUrl.hostname).toLowerCase()
    : undefined;
  const fetchJson =
    options.fetchJson ??
    ((url, signal) =>
      requestPinnedJson(url, {
        signal,
        timeoutMs: options.timeoutMs,
        maxResponseBytes: options.maxResponseBytes,
        lookup: options.lookup,
        allowedLoopbackHostname,
      }));

  const challenge = parseMcpBearerChallenge(options.challengeHeader ?? null, canonicalResource);
  const resourceCandidates = challenge.resourceMetadataUrl
    ? [challenge.resourceMetadataUrl]
    : protectedResourceMetadataUrls(canonicalResource);
  const resourceDiscovery = await discoverFirst(
    resourceCandidates,
    fetchJson,
    options.signal,
    (value) => parseProtectedResourceMetadata(value, canonicalResource),
    'protected resource metadata',
  );
  const issuer = resourceDiscovery.value.authorizationServers[0]!;
  const authorizationDiscovery = await discoverFirst(
    authorizationServerMetadataUrls(issuer),
    fetchJson,
    options.signal,
    (value) => parseAuthorizationServerMetadata(value, issuer),
    'authorization server metadata',
  );
  return {
    resourceMetadataUrl: resourceDiscovery.url,
    authorizationServerMetadataUrl: authorizationDiscovery.url,
    protectedResource: resourceDiscovery.value,
    authorizationServer: authorizationDiscovery.value,
  };
}

function extractBearerParameters(header: string): string | undefined {
  const bearerAtStart = /^\s*Bearer(?:\s+(?!\s*=)|\s*(?=,|$))/i;
  let atBoundary = true;
  let i = 0;
  while (i < header.length) {
    if (atBoundary) {
      const m = bearerAtStart.exec(header.slice(i));
      if (m) {
        return header.slice(i + m[0].length);
      }
      atBoundary = false;
    }
    const ch = header[i]!;
    if (ch === '"') {
      i++;
      while (i < header.length) {
        if (header[i] === '\\') {
          i += 2;
          continue;
        }
        if (header[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === ',') {
      atBoundary = true;
    }
    i++;
  }
  return undefined;
}

export function challengeParameter(parameters: string, name: string): string | undefined {
  const target = name.toLowerCase();
  const itemPattern =
    /\s*(?:,\s*)*([A-Za-z0-9!#$%&'*+.^_`|~-]+)(?:\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+)))?/y;
  let index = 0;
  let first = true;
  while (index < parameters.length) {
    itemPattern.lastIndex = index;
    const match = itemPattern.exec(parameters);
    if (!match) break;
    const key = match[1]!;
    const quoted = match[2];
    const token = match[3];
    // A token without `=` after a comma separator (or after the first item) begins the next challenge scheme.
    if (quoted === undefined && token === undefined) {
      if (!first || /^\s*,/.test(match[0])) break;
      index = itemPattern.lastIndex;
      first = false;
      continue;
    }
    first = false;
    if (key.toLowerCase() === target) {
      const value = quoted ?? token;
      return value?.replace(/\\(.)/g, '$1');
    }
    index = itemPattern.lastIndex;
  }
  return undefined;
}

export function validateMetadataUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return undefined;
    if (url.protocol !== 'https:' && !isLoopbackHttp(url)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Whether `candidate` names the same host as the protected resource. Host
 * rather than origin: metadata served from another port of the resource's own
 * host is still that resource's metadata, and a hostname is compared after
 * unbracketing because `URL.hostname` keeps the brackets on an IPv6 literal.
 */
function isSameHost(candidate: string, resource: string): boolean {
  try {
    return (
      unbracket(new URL(candidate).hostname).toLowerCase() ===
      unbracket(new URL(resource).hostname).toLowerCase()
    );
  } catch {
    return false;
  }
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`MCP ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    throw new Error(`MCP authorization field "${field}" must be a bounded non-empty string`);
  }
  return value;
}

// Servers in the wild send an optional OAuth field as `null` or `""` (e.g. a
// token response with `"scope": ""`). RFC 6749 makes these fields optional, so
// both mean "not sent" rather than a malformed response that fails the sign-in.
export function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : requiredString(value, field);
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`MCP authorization field "${field}" must be a boolean`);
  }
  return value;
}

export function boundedStringArray(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`MCP authorization field "${field}" must be an array of at most ${maxItems}`);
  }
  return [...new Set(value.map((entry) => requiredString(entry, field)))];
}

export function optionalStringArray(value: unknown, field: string, maxItems: number): string[] {
  return value === undefined || value === null ? [] : boundedStringArray(value, field, maxItems);
}

/**
 * `allowQuery` is for endpoint URLs: RFC 6749 §3.1/§3.2 let the authorization
 * and token endpoints carry a query component that MUST be retained (Azure AD
 * B2C names its policy as `?p=…`). An issuer (RFC 8414 §2) never has one.
 */
export function secureOAuthUrl(value: string, label: string, allowQuery = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`MCP ${label} must be an absolute URL`);
  }
  if (url.protocol !== 'https:' && !isLoopbackHttp(url)) {
    throw new Error(`MCP ${label} must use HTTPS (except loopback development)`);
  }
  if (url.username || url.password || (url.search && !allowQuery) || url.hash) {
    throw new Error(`MCP ${label} must not contain credentials, query, or fragment components`);
  }
  if (url.pathname === '/' && !url.search) return new URL(url.origin);
  return url;
}

export async function discoverFirst<T>(
  candidates: readonly string[],
  fetchJson: MCPAuthorizationJsonFetcher,
  signal: AbortSignal | undefined,
  parse: (value: unknown) => T,
  label: string,
): Promise<{ url: string; value: T }> {
  const failures: string[] = [];
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    try {
      const value = await fetchJson(candidate, signal);
      if (value === undefined) {
        failures.push(`${candidate}: not found`);
        continue;
      }
      return { url: candidate, value: parse(value) };
    } catch (error) {
      signal?.throwIfAborted();
      failures.push(`${candidate}: ${toErrorMessage(error)}`);
    }
  }
  throw new Error(`MCP ${label} discovery failed (${failures.join('; ')})`);
}

export async function requestPinnedJson(
  rawUrl: string,
  options: {
    method?: 'GET' | 'POST' | undefined;
    body?: string | undefined;
    headers?: Record<string, string> | undefined;
    signal?: AbortSignal | undefined;
    timeoutMs?: number | undefined;
    maxResponseBytes?: number | undefined;
    lookup?: BrowserCompatibleDnsLookup | undefined;
    allowedLoopbackHostname?: string | undefined;
    /** Names the endpoint in errors — token calls were reported as "discovery". */
    label?: string | undefined;
  },
): Promise<unknown | undefined> {
  const label = options.label ?? 'discovery';
  // The request path below already forwards `url.search`; a token endpoint may
  // carry a query (RFC 6749 §3.2), and callers validate their own URLs first.
  const url = secureOAuthUrl(rawUrl, `${label} URL`, true);
  const target = await resolvePinnedAddress(url, options);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxResponseBytes ?? 64 * 1024;
  options.signal?.throwIfAborted();

  return new Promise<unknown | undefined>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      request.destroy(options.signal?.reason instanceof Error ? options.signal.reason : undefined);
    };
    const headers: Record<string, string | number> = {
      accept: 'application/json',
      host: url.host,
      ...options.headers,
    };
    if (options.body !== undefined) {
      headers['content-length'] = Buffer.byteLength(options.body);
    }
    const requestOptions: http.RequestOptions = {
      host: target.address,
      family: target.family,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      method: options.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
      ...(url.protocol === 'https:' && net.isIP(unbracket(url.hostname)) === 0
        ? { servername: unbracket(url.hostname) }
        : {}),
    };
    const requestFn = url.protocol === 'https:' ? https.request : http.request;
    const request = requestFn(requestOptions, (response) => {
      // Node only invokes the HTTP response callback after a status line has
      // been parsed, so statusCode is present here.
      const status = response.statusCode!;
      if (status === 404 || status === 410) {
        response.resume();
        finish(undefined, undefined);
        return;
      }
      if (status >= 300 && status < 400) {
        response.resume();
        finish(new Error(`MCP OAuth ${label} redirects are not allowed`));
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        // `status` lets callers tell a rejection (400 invalid_grant, 401) from
        // a transient fault without parsing the message.
        finish(new MCPOAuthHttpError(`MCP OAuth ${label} HTTP ${status}`, status));
        return;
      }
      const contentType = response.headers['content-type'] ?? '';
      if (!/^(?:application\/json|[^;]+\+json)(?:;|$)/i.test(contentType)) {
        response.resume();
        finish(new Error('MCP OAuth discovery response must be JSON'));
        return;
      }
      const declaredLength = Number(response.headers['content-length'] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy();
        finish(new Error(`MCP OAuth discovery response exceeds ${maxBytes} bytes`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          finish(new Error(`MCP OAuth discovery response exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => {
        try {
          finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          finish(new Error('MCP OAuth discovery response is not valid JSON'));
        }
      });
      response.once('error', (error) => finish(error));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`MCP OAuth discovery timed out after ${timeoutMs}ms`));
    });
    request.once('error', (error) => finish(error));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    request.end(options.body);
  });
}

export async function resolvePinnedAddress(
  url: URL,
  options: {
    lookup?: BrowserCompatibleDnsLookup | undefined;
    allowedLoopbackHostname?: string | undefined;
  },
): Promise<{ address: string; family: 4 | 6 }> {
  const hostname = unbracket(url.hostname).toLowerCase();
  const literalFamily = net.isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    assertDiscoveryAddressAllowed(
      hostname,
      literalFamily,
      hostname,
      options.allowedLoopbackHostname,
    );
    return { address: hostname, family: literalFamily };
  }
  const lookup = options.lookup ?? ((host) => dns.lookup(host, { all: true }));
  const records = await lookup(hostname);
  if (records.length === 0)
    throw new Error(`MCP OAuth discovery DNS returned no addresses for ${hostname}`);
  for (const record of records) {
    if (record.family !== 4 && record.family !== 6) {
      throw new Error('MCP OAuth discovery DNS returned an unsupported address family');
    }
    assertDiscoveryAddressAllowed(
      record.address,
      record.family,
      hostname,
      options.allowedLoopbackHostname,
    );
  }
  const selected = records[0]!;
  return { address: selected.address, family: selected.family as 4 | 6 };
}

export function assertDiscoveryAddressAllowed(
  address: string,
  family: 4 | 6,
  hostname: string,
  allowedLoopbackHostname: string | undefined,
): void {
  const isPrivate = family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
  if (!isPrivate) return;
  const loopback = family === 4 ? address.startsWith('127.') : address === '::1';
  if (loopback && hostname === allowedLoopbackHostname) return;
  throw new Error(`MCP OAuth discovery blocked private address ${address}`);
}

export function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

export function isLoopbackHttp(url: URL): boolean {
  if (url.protocol !== 'http:') return false;
  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1'
  );
}
