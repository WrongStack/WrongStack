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
import type {
  MCPAuthorizationStateEvent,
  MCPStoredAuthorization,
  MCPVaultTokenStore,
} from './token-store.js';

const DEFAULT_PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING_AUTHORIZATIONS = 32;

type DiscoverAuthorization = (
  resource: string,
  options?: MCPAuthorizationDiscoveryOptions,
) => Promise<MCPAuthorizationDiscoveryResult>;

type ExchangeAuthorizationCode = (options: MCPTokenExchangeOptions) => Promise<MCPTokenSet>;

export interface MCPAuthorizationManagerOptions {
  store: MCPVaultTokenStore;
  pendingTtlMs?: number | undefined;
  discover?: DiscoverAuthorization | undefined;
  exchange?: ExchangeAuthorizationCode | undefined;
  now?: (() => number) | undefined;
  onStateChange?: ((event: MCPAuthorizationStateEvent) => void) | undefined;
}

export interface MCPAuthorizationStartInput {
  serverName: string;
  resource: string;
  clientId: string;
  redirectUri: string;
  scopes?: readonly string[] | undefined;
  challengeHeader?: string | null | undefined;
  signal?: AbortSignal | undefined;
}

export interface MCPAuthorizationStartResult {
  serverName: string;
  resource: string;
  authorizationUrl: string;
  redirectUri: string;
  scopes: string[];
  expiresAt: number;
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
}

/**
 * Surface-neutral manual OAuth coordinator. PKCE verifier/state stay only in
 * this bounded, expiring in-memory map; completed credentials are handed to
 * the host-owned vault store.
 */
export class MCPAuthorizationManager {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly starting = new Map<string, symbol>();
  private readonly pendingTtlMs: number;
  private readonly discover: DiscoverAuthorization;
  private readonly exchange: ExchangeAuthorizationCode;
  private readonly now: () => number;

  constructor(private readonly options: MCPAuthorizationManagerOptions) {
    this.pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    if (!Number.isFinite(this.pendingTtlMs) || this.pendingTtlMs <= 0) {
      throw new Error('MCP authorization pending TTL must be a positive finite number');
    }
    this.discover = options.discover ?? discoverMcpAuthorization;
    this.exchange = options.exchange ?? exchangeMcpAuthorizationCode;
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
      const session = createMcpAuthorizationRequest({
        authorizationServer: discovery.authorizationServer,
        clientId: input.clientId,
        redirectUri: input.redirectUri,
        resource,
        scopes,
      });
      const normalizedScopes =
        new URL(session.authorizationUrl).searchParams.get('scope')?.split(' ').filter(Boolean) ??
        [];
      const expiresAt = this.now() + this.pendingTtlMs;
      this.pending.set(key, { session, discovery, scopes: normalizedScopes, expiresAt });
      return {
        serverName: boundedServerName(input.serverName),
        resource,
        authorizationUrl: session.authorizationUrl,
        redirectUri: session.redirectUri,
        scopes: [...normalizedScopes],
        expiresAt,
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
    const tokenSet = await this.exchange({
      authorizationServer: pending.discovery.authorizationServer,
      clientId: pending.session.clientId,
      redirectUri: pending.session.redirectUri,
      resource,
      code,
      codeVerifier: pending.session.codeVerifier,
      signal: input.signal,
    });
    const stored: MCPStoredAuthorization = {
      serverName,
      resource,
      clientId: pending.session.clientId,
      authorizationServer: pending.discovery.authorizationServer,
      tokenSet,
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.options.store.save(stored);
    this.emit('authorized', stored);
    return statusFromStored(stored, this.now());
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

function authorizationKey(serverName: string, resource: string): string {
  return `${boundedServerName(serverName)}\0${resource}`;
}

function boundedServerName(value: string): string {
  if (!value || value.length > 256 || /[\r\n\0]/.test(value)) {
    throw new Error('MCP authorization server name is invalid');
  }
  return value;
}
