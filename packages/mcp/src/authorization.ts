import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type BrowserCompatibleDnsLookup,
  canonicalMcpResource,
  isLoopbackHttp,
  type MCPAuthorizationChallenge,
  type MCPAuthorizationServerMetadata,
  optionalBoolean,
  optionalString,
  optionalStringArray,
  record,
  requestPinnedJson,
  requiredString,
  secureOAuthUrl,
  unbracket,
} from './authorization-discovery.js';

export {
  authorizationServerMetadataUrls,
  canonicalMcpResource,
  discoverMcpAuthorization,
  type MCPAuthorizationChallenge,
  type MCPAuthorizationDiscoveryOptions,
  type MCPAuthorizationDiscoveryResult,
  type MCPAuthorizationJsonFetcher,
  type MCPAuthorizationServerMetadata,
  MCPOAuthHttpError,
  type MCPProtectedResourceMetadata,
  parseAuthorizationServerMetadata,
  parseMcpBearerChallenge,
  parseProtectedResourceMetadata,
  protectedResourceMetadataUrls,
} from './authorization-discovery.js';

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

export interface MCPAuthorizationSession {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  resource: string;
  issuer: string;
  requireIssuerParameter: boolean;
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
  /** Only set when dynamic registration issued a confidential client. */
  clientSecret?: string | undefined;
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
  /** Only set when dynamic registration issued a confidential client. */
  clientSecret?: string | undefined;
  resource: string;
  refreshToken: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
  lookup?: BrowserCompatibleDnsLookup | undefined;
}

/**
 * Host-owned bridge to vault-backed OAuth state. The MCP package never stores
 * access or refresh tokens itself and never exposes them through config.
 */
export interface MCPAuthorizationProvider {
  getAccessToken(context: MCPAuthorizationContext): Promise<MCPAccessToken | undefined>;
  /** Stable authorization-grant identity for durable task binding; changes on a new login. */
  getTaskIdentity?(): Promise<string | undefined>;
  /** Refresh/discover/reauthorize. Return true to retry the HTTP request once. */
  handleUnauthorized?(
    challenge: MCPAuthorizationChallenge,
    context: MCPAuthorizationContext,
  ): Promise<boolean>;
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
  const issuer = secureOAuthUrl(requiredString(metadata['issuer'], 'issuer'), 'issuer').toString();
  const authorizationEndpoint = secureOAuthUrl(
    requiredString(metadata['authorizationEndpoint'], 'authorizationEndpoint'),
    'authorization endpoint',
  ).toString();
  const tokenEndpoint = secureOAuthUrl(
    requiredString(metadata['tokenEndpoint'], 'tokenEndpoint'),
    'token endpoint',
  ).toString();
  const issuerParameterSupported = optionalBoolean(
    metadata['authorizationResponseIssuerParameterSupported'],
    'authorizationResponseIssuerParameterSupported',
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
    scopesSupported: optionalStringArray(metadata['scopesSupported'], 'scopesSupported', 128),
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
    issuer: options.authorizationServer.issuer,
    requireIssuerParameter:
      options.authorizationServer.authorizationResponseIssuerParameterSupported === true,
  };
}

export function parseMcpAuthorizationCallback(
  callbackUrl: string,
  session: Pick<
    MCPAuthorizationSession,
    'redirectUri' | 'state' | 'issuer' | 'requireIssuerParameter'
  >,
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
  const returnedStates = callback.searchParams.getAll('state');
  if (returnedStates.length !== 1) {
    throw new Error('MCP OAuth callback must contain exactly one state parameter');
  }
  const returnedState = returnedStates[0]!;
  if (!constantTimeEqual(returnedState, session.state)) {
    throw new Error('MCP OAuth callback state mismatch');
  }
  const returnedIssuers = callback.searchParams.getAll('iss');
  if (session.requireIssuerParameter && returnedIssuers.length !== 1) {
    throw new Error('MCP OAuth callback must contain exactly one issuer parameter');
  }
  if (returnedIssuers.length > 0 && returnedIssuers.some((issuer) => issuer !== session.issuer)) {
    throw new Error('MCP OAuth callback issuer mismatch');
  }
  const oauthErrors = callback.searchParams.getAll('error');
  const codes = callback.searchParams.getAll('code');
  if (
    oauthErrors.length > 1 ||
    codes.length > 1 ||
    (oauthErrors.length === 1 && codes.length > 0)
  ) {
    throw new Error('MCP OAuth callback contains ambiguous response parameters');
  }
  if (oauthErrors.length === 1) {
    throw new Error(`MCP OAuth authorization failed: ${boundedErrorCode(oauthErrors[0]!)}`);
  }
  if (codes.length !== 1) {
    throw new Error('MCP OAuth callback must contain exactly one authorization code');
  }
  return boundedCredential(codes[0]!, 'authorization code');
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
    ...(options.clientSecret
      ? { client_secret: boundedCredential(options.clientSecret, 'client secret') }
      : {}),
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
    label: 'token endpoint',
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
    ...(options.clientSecret
      ? { client_secret: boundedCredential(options.clientSecret, 'client secret') }
      : {}),
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
    label: 'token endpoint',
  });
  if (response === undefined) throw new Error('MCP OAuth token endpoint returned no response');
  const parsed = parseTokenResponse(response, resource);
  return { ...parsed, refreshToken: parsed.refreshToken ?? previousRefreshToken };
}

/**
 * Normalize a redirect URI to the exact spelling the authorization request and
 * the token exchange send. Callers that also hand the URI to another party
 * (dynamic client registration) MUST use this form for both: OAuth compares
 * redirect URIs as exact strings, and `new URL()` canonicalizes (adds the "/"
 * path, lowercases the host, drops a default port).
 */
export function validateRedirectUri(value: string): string {
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
  if (expiresIn !== undefined && expiresIn !== null) {
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
