/**
 * `google-antigravity` wire family — a Gemini subscription via Google Antigravity.
 *
 * The Gemini wire is unchanged and the Gemini preset does all of the message
 * work; this class owns the four things the Cloud Code envelope adds:
 *
 *   1. **The envelope.** `buildBody` wraps the Gemini body the preset produces
 *      with the account's project id. That is why the wrapping is here and not
 *      in the preset: a preset is a pure `(req, ctx)` function and the project
 *      is instance state.
 *   2. **The project.** Discovered — and on a never-onboarded account,
 *      provisioned — before the first request, then reused.
 *   3. **Token refresh.** An OAuth subscription on Google's standard refresh
 *      endpoint, driven by the same shared coordinator the Claude and Copilot
 *      families use.
 *   4. **Quota.** Antigravity reports per-model buckets only when asked, and
 *      asking costs a request to the metered host, so the ask is bound to a
 *      turn that has already completed.
 *
 * The OAuth client is **supplied by the caller**, not embedded here. Google
 * validates which client minted a token, and the client the Antigravity app
 * uses is not published — it is extracted from the shipped binary. Keeping a
 * lifted client secret out of this repository is a deliberate choice; see
 * `docs/antigravity-provider.md` for what a user supplies instead.
 *
 * @module google-antigravity
 */

import { randomUUID } from 'node:crypto';
import { ProviderError, type Request, type StreamEvent } from '@wrongstack/contracts/types';
import { bootstrapAntigravityProject } from './google-antigravity-bootstrap.js';
import { buildAntigravityEnvelope, GOOGLE_TOKEN_URL } from './google-antigravity-protocol.js';
import { reportAntigravityQuota } from './google-antigravity-quota.js';
import type { BuildBodyContext } from './model-output-limits.js';
import { OAuthRefreshCoordinator } from './oauth-refresh-coordinator.js';
import type { GoogleStreamState } from './presets/google.js';
import { ANTIGRAVITY_PROVIDER_ID, antigravityWireFormat } from './presets/google-antigravity.js';
import type { WireAdapterStreamOptions } from './wire-adapter.js';
import { WireFormatProvider } from './wire-format.js';

/** Tokens as Google's refresh endpoint returns them. */
export interface AntigravityTokens {
  access: string;
  /** Epoch ms. */
  expires: number;
  /** Google does not rotate refresh tokens; carried through unchanged. */
  refresh: string | undefined;
}

export interface AntigravityCredentials {
  accessToken: string;
  refreshToken?: string | undefined;
  /** Epoch ms. */
  expiresAt?: number | undefined;
  /**
   * The account's Cloud Code project id, discovered at sign-in and persisted
   * with the credential. Bootstrapped on first use when absent.
   */
  project?: string | undefined;
}

/**
 * The Google OAuth client used to refresh. Supplied by the caller — see the
 * module note on why nothing is embedded.
 */
export interface AntigravityOAuthClient {
  clientId: string;
  clientSecret?: string | undefined;
}

export interface AntigravityProviderOptions {
  credentials: AntigravityCredentials;
  oauthClient?: AntigravityOAuthClient | undefined;
  id?: string | undefined;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  streamOpts?: WireAdapterStreamOptions | undefined;
  /** Persist rotated tokens. Mirrors the other OAuth families' hook. */
  onRefresh?:
    | ((payload: { accessToken: string; refreshToken: string; expiresAt: number }) => void)
    | undefined;
  /** Persist a project id discovered at runtime so the next session skips it. */
  onProjectDiscovered?: ((project: string) => void) | undefined;
  refreshFn?:
    | ((refreshToken: string, signal?: AbortSignal) => Promise<AntigravityTokens>)
    | undefined;
}

/** Exchange a refresh token for a fresh access token at Google's endpoint. */
export async function refreshAntigravityToken(
  refreshToken: string,
  client: AntigravityOAuthClient,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<AntigravityTokens> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (client.clientSecret) body.set('client_secret', client.clientSecret);
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError(
      `Antigravity token refresh failed (${res.status}): ${text || res.statusText}`,
      res.status,
      res.status === 429 || res.status >= 500,
      ANTIGRAVITY_PROVIDER_ID,
    );
  }
  const json = (await res.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
  };
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new ProviderError(
      'Antigravity token refresh returned no access token',
      500,
      false,
      ANTIGRAVITY_PROVIDER_ID,
    );
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3_600;
  return {
    access: json.access_token,
    expires: Date.now() + expiresIn * 1_000,
    refresh: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
  };
}

export class AntigravityProvider extends WireFormatProvider<GoogleStreamState> {
  override readonly id: string;

  private access: string;
  private project: string | undefined;
  private readonly opts: AntigravityProviderOptions;
  private readonly oauthClient: AntigravityOAuthClient | undefined;
  /**
   * One session id for the life of this provider.
   *
   * Google groups a conversation by it, so a fresh id per request would
   * present every turn as a new conversation — losing whatever server-side
   * continuity the grouping buys and making the account's own usage history
   * unreadable.
   */
  private readonly sessionId = randomUUID();
  private projectBootstrap: Promise<void> | undefined;
  private quotaReportInFlight = false;
  private readonly refreshCoordinator: OAuthRefreshCoordinator<
    AntigravityTokens,
    { accessToken: string; refreshToken: string; expiresAt: number }
  >;

  constructor(opts: AntigravityProviderOptions) {
    super(antigravityWireFormat, {
      apiKey: opts.credentials.accessToken,
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      fetchImpl: opts.fetchImpl,
      streamOpts: opts.streamOpts,
    });
    this.id = opts.id ?? ANTIGRAVITY_PROVIDER_ID;
    this.opts = opts;
    this.access = opts.credentials.accessToken;
    this.project = opts.credentials.project;
    this.oauthClient = opts.oauthClient;
    this.refreshCoordinator = new OAuthRefreshCoordinator<
      AntigravityTokens,
      { accessToken: string; refreshToken: string; expiresAt: number }
    >({
      initialRefreshKey: opts.credentials.refreshToken,
      initialExpiresAt: opts.credentials.expiresAt,
      label: 'Antigravity',
      hooks: {
        refreshFn: (key, signal) => this.runRefresh(key, signal),
        onRefresh: opts.onRefresh,
        formatPayload: (_tokens, derived) => ({
          accessToken: derived.accessToken,
          refreshToken: derived.refreshKey ?? '',
          expiresAt: derived.expiresAt,
        }),
        projectTokens: (tokens) => ({
          accessToken: tokens.access,
          expiresAt: tokens.expires,
          // Google reuses the refresh token; `undefined` leaves the stored one
          // in place rather than blanking it.
          refreshKey: tokens.refresh,
        }),
        applyTokens: (derived) => {
          this.access = derived.accessToken;
        },
      },
    });
  }

  private runRefresh(refreshToken: string, signal?: AbortSignal): Promise<AntigravityTokens> {
    if (this.opts.refreshFn) return this.opts.refreshFn(refreshToken, signal);
    if (!this.oauthClient) {
      // Without a client there is no way to refresh, and failing here with the
      // reason is far better than sending an expired token and surfacing
      // Google's opaque 401.
      return Promise.reject(
        new ProviderError(
          'Antigravity cannot refresh its token: no OAuth client configured. ' +
            "Set the provider's oauth client id/secret and sign in again.",
          401,
          false,
          this.id,
        ),
      );
    }
    return refreshAntigravityToken(refreshToken, this.oauthClient, signal, this.fetchImpl);
  }

  /**
   * Send the CURRENT access token.
   *
   * The base class captured `apiKey` at construction, so a refresh would
   * otherwise keep sending the token the session started with until the
   * process restarted. Same override the Claude and Copilot OAuth families
   * carry, for the same reason.
   */
  protected override buildHeaders(req: Request): Record<string, string> {
    return {
      ...super.buildHeaders(req),
      authorization: `Bearer ${this.access}`,
    };
  }

  override async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    await this.ensureFreshToken(opts.signal);
    await this.ensureProject(opts.signal);
    try {
      yield* super.stream(req, opts);
    } catch (err) {
      if (
        err instanceof ProviderError &&
        err.status === 401 &&
        this.opts.credentials.refreshToken
      ) {
        await this.refreshCoordinator.doRefresh(opts.signal);
        yield* super.stream(req, opts);
        this.scheduleQuotaReport();
        return;
      }
      throw err;
    }
    this.scheduleQuotaReport();
  }

  private async ensureFreshToken(signal: AbortSignal): Promise<void> {
    if (this.refreshCoordinator.isStale()) {
      await this.refreshCoordinator.doRefresh(signal);
    }
  }

  /**
   * Make sure a project id is known before the first request.
   *
   * Bootstrapping is memoized on the promise, not the result: two concurrent
   * first requests would otherwise both onboard, and `onboardUser` mutates
   * account state. A failure clears the memo so a later turn can retry — except
   * for the BYOP verdict, which is permanent and raised as such.
   */
  private ensureProject(signal: AbortSignal): Promise<void> {
    if (this.project) return Promise.resolve();
    if (!this.projectBootstrap) {
      this.projectBootstrap = (async () => {
        const result = await bootstrapAntigravityProject({
          accessToken: this.access,
          fetchImpl: this.fetchImpl,
          signal,
        });
        if (result.ok) {
          this.project = result.project;
          this.opts.onProjectDiscovered?.(result.project);
          return;
        }
        throw new ProviderError(
          result.reason === 'byop_required'
            ? 'Antigravity: this Google account has no Cloud Code project and Google will not ' +
                'create one for it. Supply your own GCP project id in the provider config.'
            : "Antigravity: could not determine the account's Cloud Code project. Check the " +
                'network and sign in again.',
          result.reason === 'byop_required' ? 400 : 503,
          result.reason !== 'byop_required',
          this.id,
        );
      })().catch((err: unknown) => {
        this.projectBootstrap = undefined;
        throw err;
      });
    }
    return this.projectBootstrap;
  }

  /**
   * Wrap the Gemini body the preset built in the Cloud Code envelope.
   *
   * `ensureProject` runs before `super.stream()`, so the project is present by
   * the time the adapter asks for a body. The guard is for a direct
   * `buildBody` call in a test, where a silent empty project would produce a
   * request Google rejects with a message about JSON rather than about setup.
   */
  protected override buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown> {
    if (!this.project) {
      throw new ProviderError(
        'Antigravity: no Cloud Code project resolved for this account yet',
        400,
        false,
        this.id,
      );
    }
    return buildAntigravityEnvelope({
      project: this.project,
      model: req.model,
      sessionId: this.sessionId,
      geminiBody: super.buildBody(req, ctx),
    });
  }

  /**
   * Read the account's per-model quota after a completed turn.
   *
   * Detached and never awaited: the turn is already delivered by the time this
   * runs, and a quota read must not be able to delay or fail it. Bound to turn
   * completion rather than a timer because this host is the metered one — a
   * background poll would spend the user's plan to describe the user's plan.
   */
  private scheduleQuotaReport(): void {
    if (this.quotaReportInFlight || !this.project) return;
    this.quotaReportInFlight = true;
    void reportAntigravityQuota(this.id, {
      accessToken: this.access,
      project: this.project,
      fetchImpl: this.fetchImpl,
    }).finally(() => {
      this.quotaReportInFlight = false;
    });
  }
}
