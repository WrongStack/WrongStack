import type {
  Capabilities,
  ModelsDevModel,
  Provider,
  ReasoningEffort,
  Request,
  Response,
  StreamEvent,
} from '@wrongstack/core/types';
import { AnthropicProvider } from './anthropic.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import type { BuildBodyContext } from './model-output-limits.js';
import { type OpenAICompatibleOptions, OpenAICompatibleProvider } from './openai-compatible.js';

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';

/** Models documented by OpenCode Go as using its Anthropic Messages surface. */
export const OPENCODE_GO_ANTHROPIC_MODELS = new Set([
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
]);

const OPENCODE_GO_FIXED_ANTHROPIC_REASONING = new Set(['minimax-m2.7', 'minimax-m2.5']);
const OPENCODE_GO_QWEN_MODELS = new Set(['qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus']);

const OPENCODE_GO_EFFORTS: Readonly<Record<string, ReadonlySet<ReasoningEffort>>> = {
  'grok-4.5': new Set(['low', 'medium', 'high']),
  'glm-5.2': new Set(['high', 'max']),
  'kimi-k3': new Set(['max']),
  'deepseek-v4-pro': new Set(['high', 'max']),
  'deepseek-v4-flash': new Set(['high', 'max']),
};

/** OpenCode Go routes some models (e.g. deepseek-v4-flash) via sticky session affinity. */
function buildOpenCodeGoHeaders(stickySessionId: string): Record<string, string> {
  return {
    'x-opencode-session': stickySessionId,
    'x-opencode-client': 'wrongstack',
    'HTTP-Referer': 'https://opencode.ai/',
    'X-Title': 'wrongstack',
  };
}

function createOpenCodeGoStickySessionId(): string {
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 22);
  return `sess_${suffix}`;
}

export interface OpenCodeGoProviderOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  id?: string | undefined;
  headers?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Catalog entries from models.dev, used for routing and effort policy. */
  models?: readonly ModelsDevModel[] | undefined;
}

/**
 * OpenCode Go exposes one account/key behind two protocol surfaces. The public
 * provider remains a single WrongStack provider, while each request is routed
 * by model to either Chat Completions or Anthropic Messages.
 */
export class OpenCodeGoProvider implements Provider {
  readonly id: string;
  readonly capabilities: Capabilities = capabilitiesForFamily('openai-compatible', {
    reasoning: true,
    tools: true,
  });

  private readonly chat: OpenCodeGoChatProvider;
  private readonly messages: OpenCodeGoMessagesProvider;
  private readonly models: ReadonlyMap<string, ModelsDevModel>;

  constructor(opts: OpenCodeGoProviderOptions) {
    this.id = opts.id ?? 'opencode-go';
    this.models = new Map((opts.models ?? []).map((model) => [model.id, model]));
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const stickySessionId = createOpenCodeGoStickySessionId();
    const openCodeHeaders = {
      ...buildOpenCodeGoHeaders(stickySessionId),
      ...opts.headers,
    };
    this.chat = new OpenCodeGoChatProvider(
      {
        id: this.id,
        apiKey: opts.apiKey,
        baseUrl,
        headers: openCodeHeaders,
        fetchImpl: opts.fetchImpl,
        // OpenCode Go's Zen chat-completions surface closes successful streams
        // without a `[DONE]` marker or a final `finish_reason` chunk. Tolerate
        // the missing terminal marker so complete responses are not raised as
        // retryable 599 truncation errors.
        quirks: { tolerateMissingTerminalMarker: true },
      },
      this.models,
    );
    this.messages = new OpenCodeGoMessagesProvider(
      {
        id: this.id,
        apiKey: opts.apiKey,
        baseUrl,
        headers: openCodeHeaders,
        fetchImpl: opts.fetchImpl,
      },
      this.models,
    );
  }

  stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    const delegate = this.delegate(req.model);
    this.syncCapabilities(delegate);
    return delegate.stream(req, opts);
  }

  complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    const delegate = this.delegate(req.model);
    this.syncCapabilities(delegate);
    return delegate.complete(req, opts);
  }

  private delegate(model: string): Provider {
    const family = this.models.get(model)?.family?.toLowerCase();
    const catalogUsesMessages =
      family?.startsWith('minimax') === true || family?.startsWith('qwen') === true;
    return catalogUsesMessages || OPENCODE_GO_ANTHROPIC_MODELS.has(model)
      ? this.messages
      : this.chat;
  }

  private syncCapabilities(delegate: Provider): void {
    Object.defineProperty(delegate, 'capabilities', {
      value: this.capabilities,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
}

class OpenCodeGoChatProvider extends OpenAICompatibleProvider {
  constructor(
    opts: OpenAICompatibleOptions,
    private readonly models: ReadonlyMap<string, ModelsDevModel>,
  ) {
    super(opts);
  }

  protected override buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown> {
    const body = super.buildBody(req, ctx);

    // The generic adapter cannot know a gateway model's effort enum. Go's
    // catalog can: remove the generic value (especially literal `none`) and
    // restore only an exact value advertised for this model. Tools do not
    // suppress a model-supported effort on this provider.
    delete body['reasoning_effort'];
    const effort = req.reasoning?.enabled === false ? undefined : req.reasoning?.effort;
    const catalogEfforts = this.models.get(req.model)?.reasoningConfig?.effortLevels;
    const supported = catalogEfforts ? new Set(catalogEfforts) : OPENCODE_GO_EFFORTS[req.model];
    if (effort && supported?.has(effort)) {
      body['reasoning_effort'] = effort;
    }
    return body;
  }
}

class OpenCodeGoMessagesProvider extends AnthropicProvider {
  private readonly extraHeaders?: Record<string, string> | undefined;

  constructor(
    opts: ConstructorParameters<typeof AnthropicProvider>[0] & {
      headers?: Record<string, string> | undefined;
    },
    private readonly models: ReadonlyMap<string, ModelsDevModel>,
  ) {
    super(opts);
    this.extraHeaders = opts.headers;
  }

  protected override buildHeaders(req: Request): Record<string, string> {
    // Forward caller-supplied headers (proxy auth, tenant ids, routing keys),
    // strip any caller keys whose lowercase form matches a protected Anthropic
    // header (auth / version / content-type / accept) — HTTP header names are
    // case-insensitive, so a literal `delete headers['x-api-key']` would miss
    // caller keys like `X-Api-Key` or `x-API-key`. Then re-spread the
    // provider's headers so the host-conditional choice — `x-api-key` for
    // api.anthropic.com, `Authorization: Bearer …` otherwise — is the only
    // one that reaches the wire.
    const PROTECTED = new Set([
      'x-api-key',
      'authorization',
      'anthropic-version',
      'content-type',
      'accept',
    ]);
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.extraHeaders ?? {})) {
      if (!PROTECTED.has(key.toLowerCase())) filtered[key] = value;
    }
    return { ...filtered, ...super.buildHeaders(req) };
  }

  protected override buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown> {
    let normalized = req;
    const model = this.models.get(req.model);
    const family = model?.family?.toLowerCase();
    const fixedMiniMaxReasoning =
      family?.startsWith('minimax-m2') === true && model?.reasoningConfig?.default === 'always_on';
    const qwenModel = family?.startsWith('qwen') === true;

    // M2.7/M2.5 expose fixed reasoning without a toggle or effort control.
    if (
      (fixedMiniMaxReasoning || OPENCODE_GO_FIXED_ANTHROPIC_REASONING.has(req.model)) &&
      req.reasoning
    ) {
      normalized = { ...req, reasoning: undefined };
    } else if (
      (qwenModel || OPENCODE_GO_QWEN_MODELS.has(req.model)) &&
      req.reasoning?.effort !== undefined &&
      req.reasoning.enabled === undefined
    ) {
      // Qwen's Go metadata exposes a thinking budget. An effort-only runtime
      // request therefore needs to enable thinking so the Anthropic adapter
      // can translate that effort into budget_tokens.
      normalized = { ...req, reasoning: { ...req.reasoning, enabled: true } };
    }

    const body = super.buildBody(normalized, ctx);
    if (family === 'minimax-m3' || req.model === 'minimax-m3') {
      // MiniMax's Anthropic surface defaults thinking off; OpenCode enables
      // adaptive reasoning for M3 unless the caller explicitly disables it.
      body['thinking'] =
        req.reasoning?.enabled === false ? { type: 'disabled' } : { type: 'adaptive' };
    }
    return body;
  }
}
