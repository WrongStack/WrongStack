/**
 * `github-copilot` wire family — GitHub Copilot subscription.
 *
 * Copilot's chat API is OpenAI chat/completions-compatible, so this extends
 * OpenAIProvider and only changes auth + base URL + headers:
 *   - `Authorization: Bearer <copilot-token>` plus the Copilot editor headers
 *     and `X-GitHub-Api-Version`.
 *   - The base URL is derived from the Copilot token's `proxy-ep=` field
 *     (e.g. https://api.individual.githubcopilot.com).
 *
 * Two tokens are involved: the long-lived GitHub OAuth token (stored as the
 * refresh token — it does NOT rotate) mints short-lived Copilot tokens via
 * `api.github.com/copilot_internal/v2/token`. This adapter refreshes the
 * Copilot token transparently (near-expiry + once on 401) and re-derives the
 * base URL from each new token. The API-key `openai` family is untouched.
 */

import type { Capabilities, Request } from '@wrongstack/core/types';
import { ProviderError } from '@wrongstack/core/types';
import { capabilitiesForFamily } from './family-capabilities.js';
import {
  COPILOT_HEADERS,
  type CopilotTokenResult,
  copilotBaseUrlFromToken,
  refreshCopilotToken,
} from './github-copilot-token.js';
import { OAuthRefreshCoordinator } from './oauth-refresh-coordinator.js';
import { openaiWireFormat } from './presets/openai.js';
import type { OpenAIStreamState } from './presets/openai.js';
import { WireFormatProvider } from './wire-format.js';
import type { WireAdapterStreamOptions } from './wire-adapter.js';
import type { BuildBodyContext } from './model-output-limits.js';

const COPILOT_API_VERSION = '2026-06-01';

// Token minting + API-base derivation live in github-copilot-token.ts so the
// oauth entry can mint tokens without bundling this provider. Re-exported for
// API compatibility.
export {
  type CopilotTokenResult,
  copilotBaseUrlFromToken,
  refreshCopilotToken,
} from './github-copilot-token.js';

export interface CopilotCredentials {
  /** Current Copilot token (access). May be empty → minted on first request. */
  copilotToken: string;
  /** Long-lived GitHub OAuth token (refresh; does not rotate). */
  githubToken?: string | undefined;
  /** Copilot-token expiry, epoch ms. */
  expiresAt?: number | undefined;
}

export interface GitHubCopilotProviderOptions {
  credentials: CopilotCredentials;
  id?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  capabilities?: Partial<Capabilities> | undefined;
  streamOpts?: WireAdapterStreamOptions | undefined;
  onRefresh?: ((creds: { accessToken: string; expiresAt: number }) => void) | undefined;
  refreshFn?:
    | ((githubToken: string, signal?: AbortSignal) => Promise<CopilotTokenResult>)
    | undefined;
}

export class GitHubCopilotProvider extends WireFormatProvider<OpenAIStreamState> {
  override readonly id: string;
  override readonly capabilities: Capabilities;

  private copilotToken: string;
  private readonly githubToken: string | undefined;
  private apiBase: string;
  private readonly refreshFn: (
    githubToken: string,
    signal?: AbortSignal,
  ) => Promise<CopilotTokenResult>;
  /** Shared OAuth refresh machinery — see packages/providers/src/oauth-refresh-coordinator.ts */
  private readonly refreshCoordinator: OAuthRefreshCoordinator<
    CopilotTokenResult,
    NonNullable<GitHubCopilotProviderOptions['onRefresh']> extends (p: infer P) => void ? P : never
  >;

  constructor(opts: GitHubCopilotProviderOptions) {
    const apiBase = copilotBaseUrlFromToken(opts.credentials.copilotToken);
    super(openaiWireFormat, {
      apiKey: opts.credentials.copilotToken || 'pending',
      baseUrl: apiBase,
      fetchImpl: opts.fetchImpl,
      streamOpts: opts.streamOpts,
    });
    this.id = opts.id ?? 'github-copilot';
    this.copilotToken = opts.credentials.copilotToken;
    this.githubToken = opts.credentials.githubToken;
    this.apiBase = apiBase;
    this.refreshFn = opts.refreshFn ?? refreshCopilotToken;
    this.refreshCoordinator = new OAuthRefreshCoordinator<
      CopilotTokenResult,
      {
        accessToken: string;
        expiresAt: number;
      }
    >({
      // The "refresh key" here is the long-lived GitHub OAuth token, which
      // does NOT rotate. The rotated value is the short-lived Copilot token.
      initialRefreshKey: opts.credentials.githubToken,
      initialExpiresAt: opts.credentials.expiresAt,
      label: 'GitHub Copilot',
      hooks: {
        refreshFn: (key, signal) => this.refreshFn(key, signal),
        onRefresh: opts.onRefresh,
        formatPayload: (_tokens, derived) => ({
          accessToken: derived.accessToken,
          expiresAt: derived.expiresAt,
        }),
        projectTokens: (tokens) => ({
          accessToken: tokens.token,
          expiresAt: tokens.expires,
          refreshKey: undefined, // GitHub OAuth token is permanent
        }),
        applyTokens: (derived) => {
          this.copilotToken = derived.accessToken;
          // The API base URL is derived from each new Copilot token's
          // `proxy-ep=` field. Recompute on every refresh so a token
          // pointing at a different proxy endpoint lands on the right host.
          this.apiBase = copilotBaseUrlFromToken(derived.accessToken);
        },
      },
    });
    this.capabilities = capabilitiesForFamily('github-copilot', { ...opts.capabilities });
  }

  override async *stream(req: Request, opts: { signal: AbortSignal }) {
    await this.ensureFreshToken(opts.signal);
    try {
      yield* super.stream(req, opts);
    } catch (err) {
      if (err instanceof ProviderError && err.status === 401 && this.githubToken) {
        await this.doRefresh(opts.signal);
        yield* super.stream(req, opts);
        return;
      }
      throw err;
    }
  }

  private async ensureFreshToken(signal: AbortSignal): Promise<void> {
    // Copilot starts with an empty copilot token + no expiry recorded. We
    // have to mint on first request even when there's no expiry timestamp,
    // so the coordinator's isStale() default (true when expiresAt is
    // undefined) handles that naturally — but we still need the github
    // token to actually call refreshFn, hence the explicit guard.
    if (!this.copilotToken || this.refreshCoordinator.isStale()) {
      // Without a GitHub token, the coordinator's doRefresh() no-ops (no
      // refresh key), leaving the copilot token empty — the request would then
      // go out as `Bearer pending` and come back as a raw, confusing 401. Fail
      // fast with an actionable message instead.
      if (!this.githubToken) {
        throw new ProviderError(
          'GitHub Copilot is not signed in (no GitHub token). Run `wstack auth` to sign in again.',
          401,
          false,
          this.id,
          { body: { message: 'no GitHub token available to mint a Copilot token' } },
        );
      }
      await this.refreshCoordinator.doRefresh(signal);
    }
  }

  private async doRefresh(signal: AbortSignal): Promise<void> {
    await this.refreshCoordinator.doRefresh(signal);
  }

  protected override buildUrl(_req: Request): string {
    return `${this.apiBase.replace(/\/+$/, '')}/chat/completions`;
  }

  /**
   * Copilot uses the legacy `max_tokens` field (OpenAI Chat Completions v1)
   * rather than the newer `max_completion_tokens` that `openaiWireFormat`
   * sends. Override buildBody to fix the field name after the preset runs.
   */
  protected override buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown> {
    const body = super.buildBody(req, ctx);
    // Rename max_completion_tokens → max_tokens for Copilot's API
    if ('max_completion_tokens' in body) {
      body['max_tokens'] = body['max_completion_tokens'];
      delete body['max_completion_tokens'];
    }
    return body;
  }

  protected override buildHeaders(_req: Request): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${this.copilotToken}`,
      'X-GitHub-Api-Version': COPILOT_API_VERSION,
      ...COPILOT_HEADERS,
    };
  }
}
