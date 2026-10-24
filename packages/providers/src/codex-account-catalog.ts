import { recordProviderQuota } from '@wrongstack/core/quota';
import { safeParse } from '@wrongstack/core/utils';
import {
  CODEX_MODELS_CACHE_TTL_MS,
  CODEX_MODELS_FAILURE_COOLDOWN_MS,
  CODEX_MODELS_TIMEOUT_MS,
  CODEX_USAGE_TIMEOUT_MS,
} from './codex-account-catalog-support.js';
import {
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
  codexClientVersion,
  codexUsageUrl,
} from './oauth/codex-protocol.js';
import type {
  CodexLiveModel,
  CodexModelMetadata,
  CodexModelPolicy,
  CodexModelsResponse,
} from './openai-codex-model-policy.js';
import {
  CODEX_DEFAULT_EFFECTIVE_CONTEXT_PERCENT,
  codexSendCeiling,
  parseCodexTruncationPolicy,
  parseReasoningEffort,
  parseSupportedReasoningEfforts,
} from './openai-codex-model-policy.js';
import { parseCodexUsagePayload } from './openai-codex-rate-limits.js';
import { positiveContextLimit, resolveCodexModelsUrl } from './openai-codex-request.js';
import { upstreamUrl } from './proxy-upstream.js';
import { redirectSafeFetch } from './redirect-safe-fetch.js';

export interface CodexAccountCatalogHost {
  baseUrl: string;
  buildHeaders: (_req: import('@wrongstack/contracts/types').Request) => Record<string, string>;
  contextLimitsEtag: string | undefined;
  fetchImpl: (input: string | URL | Request, init?: RequestInit | undefined) => Promise<Response>;
  contextLimitsFreshUntil: number;
  contextLimitsRetryAfter: number;
  contextLimits: Map<string, import('./openai-codex-model-policy.js').CodexModelPolicy>;
  publishLiveModels: (models: import('./openai-codex-model-policy.js').CodexLiveModel[]) => void;
  onModels:
    | ((models: import('./openai-codex-model-policy.js').CodexLiveModel[]) => void)
    | undefined;
  lastModelsSignature: string | undefined;
  access: string;
  accountId: string | undefined;
  ensureFreshToken: (signal: AbortSignal) => Promise<void>;
  doRefresh: (signal: AbortSignal) => Promise<void>;
  id: string;
}

export async function fetchContextLimits(
  this: CodexAccountCatalogHost,
  signal: AbortSignal,
): Promise<void> {
  const url = `${resolveCodexModelsUrl(this.baseUrl)}?client_version=${encodeURIComponent(codexClientVersion())}`;
  const timeout = AbortSignal.timeout(CODEX_MODELS_TIMEOUT_MS);
  const probeSignal = AbortSignal.any([signal, timeout]);
  try {
    const headers = this.buildHeaders({ model: '', messages: [] });
    headers.accept = 'application/json';
    delete headers['content-type'];
    if (this.contextLimitsEtag) headers['if-none-match'] = this.contextLimitsEtag;
    const response = await redirectSafeFetch(this.fetchImpl, url, {
      method: 'GET',
      headers,
      signal: probeSignal,
    });
    if (response.status === 304) {
      this.contextLimitsFreshUntil = Date.now() + CODEX_MODELS_CACHE_TTL_MS;
      this.contextLimitsRetryAfter = 0;
      return;
    }
    if (!response.ok) {
      this.contextLimitsRetryAfter = Date.now() + CODEX_MODELS_FAILURE_COOLDOWN_MS;
      return;
    }
    const payload = safeParse<CodexModelsResponse>(await response.text());
    if (!payload.ok || !Array.isArray(payload.value?.models)) {
      this.contextLimitsRetryAfter = Date.now() + CODEX_MODELS_FAILURE_COOLDOWN_MS;
      return;
    }
    const next = new Map<string, CodexModelPolicy>();
    const live: CodexLiveModel[] = [];
    for (const raw of payload.value.models) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as CodexModelMetadata;
      if (typeof entry.slug !== 'string') continue;
      // Prefer the model's maximum; fall back to the default window for a
      // catalog too old to publish one. See codexSendCeiling.
      const window =
        positiveContextLimit(entry.max_context_window) ??
        positiveContextLimit(entry.context_window);
      // `visibility: 'list'` is what the official picker shows; `hide` marks
      // internal routes (`gpt-reserve`, `codex-auto-review`) that a user must
      // not be offered. Policy is still recorded for them — a hidden model
      // the caller names explicitly should still get the right ceiling.
      if (entry.visibility === undefined || entry.visibility === 'list') {
        live.push({
          id: entry.slug,
          name: typeof entry.display_name === 'string' ? entry.display_name : entry.slug,
          ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
          ...(window ? { maxContext: window } : {}),
        });
      }
      if (!window) continue;
      const percent =
        typeof entry.effective_context_window_percent === 'number'
          ? entry.effective_context_window_percent
          : CODEX_DEFAULT_EFFECTIVE_CONTEXT_PERCENT;
      const defaultReasoningEffort = parseReasoningEffort(entry.default_reasoning_level);
      // Absent `input_modalities` means an older catalog that predates the
      // field, not a text-only model — assume images are fine there.
      const modalities = entry.input_modalities;
      next.set(entry.slug, {
        sendCeiling: codexSendCeiling(window, percent),
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
        supportedReasoningEfforts: parseSupportedReasoningEfforts(entry.supported_reasoning_levels),
        acceptsImages: !Array.isArray(modalities) || modalities.includes('image'),
        parallelToolCalls: entry.supports_parallel_tool_calls !== false,
        supportsVerbosity: entry.support_verbosity === true,
        truncation: parseCodexTruncationPolicy(entry.truncation_policy),
      });
    }
    if (next.size === 0) {
      this.contextLimitsRetryAfter = Date.now() + CODEX_MODELS_FAILURE_COOLDOWN_MS;
      return;
    }
    this.contextLimits = next;
    this.publishLiveModels(live);
    this.contextLimitsEtag = response.headers?.get?.('etag') ?? undefined;
    this.contextLimitsFreshUntil = Date.now() + CODEX_MODELS_CACHE_TTL_MS;
    this.contextLimitsRetryAfter = 0;
  } catch {
    // Keep the last verified catalog. The awaited probe is deliberately
    // bounded: knowing the new ceiling before send is the safety guarantee;
    // a failed probe may delay one request by at most the timeout above.
    this.contextLimitsRetryAfter = Date.now() + CODEX_MODELS_FAILURE_COOLDOWN_MS;
  }
}

export function publishLiveModels(this: CodexAccountCatalogHost, models: CodexLiveModel[]): void {
  if (!this.onModels || models.length === 0) return;
  const signature = models.map((m) => `${m.id}:${m.maxContext ?? ''}`).join(',');
  if (signature === this.lastModelsSignature) return;
  this.lastModelsSignature = signature;
  this.onModels(models);
}

export async function readAccountQuota(
  this: CodexAccountCatalogHost,
  opts: { signal?: AbortSignal | undefined; timeoutMs?: number } = {},
) {
  const signal = AbortSignal.any([
    ...(opts.signal ? [opts.signal] : []),
    AbortSignal.timeout(opts.timeoutMs ?? CODEX_USAGE_TIMEOUT_MS),
  ]);
  const url = upstreamUrl(codexUsageUrl(this.baseUrl));
  const read = async (): Promise<Response> => {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.access}`,
      originator: CODEX_ORIGINATOR,
      'user-agent': CODEX_USER_AGENT,
    };
    if (this.accountId) headers['chatgpt-account-id'] = this.accountId;
    return redirectSafeFetch(this.fetchImpl, url, { method: 'GET', headers, signal });
  };
  try {
    await this.ensureFreshToken(signal);
    let response = await read();
    if (response.status === 401) {
      await this.doRefresh(signal);
      response = await read();
    }
    if (!response.ok) return [];
    const payload = safeParse<unknown>(await response.text());
    if (!payload.ok) return [];
    const snapshots = parseCodexUsagePayload(this.id, payload.value);
    if (snapshots.length > 0) recordProviderQuota(this.id, snapshots);
    return snapshots;
  } catch {
    return [];
  }
}
