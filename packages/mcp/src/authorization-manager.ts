import {
  canonicalMcpResource,
  createMcpAuthorizationRequest,
  discoverMcpAuthorization,
  exchangeMcpAuthorizationCode,
  type MCPAuthorizationDiscoveryOptions,
  type MCPAuthorizationDiscoveryResult,
  type MCPAuthorizationSession,
  type MCPTokenExchangeOptions,
  type MCPTokenSet,
  parseMcpAuthorizationCallback,
  parseMcpBearerChallenge,
} from './authorization.js';
import {
  type MCPOAuthCallbackServerOptions,
  startMcpOAuthCallbackServer,
} from './authorization-callback-server.js';
import { secureOAuthUrl } from './authorization-discovery.js';
import {
  type MCPClientRegistration,
  type MCPClientRegistrationOptions,
  registerMcpOAuthClient,
} from './authorization-registration.js';
import type {
  MCPAuthorizationStateEvent,
  MCPStoredAuthorization,
  MCPVaultTokenStore,
} from './token-store.js';

const DEFAULT_PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING_AUTHORIZATIONS = 32;
const MAX_CACHED_REGISTRATIONS = 32;

type DiscoverAuthorization = (
  resource: string,
  options?: MCPAuthorizationDiscoveryOptions,
) => Promise<MCPAuthorizationDiscoveryResult>;

type ExchangeAuthorizationCode = (options: MCPTokenExchangeOptions) => Promise<MCPTokenSet>;

type RegisterClient = (options: MCPClientRegistrationOptions) => Promise<MCPClientRegistration>;

export interface MCPAuthorizationManagerOptions {
  store: MCPVaultTokenStore;
  pendingTtlMs?: number | undefined;
  discover?: DiscoverAuthorization | undefined;
  exchange?: ExchangeAuthorizationCode | undefined;
  register?: RegisterClient | undefined;
  /** `client_name` sent during dynamic registration. */
  clientName?: string | undefined;
  now?: (() => number) | undefined;
  onStateChange?: ((event: MCPAuthorizationStateEvent) => void) | undefined;
}

export interface MCPAuthorizationStartInput {
  serverName: string;
  resource: string;
  /** Omit to reuse a stored identity or dynamically register one (RFC 7591). */
  clientId?: string | undefined;
  redirectUri: string;
  scopes?: readonly string[] | undefined;
  challengeHeader?: string | null | undefined;
  signal?: AbortSignal | undefined;
}

export interface MCPAuthorizationLoginInput {
  serverName: string;
  resource: string;
  clientId?: string | undefined;
  scopes?: readonly string[] | undefined;
  challengeHeader?: string | null | undefined;
  signal?: AbortSignal | undefined;
  /** Fixed loopback port, when the server only accepts a preregistered URI. */
  port?: number | undefined;
  /** How long to wait for the browser redirect. */
  timeoutMs?: number | undefined;
}

export interface MCPAuthorizationLoginHandle {
  /** Available immediately: show this to the user. */
  started: MCPAuthorizationStartResult;
  /** Settles when the browser redirect arrives and the code is exchanged. */
  completion: Promise<MCPAuthorizationStatus>;
  /** Abandon the flow and release the loopback port. */
  cancel(): void;
}

export interface MCPAuthorizationStartResult {
  serverName: string;
  resource: string;
  authorizationUrl: string;
  redirectUri: string;
  scopes: string[];
  expiresAt: number;
  /** How the client identity was obtained, for surfacing in status output. */
  clientIdSource: 'explicit' | 'stored' | 'registered';
}

export interface MCPAuthorizationCompleteInput {
  serverName: string;
  resource: string;
  callbackUrl: string;
  signal?: AbortSignal | undefined;
}

export interface MCPAuthorizationStatus {
  serverName: string;
  resource: string;
  state: 'not_authorized' | 'pending' | 'authorized' | 'expired';
  expiresAt?: number | undefined;
  scopes: string[];
  canRefresh: boolean;
}

interface PendingAuthorization {
  session: MCPAuthorizationSession;
  discovery: MCPAuthorizationDiscoveryResult;
  scopes: string[];
  expiresAt: number;
  clientSecret?: string | undefined;
}

interface ClientIdentity {
  clientId: string;
  clientSecret?: string | undefined;
  source: 'explicit' | 'stored' | 'registered';
}

/**
 * Surface-neutral manual OAuth coordinator. PKCE verifier/state stay only in
 * this bounded, expiring in-memory map; completed credentials are handed to
 * the host-owned vault store.
 */
export class MCPAuthorizationManager {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly starting = new Map<string, symbol>();
  private readonly completing = new Map<string, symbol>();
  /** Registrations reused across servers that share one authorization server. */
  private readonly registrations = new Map<string, MCPClientRegistration>();
  private readonly pendingTtlMs: number;
  private readonly discover: DiscoverAuthorization;
  private readonly exchange: ExchangeAuthorizationCode;
  private readonly register: RegisterClient;
  private readonly now: () => number;

  constructor(private readonly options: MCPAuthorizationManagerOptions) {
    this.pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    if (!Number.isFinite(this.pendingTtlMs) || this.pendingTtlMs <= 0) {
      throw new Error('MCP authorization pending TTL must be a positive finite number');
    }
    this.discover = options.discover ?? discoverMcpAuthorization;
    this.exchange = options.exchange ?? exchangeMcpAuthorizationCode;
    this.register = options.register ?? registerMcpOAuthClient;
    this.now = options.now ?? Date.now;
  }

  async begin(input: MCPAuthorizationStartInput): Promise<MCPAuthorizationStartResult> {
    const resource = canonicalMcpResource(input.resource);
    const key = authorizationKey(input.serverName, resource);
    this.pruneExpired();
    if (this.starting.has(key)) {
      throw new Error('MCP authorization discovery is already in progress for this server');
    }
    if (!this.pending.has(key) && this.activeAuthorizationCount() >= MAX_PENDING_AUTHORIZATIONS) {
      throw new Error('Too many pending MCP authorization sessions');
    }
    const attempt = Symbol(key);
    this.starting.set(key, attempt);
    try {
      const discovery = await this.discover(resource, {
        challengeHeader: input.challengeHeader,
        signal: input.signal,
      });
      if (this.starting.get(key) !== attempt) {
        throw new Error('MCP authorization discovery was cancelled');
      }
      const challengeScopes = parseMcpBearerChallenge(
        input.challengeHeader ?? null,
        resource,
      ).scopes;
      const scopes = input.scopes ? [...input.scopes] : challengeScopes;
      const identity = await this.resolveClientIdentity({
        serverName: input.serverName,
        resource,
        discovery,
        redirectUri: input.redirectUri,
        explicitClientId: input.clientId,
        scopes,
        signal: input.signal,
      });
      if (this.starting.get(key) !== attempt) {
        throw new Error('MCP authorization discovery was cancelled');
      }
      const session = createMcpAuthorizationRequest({
        authorizationServer: discovery.authorizationServer,
        clientId: identity.clientId,
        redirectUri: input.redirectUri,
        resource,
        scopes,
      });
      const normalizedScopes =
        new URL(session.authorizationUrl).searchParams.get('scope')?.split(' ').filter(Boolean) ??
        [];
      const expiresAt = this.now() + this.pendingTtlMs;
      this.pending.set(key, {
        session,
        discovery,
        scopes: normalizedScopes,
        expiresAt,
        clientSecret: identity.clientSecret,
      });
      return {
        serverName: boundedServerName(input.serverName),
        resource,
        authorizationUrl: session.authorizationUrl,
        redirectUri: session.redirectUri,
        scopes: [...normalizedScopes],
        expiresAt,
        clientIdSource: identity.source,
      };
    } finally {
      if (this.starting.get(key) === attempt) this.starting.delete(key);
    }
  }

  async complete(input: MCPAuthorizationCompleteInput): Promise<MCPAuthorizationStatus> {
    const serverName = boundedServerName(input.serverName);
    const resource = canonicalMcpResource(input.resource);
    const key = authorizationKey(serverName, resource);
    this.pruneExpired();
    const pending = this.pending.get(key);
    if (!pending) {
      throw new Error('No live MCP authorization session exists for this server');
    }
    const code = parseMcpAuthorizationCallback(input.callbackUrl, pending.session);
    // Authorization codes and PKCE verifiers are one-shot. Remove before the
    // network exchange so retries cannot accidentally replay either value.
    this.pending.delete(key);
    const attempt = Symbol(key);
    this.completing.set(key, attempt);
    try {
      const tokenSet = await this.exchange({
        authorizationServer: pending.discovery.authorizationServer,
        clientId: pending.session.clientId,
        clientSecret: pending.clientSecret,
        redirectUri: pending.session.redirectUri,
        resource,
        code,
        codeVerifier: pending.session.codeVerifier,
        signal: input.signal,
      });
      if (this.completing.get(key) !== attempt) {
        throw new Error('MCP authorization completion was cancelled');
      }
      const stored: MCPStoredAuthorization = {
        serverName,
        resource,
        clientId: pending.session.clientId,
        ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
        authorizationServer: pending.discovery.authorizationServer,
        tokenSet,
        updatedAt: new Date(this.now()).toISOString(),
      };
      await this.options.store.save(stored);
      if (this.completing.get(key) !== attempt) {
        await this.options.store.remove(serverName, resource).catch(() => false);
        throw new Error('MCP authorization completion was cancelled');
      }
      this.emit('authorized', stored);
      return statusFromStored(stored, this.now());
    } finally {
      if (this.completing.get(key) === attempt) this.completing.delete(key);
    }
  }

  /**
   * Bind a loopback receiver and start the flow, returning as soon as the URL
   * exists so a surface can show it without blocking. Completion is awaited
   * separately — a slash command returns its message immediately and reports
   * the outcome through `onStateChange`. The two-step `begin`/`complete` pair
   * stays for surfaces that cannot host a listener.
   */
  async beginLogin(input: MCPAuthorizationLoginInput): Promise<MCPAuthorizationLoginHandle> {
    const callbackOptions: MCPOAuthCallbackServerOptions = {
      port: input.port,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    };
    const listener = await startMcpOAuthCallbackServer(callbackOptions);
    let started: MCPAuthorizationStartResult;
    try {
      started = await this.begin({
        serverName: input.serverName,
        resource: input.resource,
        clientId: input.clientId,
        redirectUri: listener.redirectUri,
        scopes: input.scopes,
        challengeHeader: input.challengeHeader,
        signal: input.signal,
      });
    } catch (error) {
      listener.close();
      throw error;
    }
    const key = authorizationKey(started.serverName, started.resource);
    const createdSession = this.pending.get(key)?.session;
    const clearOwnedPending = () => {
      if (createdSession && this.pending.get(key)?.session === createdSession) {
        this.pending.delete(key);
      }
    };
    const completion = listener
      .waitForCallback()
      .then((callbackUrl) =>
        this.complete({
          serverName: input.serverName,
          resource: input.resource,
          callbackUrl,
          signal: input.signal,
        }),
      )
      .finally(() => {
        clearOwnedPending();
        listener.close();
      });
    return {
      started,
      completion,
      cancel: () => {
        clearOwnedPending();
        this.completing.delete(key);
        listener.close();
      },
    };
  }

  /**
   * Identity precedence: an explicit id, then the one already stored for this
   * server (so re-authorizing does not orphan a registration), then the
   * per-issuer cache, then a fresh dynamic registration.
   */
  private async resolveClientIdentity(input: {
    serverName: string;
    resource: string;
    discovery: MCPAuthorizationDiscoveryResult;
    redirectUri: string;
    explicitClientId?: string | undefined;
    scopes: readonly string[];
    signal?: AbortSignal | undefined;
  }): Promise<ClientIdentity> {
    if (input.explicitClientId) {
      return { clientId: input.explicitClientId, source: 'explicit' };
    }
    // Compare issuers as URLs, not strings: an origin-only issuer round-trips
    // through the store as "https://host/" but may arrive here as
    // "https://host", and a raw mismatch silently re-registered every time.
    const issuer = normalizeIssuer(input.discovery.authorizationServer.issuer);
    const stored = await this.options.store
      .load(boundedServerName(input.serverName), input.resource)
      .catch(() => undefined);
    // Only reuse it when the authorization server is still the same one: a
    // client id is scoped to its issuer and means nothing to another.
    if (stored && normalizeIssuer(stored.authorizationServer.issuer) === issuer) {
      return {
        clientId: stored.clientId,
        clientSecret: stored.clientSecret,
        source: 'stored',
      };
    }
    // RFC 8252 §7.3 requires an authorization server to accept any port on a
    // loopback redirect, but not every one does. Keying the cache on the exact
    // redirect URI means a different ephemeral port re-registers instead of
    // replaying an identity the server may reject.
    const registrationKey = `${issuer} ${input.redirectUri}`;
    const cached = this.registrations.get(registrationKey);
    if (cached) {
      return { clientId: cached.clientId, clientSecret: cached.clientSecret, source: 'registered' };
    }
    const registration = await this.register({
      authorizationServer: input.discovery.authorizationServer,
      redirectUris: [input.redirectUri],
      clientName: this.options.clientName,
      scopes: input.scopes,
      resource: input.resource,
      signal: input.signal,
    });
    if (this.registrations.size >= MAX_CACHED_REGISTRATIONS) {
      const oldest = this.registrations.keys().next();
      if (!oldest.done) this.registrations.delete(oldest.value);
    }
    this.registrations.set(registrationKey, registration);
    return {
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      source: 'registered',
    };
  }

  async status(serverName: string, resource: string): Promise<MCPAuthorizationStatus> {
    const normalizedName = boundedServerName(serverName);
    const normalizedResource = canonicalMcpResource(resource);
    this.pruneExpired();
    const pending = this.pending.get(authorizationKey(normalizedName, normalizedResource));
    if (pending) {
      return {
        serverName: normalizedName,
        resource: normalizedResource,
        state: 'pending',
        expiresAt: pending.expiresAt,
        scopes: [...pending.scopes],
        canRefresh: false,
      };
    }
    const stored = await this.options.store.load(normalizedName, normalizedResource);
    return stored
      ? statusFromStored(stored, this.now())
      : {
          serverName: normalizedName,
          resource: normalizedResource,
          state: 'not_authorized',
          scopes: [],
          canRefresh: false,
        };
  }

  async disconnect(serverName: string, resource: string): Promise<boolean> {
    const normalizedName = boundedServerName(serverName);
    const normalizedResource = canonicalMcpResource(resource);
    const key = authorizationKey(normalizedName, normalizedResource);
    this.starting.delete(key);
    this.pending.delete(key);
    this.completing.delete(key);
    const removed = await this.options.store.remove(normalizedName, normalizedResource);
    if (removed) {
      this.options.onStateChange?.({
        serverName: normalizedName,
        state: 'removed',
        resource: normalizedResource,
      });
    }
    return removed;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, value] of this.pending) {
      if (value.expiresAt <= now) this.pending.delete(key);
    }
  }

  private activeAuthorizationCount(): number {
    let count = this.pending.size;
    for (const key of this.starting.keys()) {
      if (!this.pending.has(key)) count++;
    }
    return count;
  }

  private emit(state: MCPAuthorizationStateEvent['state'], value: MCPStoredAuthorization): void {
    this.options.onStateChange?.({
      serverName: value.serverName,
      state,
      resource: value.resource,
      expiresAt: value.tokenSet.expiresAt,
      scopes: [...(value.tokenSet.scopes ?? [])],
    });
  }
}

function statusFromStored(value: MCPStoredAuthorization, now: number): MCPAuthorizationStatus {
  return {
    serverName: value.serverName,
    resource: value.resource,
    state:
      value.tokenSet.expiresAt !== undefined && value.tokenSet.expiresAt <= now
        ? 'expired'
        : 'authorized',
    expiresAt: value.tokenSet.expiresAt,
    scopes: [...(value.tokenSet.scopes ?? [])],
    canRefresh: !!value.tokenSet.refreshToken,
  };
}

function normalizeIssuer(value: string): string {
  return secureOAuthUrl(value, 'authorization server issuer').toString();
}

function authorizationKey(serverName: string, resource: string): string {
  return `${boundedServerName(serverName)}\0${resource}`;
}

function boundedServerName(value: string): string {
  if (!value || value.length > 256 || /[\r\n\0]/.test(value)) {
    throw new Error('MCP authorization server name is invalid');
  }
  return value;
}
