import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { MCPServerConfig, SecretVault } from '@wrongstack/contracts/types';
import { atomicWrite, withFileLock } from '@wrongstack/core/utils';
import {
  authorizationHeaderForToken,
  canonicalMcpResource,
  type MCPAuthorizationChallenge,
  type MCPAuthorizationContext,
  type MCPAuthorizationProvider,
  type MCPAuthorizationServerMetadata,
  MCPOAuthHttpError,
  type MCPTokenSet,
  refreshMcpAccessToken,
  validateMcpAuthorizationServerMetadata,
} from './authorization.js';

const TOKEN_STORE_VERSION = 1 as const;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 256;
const DEFAULT_REFRESH_SKEW_MS = 60_000;

export interface MCPStoredAuthorization {
  /** Non-secret login generation. Refreshes retain it; a new authorization receives a new ID. */
  grantId?: string | undefined;
  serverName: string;
  resource: string;
  clientId: string;
  /** Present only for a confidential client issued by dynamic registration. */
  clientSecret?: string | undefined;
  authorizationServer: MCPAuthorizationServerMetadata;
  tokenSet: MCPTokenSet;
  updatedAt: string;
}

interface EncryptedAuthorizationEntry {
  grantId?: string | undefined;
  serverName: string;
  resource: string;
  clientId: string;
  /** Vault ciphertext, like the tokens — a client secret is a credential. */
  clientSecret?: string | undefined;
  authorizationServer: MCPAuthorizationServerMetadata;
  accessToken: string;
  refreshToken?: string | undefined;
  tokenType: string;
  expiresAt?: number | undefined;
  scopes: string[];
  updatedAt: string;
}

interface TokenStoreFile {
  version: typeof TOKEN_STORE_VERSION;
  updatedAt: string;
  entries: EncryptedAuthorizationEntry[];
}

export interface MCPAuthorizationStateEvent {
  serverName: string;
  state: 'authorized' | 'refreshed' | 'reauth_required' | 'removed' | 'failed';
  resource: string;
  expiresAt?: number | undefined;
  scopes?: string[] | undefined;
  /** Non-secret reason, set for `failed`. Never contains a token or code. */
  message?: string | undefined;
}

export interface MCPRefreshingAuthorizationProviderOptions {
  serverName: string;
  resource: string;
  store: MCPVaultTokenStore;
  refreshSkewMs?: number | undefined;
  onStateChange?: ((event: MCPAuthorizationStateEvent) => void) | undefined;
}

export interface MCPVaultProviderFactoryOptions {
  store: MCPVaultTokenStore;
  refreshSkewMs?: number | undefined;
  onStateChange?: ((event: MCPAuthorizationStateEvent) => void) | undefined;
}

export class MCPVaultTokenStore {
  constructor(
    private readonly filePath: string,
    private readonly vault: SecretVault,
  ) {}

  async load(serverName: string, resource: string): Promise<MCPStoredAuthorization | undefined> {
    const canonicalResource = canonicalMcpResource(resource);
    return withFileLock(this.filePath, async () => {
      const file = await this.readFile();
      const entry = file.entries.find(
        (candidate) =>
          candidate.serverName === serverName && candidate.resource === canonicalResource,
      );
      const value = entry ? this.decryptEntry(entry) : undefined;
      if (entry && !entry.grantId) {
        entry.grantId = randomUUID();
        await this.writeFile(file.entries);
      }
      return value && entry ? { ...value, grantId: entry.grantId } : undefined;
    });
  }

  async save(value: MCPStoredAuthorization): Promise<void> {
    const normalized = normalizeStoredAuthorization({
      ...value,
      grantId: value.grantId ?? randomUUID(),
    });
    await withFileLock(this.filePath, async () => {
      const file = await this.readFile();
      const next = file.entries.filter(
        (entry) =>
          !(entry.serverName === normalized.serverName && entry.resource === normalized.resource),
      );
      next.push(this.encryptEntry(normalized));
      if (next.length > MAX_ENTRIES)
        throw new Error(`MCP token store exceeds ${MAX_ENTRIES} entries`);
      await this.writeFile(next);
    });
  }

  async remove(serverName: string, resource: string): Promise<boolean> {
    const canonicalResource = canonicalMcpResource(resource);
    return withFileLock(this.filePath, async () => {
      const file = await this.readFile();
      const next = file.entries.filter(
        (entry) => !(entry.serverName === serverName && entry.resource === canonicalResource),
      );
      if (next.length === file.entries.length) return false;
      await this.writeFile(next);
      return true;
    });
  }

  /** Commit a refresh only while the login that requested it still owns the grant. */
  async saveRefreshed(
    value: MCPStoredAuthorization,
    expectedGrantId: string | undefined,
  ): Promise<MCPStoredAuthorization | undefined> {
    const normalized = normalizeStoredAuthorization(value);
    return withFileLock(this.filePath, async () => {
      const file = await this.readFile();
      const index = file.entries.findIndex(
        (entry) =>
          entry.serverName === normalized.serverName && entry.resource === normalized.resource,
      );
      const current = file.entries[index];
      if (!current || current.grantId !== expectedGrantId)
        return current ? this.decryptEntry(current) : undefined;
      file.entries[index] = this.encryptEntry(normalized);
      await this.writeFile(file.entries);
      return normalized;
    });
  }

  private async readFile(): Promise<TokenStoreFile> {
    let raw: string;
    try {
      const stat = await fs.stat(this.filePath);
      if (stat.size > MAX_STORE_BYTES) throw new Error('MCP token store exceeds size limit');
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('MCP token store is not valid JSON');
    }
    return validateStoreFile(parsed);
  }

  private async writeFile(entries: EncryptedAuthorizationEntry[]): Promise<void> {
    const file: TokenStoreFile = {
      version: TOKEN_STORE_VERSION,
      updatedAt: new Date().toISOString(),
      entries,
    };
    await atomicWrite(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }

  private encryptEntry(value: MCPStoredAuthorization): EncryptedAuthorizationEntry {
    const accessToken = this.vault.encrypt(value.tokenSet.accessToken);
    const refreshToken = value.tokenSet.refreshToken
      ? this.vault.encrypt(value.tokenSet.refreshToken)
      : undefined;
    const clientSecret = value.clientSecret ? this.vault.encrypt(value.clientSecret) : undefined;
    if (
      !this.vault.isEncrypted(accessToken) ||
      (refreshToken && !this.vault.isEncrypted(refreshToken)) ||
      (clientSecret && !this.vault.isEncrypted(clientSecret))
    ) {
      throw new Error('MCP token store requires an encrypting SecretVault');
    }
    return {
      grantId: value.grantId,
      serverName: value.serverName,
      resource: value.resource,
      clientId: value.clientId,
      clientSecret,
      authorizationServer: value.authorizationServer,
      accessToken,
      refreshToken,
      tokenType: value.tokenSet.tokenType ?? 'Bearer',
      expiresAt: value.tokenSet.expiresAt,
      scopes: [...(value.tokenSet.scopes ?? [])],
      updatedAt: value.updatedAt,
    };
  }

  private decryptEntry(entry: EncryptedAuthorizationEntry): MCPStoredAuthorization {
    if (
      !this.vault.isEncrypted(entry.accessToken) ||
      (entry.refreshToken !== undefined && !this.vault.isEncrypted(entry.refreshToken)) ||
      (entry.clientSecret !== undefined && !this.vault.isEncrypted(entry.clientSecret))
    ) {
      throw new Error('MCP token store contains an unencrypted token');
    }
    const value: MCPStoredAuthorization = {
      grantId: entry.grantId,
      serverName: entry.serverName,
      resource: entry.resource,
      clientId: entry.clientId,
      ...(entry.clientSecret !== undefined
        ? { clientSecret: this.vault.decrypt(entry.clientSecret) }
        : {}),
      authorizationServer: entry.authorizationServer,
      tokenSet: {
        accessToken: this.vault.decrypt(entry.accessToken),
        refreshToken: entry.refreshToken ? this.vault.decrypt(entry.refreshToken) : undefined,
        tokenType: entry.tokenType,
        resource: entry.resource,
        expiresAt: entry.expiresAt,
        scopes: [...entry.scopes],
      },
      updatedAt: entry.updatedAt,
    };
    return normalizeStoredAuthorization(value);
  }
}

export class MCPRefreshingAuthorizationProvider implements MCPAuthorizationProvider {
  private refreshPromise?: Promise<MCPStoredAuthorization | undefined> | undefined;
  /** Rejected grant revision; a newer authorization may legitimately reuse the same token. */
  private rejectedRefresh?: { fingerprint: string; updatedAt: string } | undefined;
  private readonly resource: string;
  private readonly refreshSkewMs: number;

  constructor(private readonly options: MCPRefreshingAuthorizationProviderOptions) {
    this.resource = canonicalMcpResource(options.resource);
    this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  }

  async getTaskIdentity(): Promise<string> {
    return (
      (await this.options.store.load(this.options.serverName, this.resource))?.grantId ??
      'anonymous'
    );
  }

  async getAccessToken(context: MCPAuthorizationContext): Promise<MCPTokenSet | undefined> {
    this.assertContext(context);
    let state = await this.options.store.load(this.options.serverName, this.resource);
    if (!state) return undefined;
    if (
      state.tokenSet.expiresAt !== undefined &&
      state.tokenSet.expiresAt <= Date.now() + this.refreshSkewMs
    ) {
      state = await this.refresh(state, context.signal);
    }
    if (!state) return undefined;
    if (state.tokenSet.expiresAt !== undefined && state.tokenSet.expiresAt <= Date.now()) {
      this.emit('reauth_required', state);
      return undefined;
    }
    authorizationHeaderForToken(state.tokenSet, this.resource);
    return { ...state.tokenSet, scopes: [...(state.tokenSet.scopes ?? [])] };
  }

  async handleUnauthorized(
    challenge: MCPAuthorizationChallenge,
    context: MCPAuthorizationContext,
  ): Promise<boolean> {
    this.assertContext(context);
    if (challenge.resource !== this.resource) return false;
    const state = await this.options.store.load(this.options.serverName, this.resource);
    if (!state?.tokenSet.refreshToken) {
      if (state) this.emit('reauth_required', state);
      return false;
    }
    return (await this.refresh(state, context.signal)) !== undefined;
  }

  private refresh(
    state: MCPStoredAuthorization,
    signal?: AbortSignal | undefined,
  ): Promise<MCPStoredAuthorization | undefined> {
    if (!this.refreshPromise) {
      const inFlight = this.refreshInner(state).finally(() => {
        this.refreshPromise = undefined;
      });
      // The shared promise must always carry a handler: a caller whose signal
      // is already aborted never attaches one (awaitWithAbort rejects
      // immediately), and a transient refresh failure — the path that
      // deliberately rethrows — would then surface as an unhandled rejection
      // and take the host process down. Real callers still observe the failure
      // through their own awaitWithAbort handlers below.
      void inFlight.catch(() => undefined);
      this.refreshPromise = inFlight;
    }
    return awaitWithAbort(this.refreshPromise, signal);
  }

  private async refreshInner(
    state: MCPStoredAuthorization,
  ): Promise<MCPStoredAuthorization | undefined> {
    const refreshToken = state.tokenSet.refreshToken;
    const rejected = this.rejectedRefresh;
    const sameRejectedGrant =
      refreshToken === rejected?.fingerprint && state.updatedAt === rejected?.updatedAt;
    if (!refreshToken || sameRejectedGrant) {
      // A token the server already rejected is not retried on every request;
      // `reauth_required` was announced when it was rejected.
      if (!refreshToken) this.emit('reauth_required', state);
      return undefined;
    }
    let tokenSet: MCPTokenSet;
    try {
      tokenSet = await refreshMcpAccessToken({
        authorizationServer: state.authorizationServer,
        clientId: state.clientId,
        clientSecret: state.clientSecret,
        resource: state.resource,
        refreshToken,
      });
    } catch (err) {
      // Another WrongStack process may have rotated this refresh token first
      // (rotation invalidates the old one) — its fresh token is in the store.
      const current = await this.options.store
        .load(this.options.serverName, this.resource)
        .catch(() => undefined);
      if (current && current.tokenSet.refreshToken !== refreshToken) return current;
      // A rejection (invalid_grant / revoked client) is permanent until the
      // user re-authorizes. Throwing here failed EVERY request on the server
      // with an opaque HTTP error and never emitted `reauth_required`. A
      // transient fault (network, timeout, 5xx) still throws so the caller
      // can retry.
      if (err instanceof MCPOAuthHttpError && err.status >= 400 && err.status < 500) {
        this.rejectedRefresh = { fingerprint: refreshToken, updatedAt: state.updatedAt };
        this.emit('reauth_required', state);
        return undefined;
      }
      throw err;
    }
    // RFC 6749 §6: a refresh response that omits `scope` keeps the scope
    // originally granted; it arrives here as [] and used to erase it.
    if (!tokenSet.scopes?.length) tokenSet = { ...tokenSet, scopes: state.tokenSet.scopes };
    const next = normalizeStoredAuthorization({
      ...state,
      tokenSet,
      updatedAt: new Date().toISOString(),
    });
    const saved = await this.options.store.saveRefreshed(next, state.grantId);
    if (saved && saved.grantId === state.grantId) this.emit('refreshed', saved);
    return saved;
  }

  private assertContext(context: MCPAuthorizationContext): void {
    if (context.serverName !== this.options.serverName || context.resource !== this.resource) {
      throw new Error('MCP authorization provider context does not match its server/resource');
    }
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

export function createVaultBackedMcpAuthorizationProviderFactory(
  options: MCPVaultProviderFactoryOptions,
): (server: Readonly<MCPServerConfig>) => MCPAuthorizationProvider | undefined {
  const providers = new Map<string, MCPRefreshingAuthorizationProvider>();
  return (server) => {
    if (server.transport === 'stdio' || !server.url) return undefined;
    const resource = canonicalMcpResource(server.url);
    const key = `${server.name}\0${resource}`;
    let provider = providers.get(key);
    if (!provider) {
      provider = new MCPRefreshingAuthorizationProvider({
        serverName: server.name,
        resource,
        store: options.store,
        refreshSkewMs: options.refreshSkewMs,
        onStateChange: options.onStateChange,
      });
      providers.set(key, provider);
    }
    return provider;
  };
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('MCP token refresh aborted');
}

function emptyFile(): TokenStoreFile {
  return { version: TOKEN_STORE_VERSION, updatedAt: new Date(0).toISOString(), entries: [] };
}

function validateStoreFile(value: unknown): TokenStoreFile {
  if (
    !isRecord(value) ||
    value['version'] !== TOKEN_STORE_VERSION ||
    !Array.isArray(value['entries'])
  ) {
    throw new Error('MCP token store has an unsupported or malformed structure');
  }
  if (value['entries'].length > MAX_ENTRIES)
    throw new Error('MCP token store has too many entries');
  return {
    version: TOKEN_STORE_VERSION,
    updatedAt: boundedString(value['updatedAt'], 'updatedAt', 128),
    entries: value['entries'].map(validateEncryptedEntry),
  };
}

function validateEncryptedEntry(value: unknown): EncryptedAuthorizationEntry {
  if (!isRecord(value)) throw new Error('MCP token store entry must be an object');
  const resource = canonicalMcpResource(boundedString(value['resource'], 'resource', 4_096));
  const authorizationServer = validateMcpAuthorizationServerMetadata(value['authorizationServer']);
  const scopes = stringArray(value['scopes'], 'scopes', 128);
  const expiresAt = value['expiresAt'];
  if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) {
    throw new Error('MCP token store expiresAt must be a finite number');
  }
  return {
    ...(value['grantId'] === undefined
      ? {}
      : { grantId: boundedString(value['grantId'], 'grantId', 128) }),
    serverName: boundedString(value['serverName'], 'serverName', 256),
    resource,
    clientId: boundedString(value['clientId'], 'clientId', 4_096),
    clientSecret:
      value['clientSecret'] === undefined
        ? undefined
        : boundedString(value['clientSecret'], 'clientSecret', 32_768),
    authorizationServer,
    accessToken: boundedString(value['accessToken'], 'accessToken', 32_768),
    refreshToken:
      value['refreshToken'] === undefined
        ? undefined
        : boundedString(value['refreshToken'], 'refreshToken', 32_768),
    tokenType: boundedString(value['tokenType'], 'tokenType', 64),
    expiresAt: expiresAt as number | undefined,
    scopes,
    updatedAt: boundedString(value['updatedAt'], 'updatedAt', 128),
  };
}

function normalizeStoredAuthorization(value: MCPStoredAuthorization): MCPStoredAuthorization {
  if (
    value.tokenSet.expiresAt !== undefined &&
    (typeof value.tokenSet.expiresAt !== 'number' || !Number.isFinite(value.tokenSet.expiresAt))
  ) {
    throw new Error('MCP token store expiresAt must be a finite number');
  }
  const serverName = boundedString(value.serverName, 'serverName', 256);
  const resource = canonicalMcpResource(value.resource);
  const authorizationServer = validateMcpAuthorizationServerMetadata(value.authorizationServer);
  if (canonicalMcpResource(value.tokenSet.resource) !== resource) {
    throw new Error('MCP token resource mismatch');
  }
  const tokenSet: MCPTokenSet = {
    ...value.tokenSet,
    resource,
    scopes: stringArray(value.tokenSet.scopes ?? [], 'scopes', 128),
  };
  authorizationHeaderForToken({ ...tokenSet, expiresAt: undefined }, resource);
  return {
    ...(value.grantId === undefined
      ? {}
      : { grantId: boundedString(value.grantId, 'grantId', 128) }),
    serverName,
    resource,
    clientId: boundedString(value.clientId, 'clientId', 4_096),
    ...(value.clientSecret
      ? { clientSecret: boundedString(value.clientSecret, 'clientSecret', 4_096) }
      : {}),
    authorizationServer,
    tokenSet,
    updatedAt: boundedString(value.updatedAt, 'updatedAt', 128),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\r\n]/.test(value)
  ) {
    throw new Error(`MCP token store field "${field}" is invalid`);
  }
  return value;
}

function stringArray(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`MCP token store field "${field}" must be a bounded array`);
  }
  return [...new Set(value.map((entry) => boundedString(entry, field, 256)))];
}
