import { createHash, randomUUID } from 'node:crypto';
import type {
  Capabilities,
  ImageGenerationRequest,
  ImageGenerationResult,
  ProviderError,
  ReasoningEffort,
  Request,
  StreamEvent,
} from '@wrongstack/contracts/types';
import { isVolatileSystemBlock } from '@wrongstack/contracts/types';
import { recordProviderQuota } from '@wrongstack/core/quota';
import { type HeadersLike, parseProviderHttpError } from './error-parse.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import { openAIImagesBody, openAIImagesUrl, parseOpenAIImages } from './image-generation.js';
import { type BuildBodyContext, resolveMaxOutputTokens } from './model-output-limits.js';
import { parseOpenAIResponsesStream } from './openai-codex.js';
import { parseCodexRateLimitHeaders } from './openai-codex-rate-limits.js';
import {
  appendVolatileSystem,
  codexCacheSessionId,
  codexClientRequestId,
} from './openai-codex-request.js';
import { applyPromptCacheKey } from './prompt-cache-key.js';
import {
  isCacheProbeEnabled,
  recordCacheProbeRequest,
  recordCacheProbeUsage,
} from './prompt-cache-probe.js';
import { messagesToResponsesInput, toolsToResponses } from './tool-format/to-responses.js';
import { WireAdapter, type WireAdapterStreamOptions } from './wire-adapter.js';

export interface OpenAIResponsesProviderOptions {
  id: string;
  apiKey: string;
  baseUrl: string;
  headers?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch | undefined;
  capabilities?: Partial<Capabilities> | undefined;
  streamOpts?: WireAdapterStreamOptions | undefined;
  /** Explicit state retention policy for public subscription Responses requests. */
  store?: boolean | undefined;
  /** Retain encrypted reasoning for stateless ChatGPT plan requests. */
  replayReasoning?: boolean | undefined;
  /** Apply the public ChatGPT plan route's supported fields and tool namespace contract. */
  chatGPTPlan?: boolean | undefined;
}

/**
 * API-key authenticated OpenAI Responses transport for compatible gateways.
 * Unlike OpenAICodexProvider, this uses a normal Bearer key and a conventional
 * `/v1/responses` endpoint; it has no ChatGPT OAuth headers or token refresh.
 */
export class OpenAIResponsesProvider extends WireAdapter {
  override readonly id: string;
  override readonly capabilities: Capabilities;

  private readonly extraHeaders?: Record<string, string> | undefined;
  private readonly responseOptions: Pick<
    OpenAIResponsesProviderOptions,
    'store' | 'replayReasoning' | 'chatGPTPlan'
  >;
  private readonly cacheProbeRequests = new WeakMap<
    object,
    { requestId: string; sessionKey: string; reasoningTokens: number | undefined }
  >();

  constructor(opts: OpenAIResponsesProviderOptions) {
    super(opts.apiKey, opts.baseUrl, opts.fetchImpl, opts.streamOpts);
    this.id = opts.id;
    this.extraHeaders = opts.headers;
    this.responseOptions = opts;
    this.capabilities = capabilitiesForFamily('openai', opts.capabilities);
  }

  override async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    if (!isCacheProbeEnabled()) {
      yield* super.stream(req, opts);
      return;
    }
    // Each call owns its probe, even if a caller reuses the same Request.
    // Tool filtering preserves this fresh cache object across request copies.
    const probe = {
      requestId: '',
      sessionKey: 'no-session',
      reasoningTokens: undefined as number | undefined,
    };
    req = { ...req, cache: { ...req.cache } };
    this.cacheProbeRequests.set(req.cache!, probe);
    for await (const event of super.stream(req, opts)) {
      if (event.type === 'message_stop') {
        recordCacheProbeUsage({
          provider: this.id,
          sessionKey: probe.sessionKey,
          requestId: probe.requestId,
          model: req.model,
          threadId: req.cache?.threadId ?? req.cache?.sessionId,
          usage: event.usage,
          reasoningTokens: probe.reasoningTokens,
        });
      }
      yield event;
    }
  }

  /** Text-to-image through the images API beside the Responses endpoint. */
  async generateImage(
    req: ImageGenerationRequest,
    opts: { signal: AbortSignal },
  ): Promise<ImageGenerationResult> {
    const headers = this.buildHeaders({ model: req.model, messages: [] });
    const json = await this.postJson(
      openAIImagesUrl(this.baseUrl),
      openAIImagesBody(req),
      headers,
      opts.signal,
    );
    return parseOpenAIImages(json);
  }

  protected override buildUrl(_req: Request): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    if (base.endsWith('/responses')) return base;
    if (/\/v\d+$/i.test(base)) return `${base}/responses`;
    return `${base}/v1/responses`;
  }

  protected override buildHeaders(req: Request): Record<string, string> {
    // Forward caller-supplied headers (proxy auth, tenant ids, routing keys),
    // strip any caller keys whose lowercase form matches a protected OpenAI
    // Responses header (`authorization`, `content-type`, `accept`) — HTTP
    // header names are case-insensitive, so a literal spread order would let
    // caller `Authorization` / `Content-Type` / `Accept` override the
    // provider's. Then write the provider-controlled headers last so the
    // provider's own `authorization: Bearer ${apiKey}` wins over any caller
    // override.
    const PROTECTED = new Set(['authorization', 'content-type', 'accept']);
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.extraHeaders ?? {})) {
      if (!PROTECTED.has(key.toLowerCase())) filtered[key] = value;
    }
    const headers: Record<string, string> = {
      ...filtered,
      ...super.buildHeaders(req),
      authorization: `Bearer ${this.apiKey}`,
    };
    if (this.responseOptions.chatGPTPlan) {
      // Match the official Responses client's owning-session/thread split.
      // Explicit gateway headers remain untouched outside the plan route.
      for (const name of Object.keys(headers)) {
        if (['session-id', 'thread-id', 'x-client-request-id'].includes(name.toLowerCase())) {
          delete headers[name];
        }
      }
      const sessionId = codexCacheSessionId(req.cache?.sessionId);
      const threadId = codexCacheSessionId(req.cache?.threadId) ?? sessionId;
      if (sessionId) headers['session-id'] = sessionId;
      if (threadId) {
        const requestId = codexClientRequestId(threadId);
        headers['thread-id'] = requestId;
        headers['x-client-request-id'] = requestId;
      }
    }
    return headers;
  }

  protected override buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown> {
    // A marked per-turn block must not rewrite instructions before history.
    // Honour the same stability contract as the ChatGPT Codex adapter.
    const stableSystem: string[] = [];
    const volatileSystem: string[] = [];
    for (const block of req.system ?? []) {
      (isVolatileSystemBlock(block) ? volatileSystem : stableSystem).push(block.text);
    }
    const instructions = stableSystem.length > 0 ? stableSystem.join('\n\n') : undefined;
    const body: Record<string, unknown> = {
      model: req.model,
      stream: true,
      input: appendVolatileSystem(
        messagesToResponsesInput(req.messages, {
          includeReasoning: this.responseOptions.replayReasoning,
          allowImages: ctx.capabilities?.vision !== false,
          allowDocuments: ctx.capabilities?.pdf !== false,
        }),
        volatileSystem,
      ),
    };
    if (this.responseOptions.store !== undefined) body['store'] = this.responseOptions.store;
    if (this.responseOptions.replayReasoning) body['include'] = ['reasoning.encrypted_content'];
    if (instructions) body['instructions'] = instructions;
    if (req.tools && req.tools.length > 0) {
      body['tools'] = toolsToResponses(req.tools);
      body['tool_choice'] = mapToolChoice(req.toolChoice);
      body['parallel_tool_calls'] = true;
    }
    const maxOutput = resolveMaxOutputTokens(req, ctx);
    if (maxOutput !== undefined) {
      body['max_output_tokens'] = maxOutput;
    }
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.topP !== undefined) body['top_p'] = req.topP;
    const effort = supportedResponsesEffort(req.reasoning?.effort);
    if (req.reasoning?.enabled !== false && effort) {
      body['reasoning'] = { effort, summary: 'auto' };
    }
    applyPromptCacheKey(body, req, ctx.capabilities);
    if (this.responseOptions.chatGPTPlan) {
      // Tool/prompt epochs may change the generic prefix hash; the owning
      // conversation's cache partition stays stable, as on the Codex route.
      const sessionId = codexCacheSessionId(req.cache?.sessionId);
      if (sessionId && ctx.capabilities?.cacheControl === 'auto') {
        body['prompt_cache_key'] = sessionId;
      }
      // https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
      // The plan route does not accept sampling or output-cap parameters.
      delete body['max_output_tokens'];
      delete body['temperature'];
      delete body['top_p'];
      if (Array.isArray(body['tools'])) {
        body['tools'] = [
          {
            type: 'namespace',
            name: 'wrongstack',
            description: 'WrongStack tools executed by the local agent.',
            tools: body['tools'],
          },
        ];
      }
      const choice = body['tool_choice'];
      if (choice && typeof choice === 'object')
        body['tool_choice'] = { ...choice, namespace: 'wrongstack' };
      for (const item of body['input'] as Record<string, unknown>[]) {
        if (item['type'] === 'function_call') item['namespace'] = 'wrongstack';
      }
    }
    const probe = req.cache ? this.cacheProbeRequests.get(req.cache) : undefined;
    if (probe) {
      probe.requestId = randomUUID();
      probe.sessionKey = String(body['prompt_cache_key'] ?? 'no-session');
      recordCacheProbeRequest({
        provider: this.id,
        sessionKey: probe.sessionKey,
        requestId: probe.requestId,
        model: req.model,
        threadId: req.cache?.threadId ?? req.cache?.sessionId,
        accountScope: createHash('sha256').update(this.apiKey).digest('hex'),
        settings: [
          body['reasoning'],
          body['text'],
          body['tool_choice'],
          body['parallel_tool_calls'],
        ],
        instructions: String(body['instructions'] ?? ''),
        tools: body['tools'] as readonly unknown[] | undefined,
        items: body['input'] as readonly unknown[],
      });
    }
    return body;
  }

  protected override parseStream(
    body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
    fallbackModel: string,
    req?: Request,
  ): AsyncIterable<StreamEvent> {
    const probe = req?.cache ? this.cacheProbeRequests.get(req.cache) : undefined;
    return parseOpenAIResponsesStream(
      body,
      fallbackModel,
      this.id,
      undefined,
      probe
        ? (tokens) => {
            probe.reasoningTokens = tokens;
          }
        : undefined,
      {
        requireTerminalEnvelope: this.responseOptions.chatGPTPlan === true,
      },
    );
  }

  protected override onResponseHeaders(headers: HeadersLike | undefined): void {
    if (!this.responseOptions.chatGPTPlan || !headers) return;
    // Only publish windows actually reported by the plan route. Ordinary API
    // RPM/TPM headers cannot describe a ChatGPT subscription allowance.
    const snapshots = parseCodexRateLimitHeaders(headers).map((snapshot) => ({
      ...snapshot,
      providerId: this.id,
    }));
    if (snapshots.length > 0) recordProviderQuota(this.id, snapshots);
  }

  protected override translateError(
    status: number,
    text: string,
    headers?: HeadersLike,
  ): ProviderError {
    this.onResponseHeaders(headers);
    return parseProviderHttpError(this.id, status, text, headers);
  }
}

function supportedResponsesEffort(
  effort: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (effort === undefined) return undefined;
  // The Responses API's documented effort set is model-dependent and spans
  // the full ReasoningEffort union (none|minimal|low|medium|high|xhigh|max per
  // the 2026-08 reasoning guide). Accept every canonical value verbatim: the
  // model rejects an unsupported one with an actionable 400, whereas silently
  // dropping it here (the old behavior for minimal/max) made the user's
  // setting a quiet no-op.
  return effort;
}

function mapToolChoice(
  choice: Request['toolChoice'],
): 'auto' | 'required' | 'none' | { type: 'function'; name: string } {
  if (choice === undefined) return 'auto';
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice;
  return { type: 'function', name: choice.name };
}
