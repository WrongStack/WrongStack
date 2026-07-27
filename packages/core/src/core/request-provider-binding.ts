import type { Provider, Request } from '../types/provider.js';

/**
 * Provider identity owned by one concrete LLM request.
 *
 * Live model switches replace Context.provider, but an already-built request
 * must keep the provider it started with. Fallback is the deliberate
 * exception: it rebinds the same request before retrying it elsewhere.
 */
const requestProviders = new WeakMap<Request, Provider>();

export function bindRequestProvider(request: Request, provider: Provider): void {
  requestProviders.set(request, provider);
}

export function providerBoundToRequest(request: Request): Provider | undefined {
  return requestProviders.get(request);
}
