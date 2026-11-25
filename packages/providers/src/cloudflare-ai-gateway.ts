import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';

type ModelFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type InterceptableLanguageModel = LanguageModelV4 & {
  config?: { fetch?: ModelFetch | undefined } | undefined;
};

export interface CloudflareGatewayModelOptions {
  accountId: string;
  gatewayId: string;
  apiKey: string;
  provider: 'openai' | 'anthropic';
  fetchImpl?: typeof fetch | undefined;
}

class CaptureRequest extends Error {
  constructor() {
    super('Captured provider request for Cloudflare AI Gateway');
    this.name = 'CaptureRequest';
  }
}

/**
 * Route one native AI SDK model through Cloudflare's universal AI Gateway
 * endpoint without depending on `ai-gateway-provider`. That package currently
 * installs an AI SDK 6 OpenRouter adapter next to AI SDK 7, which makes npm
 * 10's Arborist repeatedly replace the two incompatible peer trees.
 */
export function createCloudflareGatewayModel(
  model: LanguageModelV4,
  options: CloudflareGatewayModelOptions,
): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (callOptions) => dispatch(model, options, 'doGenerate', callOptions),
    doStream: (callOptions) => dispatch(model, options, 'doStream', callOptions),
  };
}

async function dispatch(
  model: LanguageModelV4,
  options: CloudflareGatewayModelOptions,
  method: 'doGenerate',
  callOptions: LanguageModelV4CallOptions,
): Promise<LanguageModelV4GenerateResult>;
async function dispatch(
  model: LanguageModelV4,
  options: CloudflareGatewayModelOptions,
  method: 'doStream',
  callOptions: LanguageModelV4CallOptions,
): Promise<LanguageModelV4StreamResult>;
async function dispatch(
  model: LanguageModelV4,
  options: CloudflareGatewayModelOptions,
  method: 'doGenerate' | 'doStream',
  callOptions: LanguageModelV4CallOptions,
): Promise<LanguageModelV4GenerateResult | LanguageModelV4StreamResult> {
  // The capture and replay phases below mutate the inner model's shared
  // `config.fetch`, so two interleaved dispatches on the same instance would
  // snapshot each other's stubs as "original" and a later restore would
  // permanently reinstate a CaptureRequest stub — every subsequent request
  // on that model would then fail. Serialize per inner model (the config
  // owner): each capture → gateway → replay cycle becomes atomic, while
  // different models keep dispatching concurrently.
  const previous = dispatchChains.get(model) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(() => dispatchOnce(model, options, method, callOptions));
  dispatchChains.set(model, run);
  try {
    return await run;
  } finally {
    if (dispatchChains.get(model) === run) dispatchChains.delete(model);
  }
}

const dispatchChains = new WeakMap<LanguageModelV4, Promise<unknown>>();

async function dispatchOnce(
  model: LanguageModelV4,
  options: CloudflareGatewayModelOptions,
  method: 'doGenerate' | 'doStream',
  callOptions: LanguageModelV4CallOptions,
): Promise<LanguageModelV4GenerateResult | LanguageModelV4StreamResult> {
  const intercepted = model as InterceptableLanguageModel;
  if (!intercepted.config || !('fetch' in intercepted.config)) {
    throw new Error(`Cloudflare AI Gateway cannot intercept provider "${model.provider}".`);
  }

  const originalFetch = intercepted.config.fetch;
  let request: { url: string; init?: RequestInit | undefined } | undefined;
  intercepted.config.fetch = async (input, init) => {
    request = { url: String(input), init };
    throw new CaptureRequest();
  };

  try {
    await invoke(model, method, callOptions);
  } catch (error) {
    if (!(error instanceof CaptureRequest)) throw error;
  } finally {
    intercepted.config.fetch = originalFetch;
  }

  if (!request) throw new Error('Cloudflare AI Gateway received no provider request.');
  const response = await sendGatewayRequest(request, options, callOptions.abortSignal);

  intercepted.config.fetch = async () => response;
  try {
    return await invoke(model, method, callOptions);
  } finally {
    intercepted.config.fetch = originalFetch;
  }
}

function invoke(
  model: LanguageModelV4,
  method: 'doGenerate' | 'doStream',
  options: LanguageModelV4CallOptions,
): PromiseLike<LanguageModelV4GenerateResult | LanguageModelV4StreamResult> {
  return method === 'doGenerate' ? model.doGenerate(options) : model.doStream(options);
}

async function sendGatewayRequest(
  request: { url: string; init?: RequestInit | undefined },
  options: CloudflareGatewayModelOptions,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const headers = new Headers(request.init?.headers);
  headers.delete('content-length');
  headers.delete('host');
  headers.delete('authorization');
  if (options.provider === 'anthropic') headers.delete('x-api-key');

  const body = parseRequestBody(request.init?.body);
  const endpoint = providerEndpoint(request.url, options.provider);
  const gatewayHeaders = new Headers({
    'content-type': 'application/json',
    'cf-aig-authorization': `Bearer ${options.apiKey}`,
  });
  const gatewayFetch = options.fetchImpl ?? fetch;
  return gatewayFetch(
    `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(options.accountId)}/${encodeURIComponent(options.gatewayId)}`,
    {
      method: 'POST',
      headers: gatewayHeaders,
      body: JSON.stringify([
        {
          provider: options.provider,
          endpoint,
          headers: Object.fromEntries(headers.entries()),
          query: body,
        },
      ]),
      ...(signal ? { signal } : {}),
    },
  );
}

function parseRequestBody(body: RequestInit['body']): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  let text: string;
  if (typeof body === 'string') text = body;
  else if (body instanceof Uint8Array) text = new TextDecoder().decode(body);
  else if (body instanceof ArrayBuffer) text = new TextDecoder().decode(body);
  else {
    throw new Error('Cloudflare AI Gateway received an unsupported provider request body.');
  }
  const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Cloudflare AI Gateway request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function providerEndpoint(
  url: string,
  provider: CloudflareGatewayModelOptions['provider'],
): string {
  const origin = provider === 'openai' ? 'https://api.openai.com/' : 'https://api.anthropic.com/';
  if (!url.startsWith(origin)) {
    throw new Error(`Cloudflare AI Gateway cannot route unexpected ${provider} URL "${url}".`);
  }
  return url.slice(origin.length);
}
