import * as https from 'node:https';
import { ConfigError } from '@wrongstack/core/types';
import type { HttpDispatcher } from '@wrongstack/core/utils';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import {
  authorizationHeaderForToken,
  canonicalMcpResource,
  type MCPAuthorizationProvider,
  parseMcpBearerChallenge,
} from './authorization.js';
import type { ConnectionState, MCPTool } from './contracts.js';
import type { MCPServerMetadata } from './protocol.js';
import {
  ALLOW_MCP_PRIVATE_NETWORKS,
  isTlsUnsafeAllowed,
  type TransportDnsLookup,
  transportPinnedLookup,
  validateTransportUrl,
} from './transport-security.js';

/** Redirect hops an MCP HTTP transport will follow, each revalidated (WS-085). */
const MAX_TRANSPORT_REDIRECTS = 5;

// Node's bundled global fetch rejects a dispatcher created by the workspace's
// `undici` package (different ABI: "invalid onRequestStart method"), so the
// pinned Agent must be paired with the package's own fetch — mirroring
// tools/_fetch-guard.ts. Test/user shims that replaced globalThis.fetch are
// honored as-is.
const nativeGlobalFetch = globalThis.fetch;

// Every transport's pinned Agent registers here so long-running processes
// (MCP server mode, eternal autonomy) tear their connection pools down on
// exit instead of leaking sockets.
const pinnedAgents = new Set<UndiciAgent>();
let pinnedAgentsCleanupRegistered = false;
/* v8 ignore next 6 -- process 'beforeExit' cleanup; not deterministically triggerable in-test. */
if (!pinnedAgentsCleanupRegistered) {
  pinnedAgentsCleanupRegistered = true;
  process.on('beforeExit', () => {
    for (const agent of pinnedAgents) agent.destroy();
    pinnedAgents.clear();
  });
}

export interface HttpTransportOptions {
  name: string;
  url: string;
  headers?: Record<string, string> | undefined;
  startupTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  authorizationProvider?: MCPAuthorizationProvider | undefined;
  /**
   * Per-request TLS configuration. When set, an https.Agent is created
   * and passed to fetch via the `dispatch` option. This avoids globally
   * disabling certificate validation (NODE_TLS_REJECT_UNAUTHORIZED) which
   * would affect all provider API calls in the same process.
   *
   * ⚠️ Security gate: `rejectUnauthorized: false` REQUIRES
   * `WRONGSTACK_UNSAFE_MCP_TLS=1` as an explicit opt-in.
   *
   * Without this gate, an active network attacker between the client and the
   * MCP server can read and modify tool calls and responses. Only use this
   * for local development with self-signed certificates; production MCP
   * servers must present a valid certificate.
   */
  tls?: { ca?: string | undefined; rejectUnauthorized?: boolean | undefined };
  /**
   * Resolution-bound private-network policy. Default: the transport resolves
   * the configured hostname itself and refuses dial-time addresses outside
   * the public internet — link-local/IMDS always, other private/LAN ranges
   * unless this flag is set. The configured hostname is still used for the
   * Host header and TLS SNI, so certificate validation is unaffected, and
   * plaintext http:// remains loopback-only (validateTransportUrl).
   */
  allowPrivateNetworks?: boolean | undefined;
  /**
   * DNS seam for tests and hosts with custom resolvers. Production callers
   * omit it: dns.lookup(hostname, { all: true }) runs and every returned
   * record is policy-checked before the dial.
   */
  lookup?: TransportDnsLookup | undefined;
}

/**
 * Abort error whose `name` is `'AbortError'` so the core executor's
 * classifyToolError maps it to FATAL / not-retryable (user cancellation).
 */
export function makeAbortError(method: string): Error {
  const err = new Error(`MCP request "${method}" aborted by client`);
  err.name = 'AbortError';
  return err;
}

export function createTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(parent?.reason);
  if (parent?.aborted) {
    ctrl.abort(parent.reason);
  } else {
    parent?.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(
    () => ctrl.abort(new Error(`MCP HTTP request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  timer.unref?.();
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

// ---------------------------------------------------------------------------
// Shared base class — consolidates all duplicated fields, constructor logic,
// and private helpers that are identical between SSETransport and
// StreamableHTTPTransport.
// ---------------------------------------------------------------------------

/**
 * Fields and methods shared by all HTTP-based MCP transports.
 * Subclasses override `connect()`, `close()`, `callTool()`, `request()`.
 */
export abstract class BaseHTTPTransport {
  protected state: ConnectionState = 'idle';
  protected readonly url: string;
  protected readonly headers: Record<string, string>;
  protected readonly timeout: number;
  protected readonly requestTimeout: number;
  protected readonly name: string;
  protected readonly authorizationProvider?: MCPAuthorizationProvider | undefined;
  protected readonly authorizationResource: string;
  /** Per-request TLS agent — created once from HttpTransportOptions.tls */
  protected readonly tlsAgent?: https.Agent | undefined;
  private readonly tlsOptions: HttpTransportOptions['tls'];
  private readonly allowPrivateNetworks: boolean;
  private readonly lookup: TransportDnsLookup | undefined;
  private pinnedAgent: UndiciAgent | undefined;
  protected readonly tools: MCPTool[] = [];
  protected serverMetadata?: MCPServerMetadata | undefined;
  protected abortController?: AbortController | undefined;
  protected readonly disconnectHandlers: Array<() => void> = [];
  protected readonly toolsChangedListeners = new Set<(tools: MCPTool[]) => void>();
  protected readonly resourcesChangedListeners = new Set<() => void>();
  protected readonly promptsChangedListeners = new Set<() => void>();
  protected protocolVersion?: string | undefined;

  constructor(opts: HttpTransportOptions, transportName: string) {
    validateTransportUrl(opts.url);
    this.name = opts.name;
    this.url = opts.url;
    this.headers = { ...opts.headers };
    this.authorizationProvider = opts.authorizationProvider;
    this.authorizationResource = canonicalMcpResource(opts.url);
    this.timeout = opts.startupTimeoutMs ?? 10_000;
    this.requestTimeout = opts.requestTimeoutMs ?? 60_000;
    if (opts.tls) {
      if (opts.tls.rejectUnauthorized === false) {
        if (!isTlsUnsafeAllowed()) {
          throw new ConfigError({
            message:
              `[mcp:${transportName}] TLS verification disabled — set WRONGSTACK_UNSAFE_MCP_TLS=1 ` +
              `to allow. Rejecting insecure configuration for ${this.url}.`,
            code: 'CONFIG_INVALID',
            context: { field: 'tls.rejectUnauthorized', transportName, url: this.url },
          });
        }
        console.error(
          `[mcp:${transportName}] ⚠️ TLS verification DISABLED for ${this.url}. ` +
            `Network attacks are possible — only use on localhost.`,
        );
      }
      this.tlsAgent = new https.Agent({
        ca: opts.tls.ca,
        rejectUnauthorized: opts.tls.rejectUnauthorized,
      });
    }
    this.tlsOptions = opts.tls;
    this.allowPrivateNetworks = opts.allowPrivateNetworks === true || ALLOW_MCP_PRIVATE_NETWORKS;
    this.lookup = opts.lookup;
  }

  getState(): ConnectionState {
    return this.state;
  }

  protected async fetchWithAuthorization(
    input: string | URL,
    init: RequestInit,
    signal?: AbortSignal | undefined,
  ): Promise<Response> {
    const context = {
      serverName: this.name,
      resource: this.authorizationResource,
      signal,
    };
    const send = async (): Promise<Response> => {
      signal?.throwIfAborted();
      const headers = new Headers(init.headers);
      if (this.protocolVersion) headers.set('MCP-Protocol-Version', this.protocolVersion);
      const token = await this.authorizationProvider?.getAccessToken(context);
      signal?.throwIfAborted();
      if (token) {
        headers.set(
          'Authorization',
          authorizationHeaderForToken(token, this.authorizationResource),
        );
      }
      // `validateTransportUrl` runs once, in the constructor. With the default
      // `redirect: 'follow'` a server could answer 307 and move the connection
      // to a host that never passed that check — an internal service, or the
      // loopback surfaces of this very machine. Redirects are followed here
      // instead, revalidating each hop, and the Authorization header is dropped
      // when the origin changes (fetch would do that itself, but only because
      // it happens to be the header MCP uses — doing it explicitly keeps the
      // guarantee if that changes). (WS-085)
      let currentUrl = typeof input === 'string' ? input : String(input);
      let hopHeaders = headers;
      for (let hop = 0; hop < MAX_TRANSPORT_REDIRECTS; hop++) {
        const fetchOpts: RequestInit = { ...init, headers: hopHeaders, redirect: 'manual' };
        // Resolution-bound connect (spike b1a8814a): the pinned dispatcher
        // performs the single DNS lookup the dial uses and refuses
        // link-local/IMDS targets always and private/LAN targets unless the
        // server opted in — re-checked on every redirect hop. Overrides a
        // subclass's plain TLS dispatcher; the pinned Agent embeds the same
        // TLS options, so certificate behavior is unchanged.
        this.applyPinnedDispatcher(fetchOpts);
        const res = await this.dispatcherFetch()(currentUrl, fetchOpts);
        if (
          res.status !== 301 &&
          res.status !== 302 &&
          res.status !== 303 &&
          res.status !== 307 &&
          res.status !== 308
        ) {
          return res;
        }
        const location = res.headers.get('location');
        if (!location) return res;
        const nextUrl = new URL(location, currentUrl).toString();
        // Same gate the configured URL had to clear.
        validateTransportUrl(nextUrl);
        if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
          hopHeaders = new Headers(hopHeaders);
          hopHeaders.delete('Authorization');
        }
        await res.body?.cancel().catch(() => undefined);
        currentUrl = nextUrl;
      }
      throw new ConfigError({
        message: `MCP server "${this.name}" exceeded ${MAX_TRANSPORT_REDIRECTS} redirects.`,
        code: 'CONFIG_INVALID',
      });
    };

    let response = await send();
    if (response.status !== 401 || !this.authorizationProvider?.handleUnauthorized) {
      return response;
    }
    const challenge = parseMcpBearerChallenge(
      response.headers.get('www-authenticate'),
      this.authorizationResource,
    );
    const retry = await this.authorizationProvider.handleUnauthorized(challenge, context);
    if (!retry) return response;
    await response.body?.cancel().catch(() => undefined);
    response = await send();
    return response;
  }

  listTools(): MCPTool[] {
    return [...this.tools];
  }

  getServerMetadata(): MCPServerMetadata | undefined {
    const metadata = this.serverMetadata;
    if (!metadata) return undefined;
    return {
      ...metadata,
      capabilities: { ...metadata.capabilities },
      serverInfo: { ...metadata.serverInfo },
    };
  }

  onDisconnect(cb: () => void): () => void {
    this.disconnectHandlers.push(cb);
    return () => {
      const idx = this.disconnectHandlers.indexOf(cb);
      if (idx >= 0) this.disconnectHandlers.splice(idx, 1);
    };
  }

  onToolsChanged(cb: (tools: MCPTool[]) => void): () => void {
    this.toolsChangedListeners.add(cb);
    return () => {
      this.toolsChangedListeners.delete(cb);
    };
  }

  onResourcesChanged(cb: () => void): () => void {
    this.resourcesChangedListeners.add(cb);
    return () => this.resourcesChangedListeners.delete(cb);
  }

  onPromptsChanged(cb: () => void): () => void {
    this.promptsChangedListeners.add(cb);
    return () => this.promptsChangedListeners.delete(cb);
  }

  /**
   * Fire all disconnect handlers. Subclasses call this when the connection
   * drops so the registry can schedule reconnects.
   */
  protected notifyDisconnect(): void {
    for (const cb of this.disconnectHandlers) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }

  protected notifyResourcesChanged(): void {
    for (const cb of this.resourcesChangedListeners) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }

  protected notifyPromptsChanged(): void {
    for (const cb of this.promptsChangedListeners) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }

  private dispatcherFetch(): typeof globalThis.fetch {
    // Honors test/user fetch shims. SECURITY NOTE: only the native path
    // enforces the resolution-bound policy at the dial (its Agent runs the
    // pinning lookup); a shim ignores RequestInit.dispatcher, so dial-time
    // enforcement under a shim depends on that shim. Shims are a test-only
    // construct — replacing globalThis.fetch in a production process is
    // already process compromise, the same assumption tools/_fetch-guard.ts
    // makes. The policy is exercised end-to-end against real dials in
    // packages/mcp/tests/transport-pinning.test.ts.
    return globalThis.fetch === nativeGlobalFetch
      ? (undiciFetch as unknown as typeof globalThis.fetch)
      : globalThis.fetch;
  }

  private pinnedDispatcher(): UndiciAgent {
    if (!this.pinnedAgent) {
      // allowH2: false keeps the proven HTTP/1.1 transport (undici 8's H2
      // streams can emit late unhandled errors after fetch rejects). The
      // connect lookup is the single DNS resolution the dial performs and it
      // enforces the address policy, closing the rebinding window between
      // validation and connect. TLS options ride in connect, so replacing a
      // subclass's plain TLS dispatcher does not weaken certificate checks.
      // `connections` stays at the undici default (unlimited per origin) so
      // concurrent streamable requests and an open SSE stream never
      // head-of-line block each other; releasePinnedDispatcher() tears the
      // pool down on close, and the beforeExit sweep is the backstop.
      const tls = this.tlsOptions;
      this.pinnedAgent = new UndiciAgent({
        allowH2: false,
        connect: {
          ...(tls ? { ca: tls.ca, rejectUnauthorized: tls.rejectUnauthorized } : {}),
          lookup: transportPinnedLookup({
            allowPrivateNetworks: this.allowPrivateNetworks,
            lookup: this.lookup,
          }) as never,
        },
      });
      pinnedAgents.add(this.pinnedAgent);
    }
    return this.pinnedAgent;
  }

  private applyPinnedDispatcher(fetchOpts: RequestInit): void {
    fetchOpts.dispatcher = this.pinnedDispatcher() as never as HttpDispatcher;
  }

  /**
   * Destroy this transport's pinned Agent and its connection pool. Idempotent.
   * Subclasses call it from close(); the process-exit sweep is the backstop.
   */
  protected releasePinnedDispatcher(): void {
    if (!this.pinnedAgent) return;
    pinnedAgents.delete(this.pinnedAgent);
    this.pinnedAgent.destroy();
    this.pinnedAgent = undefined;
  }

  /**
   * Apply the pinned TLS agent (if configured) to a `RequestInit` object.
   * Uses `HttpDispatcher` from `@wrongstack/core`'s dispatcher-types shim,
   * which declares `https.Agent` compatible with `RequestInit.dispatcher`.
   * Verified safe: https.Agent implements the `dispatch(req, opts)` method
   * that fetch requires at runtime.
   *
   * Superseded at fetch time by `applyPinnedDispatcher`, whose Agent embeds
   * these same TLS options plus the resolution-bound lookup.
   */
  protected applyTlsAgent(fetchOpts: RequestInit): void {
    if (this.tlsAgent) {
      // The global `RequestInit.dispatcher` type now accepts `HttpDispatcher`
      // (see dispatcher-types.d.ts). The cast through `unknown` is the standard
      // pattern for "I know this is compatible at runtime."
      fetchOpts.dispatcher = this.tlsAgent as never as HttpDispatcher;
    }
  }

  /** Generate the next JSON-RPC request id. Subclasses provide the counter. */
  protected abstract genId(): number;
}
