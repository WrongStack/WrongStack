import type { ProviderModelStatusTracker } from '../coordination/provider-status-tracker.js';
import type { EventBus } from '../kernel/events.js';
import type { AgentContext } from './context.js';
import type { Logger } from './logger.js';
import type { Tracer } from './observability.js';
import type { Provider, Request, Response } from './provider.js';
import type { RetryPolicy } from './retry-policy.js';

/**
 * Options passed to a ProviderRunner when calling the provider.
 * Shape intentionally mirrors runProviderWithRetry's parameters
 * so the default implementation is a thin wrapper.
 */
export interface RunProviderOptions {
  provider: Provider;
  request: Request;
  signal: AbortSignal;
  ctx: AgentContext;
  events: EventBus;
  retry: RetryPolicy;
  logger: Logger;
  tracer?: Tracer | undefined;
  /**
   * Shared provider/model waiting room. A runner that honours it must refuse
   * to call a quarantined (provider, model) pair and must report the wire
   * outcome back — this funnel is the last line of defence that keeps a
   * quota-exhausted route off the wire no matter which extensions are loaded.
   */
  statusTracker?: ProviderModelStatusTracker | undefined;
}

/**
 * A replaceable service for calling a provider with retry logic,
 * streaming, and tracing. Bind a custom implementation to
 * `TOKENS.ProviderRunner` to completely replace the built-in
 * behavior — e.g. for caching, fallback chains, or custom
 * rate limiting.
 *
 * For lighter-weight wrapping (add middleware without replacing),
 * use `AgentExtension.wrapProviderRunner` via the ExtensionRegistry.
 */
export interface ProviderRunner {
  run(opts: RunProviderOptions): Promise<Response>;
}
