import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as dns from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { isPrivateIPv4, isPrivateIPv6 } from '@wrongstack/core/utils';

export interface MCPAccessToken {
  accessToken: string;
  tokenType?: string | undefined;
  /** Exact canonical MCP resource URI this token was minted for. */
  resource: string;
  expiresAt?: number | undefined;
  scopes?: string[] | undefined;
}

export interface MCPAuthorizationContext {
  serverName: string;
  resource: string;
  signal?: AbortSignal | undefined;
}

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

export interface MCPAuthorizationSession {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  resource: string;
}

export interface MCPTokenSet extends MCPAccessToken {
  refreshToken?: string | undefined;
}

export interface MCPAuthorizationRequestOptions {
  authorizationServer: MCPAuthorizationServerMetadata;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes?: readonly string[] | undefined;
}

export interface MCPTokenExchangeOptions {
  authorizationServer: MCPAuthorizationServerMetadata;
  clientId: string;
  redirectUri: string;
  resource: string;
  code: string;
  codeVerifier: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
  lookup?: BrowserCompatibleDnsLookup | undefined;
}

export interface MCPTokenRefreshOptions {
  authorizationServer: MCPAuthorizationServerMetadata;
  clientId: string;
  resource: string;
  refreshToken: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
  lookup?: BrowserCompatibleDnsLookup | undefined;
}

type BrowserCompatibleDnsLookup = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

/**
 * Host-owned bridge to vault-backed OAuth state. The MCP package never stores
 * access or refresh tokens itself and never exposes them through config.
 */
export interface MCPAuthorizationProvider {
  getAccessToken(context: MCPAuthorizationContext): Promise<MCPAccessToken | undefined>;
  /** Refresh/discover/reauthorize. Return true to retry the HTTP request once. */
  handleUnauthorized?(
    challenge: MCPAuthorizationChallenge,
    context: MCPAuthorizationContext,
  ): Promise<boolean>;
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

export function authorizationHeaderForToken(
  token: MCPAccessToken,
  expectedResource: string,
  now = Date.now(),
): string {
  if (canonicalMcpResource(token.resource) !== expectedResource) {
    throw new Error('MCP access token resource does not match the target server');
  }
  if (token.expiresAt !== undefined && token.expiresAt <= now) {
    throw new Error('MCP access token is expired');
  }
  const tokenType = token.tokenType ?? 'Bearer';
  if (tokenType.toLowerCase() !== 'bearer') {
    throw new Error(`Unsupported MCP OAuth token type "${tokenType}"`);
  }
  if (!token.accessToken || token.accessToken.length > 16_384 || /[\r\n]/.test(token.accessToken)) {
    throw new Error('MCP access token is empty, oversized, or contains invalid characters');
  }
  return `Bearer ${token.accessToken}`;
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
  const bearer = /(?:^|,)\s*Bearer(?:\s+|$)/i.exec(header);
  if (!bearer) return challenge;
  const parameters = header.slice(bearer.index + bearer[0].length);
  const resourceMetadata = challengeParameter(parameters, 'resource_metadata');
  if (resourceMetadata) {
    const metadataUrl = validateMetadataUrl(resourceMetadata);
    if (metadataUrl) challenge.resourceMetadataUrl = metadataUrl;
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
  const suffix = url.pathname === '/' ? '' : url.pathname;
  const candidates = [
    new URL(`/.well-known/oauth-authorization-server${suffix}`, url.origin).toString(),
    new URL(`/.well-known/openid-configuration${suffix}`, url.origin).toString(),
  ];
  if (suffix) {
    candidates.push(
      new URL(
        `${suffix.replace(/\/$/, '')}/.well-known/openid-configuration`,
        url.origin,
      ).toString(),
    );
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
  return {
    issuer,
    authorizationEndpoint: secureOAuthUrl(
      requiredString(metadata['authorization_endpoint'], 'authorization_endpoint'),
      'authorization endpoint',
    ).toString(),
    tokenEndpoint: secureOAuthUrl(
      requiredString(metadata['token_endpoint'], 'token_endpoint'),
      'token endpoint',
    ).toString(),
    registrationEndpoint: registration
      ? secureOAuthUrl(registration, 'registration endpoint').toString()
      : undefined,
    scopesSupported: optionalStringArray(metadata['scopes_supported'], 'scopes_supported', 128),
  };
}

/**
 * Re-validate the normalized authorization-server shape before it is accepted
 * from host-owned persistence. PKCE support is established during discovery;
 * this guard protects the persisted endpoints and bounded fields themselves.
 */
export function validateMcpAuthorizationServerMetadata(
  value: unknown,
): MCPAuthorizationServerMetadata {
  const metadata = record(value, 'stored authorization server metadata');
  const registration = optionalString(metadata['registrationEndpoint'], 'registrationEndpoint');
  return {
    issuer: secureOAuthUrl(requiredString(metadata['issuer'], 'issuer'), 'issuer').toString(),
    authorizationEndpoint: secureOAuthUrl(
      requiredString(metadata['authorizationEndpoint'], 'authorizationEndpoint'),
      'authorization endpoint',
    ).toString(),
    tokenEndpoint: secureOAuthUrl(
      requiredString(metadata['tokenEndpoint'], 'tokenEndpoint'),
      'token endpoint',
    ).toString(),
    registrationEndpoint: registration
      ? secureOAuthUrl(registration, 'registration endpoint').toString()
      : undefined,
    scopesSupported: optionalStringArray(metadata['scopesSupported'], 'scopesSupported', 128),
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

export function createMcpAuthorizationRequest(
  options: MCPAuthorizationRequestOptions,
): MCPAuthorizationSession {
  const resource = canonicalMcpResource(options.resource);
  const clientId = boundedCredential(options.clientId, 'client id');
  const redirectUri = validateRedirectUri(options.redirectUri);
  const scopes = validateScopes(options.scopes ?? []);
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const state = base64Url(randomBytes(32));
  const authorizationUrl = secureOAuthUrl(
    options.authorizationServer.authorizationEndpoint,
    'authorization endpoint',
  );
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', clientId);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('code_challenge', codeChallenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('resource', resource);
  if (scopes.length > 0) authorizationUrl.searchParams.set('scope', scopes.join(' '));
  return {
    authorizationUrl: authorizationUrl.toString(),
    state,
    codeVerifier,
    redirectUri,
    clientId,
    resource,
  };
}

export function parseMcpAuthorizationCallback(
  callbackUrl: string,
  session: Pick<MCPAuthorizationSession, 'redirectUri' | 'state'>,
): string {
  let callback: URL;
  try {
    callback = new URL(callbackUrl);
  } catch {
    throw new Error('MCP OAuth callback must be an absolute URL');
  }
  const expected = new URL(validateRedirectUri(session.redirectUri));
  if (
    callback.protocol !== expected.protocol ||
    callback.hostname !== expected.hostname ||
    callback.port !== expected.port ||
    callback.pathname !== expected.pathname
  ) {
    throw new Error('MCP OAuth callback redirect URI does not match the authorization session');
  }
  const returnedState = callback.searchParams.get('state') ?? '';
  if (!constantTimeEqual(returnedState, session.state)) {
    throw new Error('MCP OAuth callback state mismatch');
  }
  const oauthError = callback.searchParams.get('error');
  if (oauthError)
    throw new Error(`MCP OAuth authorization failed: ${boundedErrorCode(oauthError)}`);
  return boundedCredential(callback.searchParams.get('code') ?? '', 'authorization code');
}

export async function exchangeMcpAuthorizationCode(
  options: MCPTokenExchangeOptions,
): Promise<MCPTokenSet> {
  const resource = canonicalMcpResource(options.resource);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: boundedCredential(options.code, 'authorization code'),
    client_id: boundedCredential(options.clientId, 'client id'),
    redirect_uri: validateRedirectUri(options.redirectUri),
    code_verifier: validateCodeVerifier(options.codeVerifier),
    resource,
  }).toString();
  const response = await requestPinnedJson(options.authorizationServer.tokenEndpoint, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    lookup: options.lookup,
    allowedLoopbackHostname: loopbackHostnameForResource(resource),
  });
  if (response === undefined) throw new Error('MCP OAuth token endpoint returned no response');
  return parseTokenResponse(response, resource);
}

export async function refreshMcpAccessToken(options: MCPTokenRefreshOptions): Promise<MCPTokenSet> {
  const resource = canonicalMcpResource(options.resource);
  const previousRefreshToken = boundedCredential(options.refreshToken, 'refresh token');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: previousRefreshToken,
    client_id: boundedCredential(options.clientId, 'client id'),
    resource,
  }).toString();
  const response = await requestPinnedJson(options.authorizationServer.tokenEndpoint, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    lookup: options.lookup,
    allowedLoopbackHostname: loopbackHostnameForResource(resource),
  });
  if (response === undefined) throw new Error('MCP OAuth token endpoint returned no response');
  const parsed = parseTokenResponse(response, resource);
  return { ...parsed, refreshToken: parsed.refreshToken ?? previousRefreshToken };
}

function challengeParameter(parameters: string, name: string): string | undefined {
  const pattern = new RegExp(
    `(?:^|,)\\s*${name}\\s*=\\s*(?:"((?:\\\\.|[^"\\\\])*)"|([^,\\s]+))`,
    'i',
  );
  const match = pattern.exec(parameters);
  const value = match?.[1] ?? match?.[2];
  return value?.replace(/\\(["\\])/g, '$1');
}

function validateMetadataUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return undefined;
    if (url.protocol !== 'https:' && !isLoopbackHttp(url)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`MCP ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    throw new Error(`MCP authorization field "${field}" must be a bounded non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function boundedStringArray(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`MCP authorization field "${field}" must be an array of at most ${maxItems}`);
  }
  return [...new Set(value.map((entry) => requiredString(entry, field)))];
}

function optionalStringArray(value: unknown, field: string, maxItems: number): string[] {
  return value === undefined ? [] : boundedStringArray(value, field, maxItems);
}

function secureOAuthUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`MCP ${label} must be an absolute URL`);
  }
  if (url.protocol !== 'https:' && !isLoopbackHttp(url)) {
    throw new Error(`MCP ${label} must use HTTPS (except loopback development)`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`MCP ${label} must not contain credentials, query, or fragment components`);
  }
  if (url.pathname === '/') return new URL(url.origin);
  return url;
}

async function discoverFirst<T>(
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
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`MCP ${label} discovery failed (${failures.join('; ')})`);
}

async function requestPinnedJson(
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
  },
): Promise<unknown | undefined> {
  const url = secureOAuthUrl(rawUrl, 'discovery URL');
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
        finish(new Error('MCP OAuth discovery redirects are not allowed'));
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        finish(new Error(`MCP OAuth discovery HTTP ${status}`));
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

async function resolvePinnedAddress(
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

function assertDiscoveryAddressAllowed(
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

function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function validateRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('MCP OAuth redirect URI must be an absolute URL');
  }
  if (url.protocol !== 'https:' && !isLoopbackHttp(url)) {
    throw new Error('MCP OAuth redirect URI must use HTTPS or loopback HTTP');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('MCP OAuth redirect URI must not contain credentials, query, or fragment');
  }
  return url.toString();
}

function validateScopes(scopes: readonly string[]): string[] {
  if (scopes.length > 128) throw new Error('MCP OAuth scope list exceeds 128 entries');
  const normalized = scopes.map((scope) => {
    if (!scope || scope.length > 256 || /\s/.test(scope)) {
      throw new Error('MCP OAuth scopes must be bounded non-empty tokens');
    }
    return scope;
  });
  return [...new Set(normalized)];
}

function validateCodeVerifier(value: string): string {
  if (value.length < 43 || value.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new Error('MCP OAuth PKCE code verifier is invalid');
  }
  return value;
}

function boundedCredential(value: string, label: string): string {
  if (!value || value.length > 16_384 || /[\r\n]/.test(value)) {
    throw new Error(`MCP OAuth ${label} is empty, oversized, or invalid`);
  }
  return value;
}

function boundedErrorCode(value: string): string {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : 'invalid_error';
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function parseTokenResponse(value: unknown, resource: string): MCPTokenSet {
  const response = record(value, 'token response');
  const accessToken = boundedCredential(
    requiredString(response['access_token'], 'access_token'),
    'access token',
  );
  const tokenType = optionalString(response['token_type'], 'token_type') ?? 'Bearer';
  if (tokenType.toLowerCase() !== 'bearer') {
    throw new Error(`Unsupported MCP OAuth token type "${tokenType}"`);
  }
  const expiresIn = response['expires_in'];
  let expiresAt: number | undefined;
  if (expiresIn !== undefined) {
    if (
      typeof expiresIn !== 'number' ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0 ||
      expiresIn > 31_536_000
    ) {
      throw new Error('MCP OAuth expires_in must be between 1 second and 1 year');
    }
    expiresAt = Date.now() + Math.floor(expiresIn * 1_000);
  }
  const refresh = optionalString(response['refresh_token'], 'refresh_token');
  const scope = optionalString(response['scope'], 'scope');
  const token: MCPTokenSet = {
    accessToken,
    tokenType: 'Bearer',
    resource,
    scopes: scope ? validateScopes(scope.split(/\s+/).filter(Boolean)) : [],
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(refresh ? { refreshToken: boundedCredential(refresh, 'refresh token') } : {}),
  };
  authorizationHeaderForToken(token, resource);
  return token;
}

function loopbackHostnameForResource(resource: string): string | undefined {
  const url = new URL(resource);
  return isLoopbackHttp(url) ? unbracket(url.hostname).toLowerCase() : undefined;
}

function isLoopbackHttp(url: URL): boolean {
  if (url.protocol !== 'http:') return false;
  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1'
  );
}
