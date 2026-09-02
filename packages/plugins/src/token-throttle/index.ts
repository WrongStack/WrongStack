/**
 * token-throttle plugin — enforces a rolling-window token budget on the
 * provider wire, delaying calls to stay under a rate limit.
 *
 * Registers an `AgentExtension.wrapProviderRunner`. Before each provider
 * call it prunes a 60-second sliding window of recorded spend, estimates
 * the outgoing request's tokens, and if the window's spend plus the
 * estimate would exceed `tokensPerMinute`, it sleeps just long enough for
 * older spend to age out of the window (capped at `maxDelayMs`). After
 * the call it records the response's actual usage. This smooths bursty
 * agent loops under a provider's TPM limit instead of hitting 429s.
 *
 * Safety posture: opt-in — loads inert until
 * `config.extensions['token-throttle'].enabled = true`. Delay is bounded
 * by `maxDelayMs` so a mis-set budget can never hang the agent
 * indefinitely.
 *
 * Config (`config.extensions['token-throttle']`):
 *
 * ```jsonc
 * {
 *   "enabled": false,
 *   "tokensPerMinute": 100000,  // rolling-window budget
 *   "maxDelayMs": 30000,        // hard cap on any single wait
 *   "charsPerToken": 4          // request-size → token estimate divisor
 * }
 * ```
 *
 * Tools:
 *  - `token_throttle_status` — window spend, throttle counters, total delay
 *
 * @public
 */
import type { Plugin, PluginAPI } from '@wrongstack/core/types';

const WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface TokenThrottleConfig {
  enabled: boolean;
  tokensPerMinute: number;
  maxDelayMs: number;
  charsPerToken: number;
}

const DEFAULTS: TokenThrottleConfig = {
  enabled: false,
  tokensPerMinute: 100_000,
  maxDelayMs: 30_000,
  charsPerToken: 4,
};

function readConfig(raw: unknown): TokenThrottleConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] === true,
    tokensPerMinute:
      typeof r['tokensPerMinute'] === 'number' && r['tokensPerMinute'] > 0
        ? r['tokensPerMinute']
        : DEFAULTS.tokensPerMinute,
    maxDelayMs:
      typeof r['maxDelayMs'] === 'number' && r['maxDelayMs'] >= 0
        ? r['maxDelayMs']
        : DEFAULTS.maxDelayMs,
    charsPerToken:
      typeof r['charsPerToken'] === 'number' && r['charsPerToken'] >= 1
        ? r['charsPerToken']
        : DEFAULTS.charsPerToken,
  };
}

// ---------------------------------------------------------------------------
// Rolling window + delay math (pure, testable)
// ---------------------------------------------------------------------------

export interface SpendEntry {
  at: number;
  tokens: number;
}

/** Drop entries older than the 60s window relative to `now`. */
export function pruneWindow(entries: SpendEntry[], now: number): SpendEntry[] {
  return entries.filter((e) => now - e.at < WINDOW_MS);
}

/** Sum tokens currently in the window. */
export function windowSpend(entries: SpendEntry[]): number {
  return entries.reduce((sum, e) => sum + e.tokens, 0);
}

/**
 * Delay (ms) needed before a request of `projected` tokens can proceed
 * without the window exceeding `limit`. 0 when it already fits. Computed
 * by aging out just enough of the oldest spend: we find the earliest
 * point at which enough tokens have expired to make room.
 */
export function computeThrottleDelay(
  entries: SpendEntry[],
  now: number,
  limit: number,
  projected: number,
): number {
  const current = windowSpend(entries);
  if (current + projected <= limit) return 0;
  if (entries.length === 0) return 0;
  // How many tokens must age out of the window to fit the projection.
  const mustFree = current + projected - limit;
  // Walk oldest→newest, accumulating freed tokens; the delay is until the
  // entry that crosses `mustFree` leaves the window.
  const sorted = [...entries].sort((a, b) => a.at - b.at);
  let freed = 0;
  for (const e of sorted) {
    freed += e.tokens;
    if (freed >= mustFree) {
      const leavesAt = e.at + WINDOW_MS;
      return Math.max(0, leavesAt - now);
    }
  }
  // Even freeing the whole window isn't enough (projection alone exceeds
  // the limit) — wait for the newest entry to leave the window.
  const newest = sorted[sorted.length - 1];
  return newest ? Math.max(0, newest.at + WINDOW_MS - now) : 0;
}

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface TokenThrottleState {
  window: SpendEntry[];
  invocations: number;
  throttled: number;
  totalDelayMs: number;
  extensionUnregister: null | (() => void);
}

const state: TokenThrottleState = {
  window: [],
  invocations: 0,
  throttled: 0,
  totalDelayMs: 0,
  extensionUnregister: null,
};

function estimateRequestTokens(request: Record<string, unknown>, charsPerToken: number): number {
  let chars = 0;
  const walk = (v: unknown): void => {
    if (typeof v === 'string') chars += v.length;
    else if (Array.isArray(v)) for (const i of v) walk(i);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o['text'] === 'string') chars += (o['text'] as string).length;
      if (o['content'] !== undefined) walk(o['content']);
    }
  };
  walk(request['system']);
  walk(request['messages']);
  return Math.ceil(chars / charsPerToken);
}

/**
 * Wait `ms`, but give up early if `signal` aborts.
 *
 * A plain `setTimeout` sleep made a throttled request uninterruptible:
 * pressing Ctrl+C during a throttle window did nothing until the full
 * delay (up to `maxDelayMs`) had elapsed, because nothing was listening
 * for the cancellation. The timer is also `unref`'d so a pending throttle
 * is never the reason the process stays alive.
 *
 * Resolves rather than rejects on abort — the caller re-checks the signal
 * and lets the provider layer own the cancellation error.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    // `{ once: true }` fires only on abort; the timeout path removes the
    // listener explicitly so a reused signal does not accumulate one
    // listener per throttled request.
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'token-throttle',
  version: '0.1.0',
  description:
    'Rolling-window tokens/min budget that delays provider calls to stay under a rate limit (wrapProviderRunner). Opt-in; delay capped by maxDelayMs.',
  apiVersion: '^0.1.10',
  capabilities: { tools: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: false,
        description:
          'Master switch. OFF by default because throttling injects delays into provider calls.',
      },
      tokensPerMinute: {
        type: 'number',
        minimum: 1,
        default: 100_000,
        description: 'Rolling 60s-window token budget.',
      },
      maxDelayMs: {
        type: 'number',
        minimum: 0,
        default: 30_000,
        description:
          'Hard cap on any single throttle wait so a mis-set budget cannot hang the agent.',
      },
      charsPerToken: {
        type: 'number',
        minimum: 1,
        default: 4,
        description: 'Divisor turning request char size into a token estimate.',
      },
    },
  },

  setup(api: PluginAPI) {
    // Idempotent re-init (H1 pattern).
    state.window = [];
    state.invocations = 0;
    state.throttled = 0;
    state.totalDelayMs = 0;
    if (state.extensionUnregister) {
      try {
        state.extensionUnregister();
      } catch {
        // best-effort
      }
      state.extensionUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['token-throttle']);

    if (cfg.enabled) {
      // Announce participation in the wrap stack so plugin-stack-observer
      // can build a system-prompt summary of who is wrapping what.
      api.emitCustom?.('provider.wrap:loaded', {
        plugin: 'token-throttle',
        kind: 'throttle',
        wraps: ['request'],
      });
      state.extensionUnregister = api.extensions.register({
        name: 'token-throttle',
        owner: 'token-throttle',
        async wrapProviderRunner(
          _ctx: unknown,
          request: unknown,
          inner: (c: unknown, r: unknown) => Promise<unknown>,
        ) {
          const signal = (_ctx as { signal?: AbortSignal } | undefined)?.signal;
          const req = (request ?? {}) as Record<string, unknown>;
          state.invocations += 1;
          const now = Date.now();
          state.window = pruneWindow(state.window, now);
          const projected = estimateRequestTokens(req, cfg.charsPerToken);
          const rawDelay = computeThrottleDelay(state.window, now, cfg.tokensPerMinute, projected);
          const delay = Math.min(rawDelay, cfg.maxDelayMs);
          if (delay > 0) {
            state.throttled += 1;
            state.totalDelayMs += delay;
            api.metrics.counter('throttled');
            api.metrics.histogram('delay_ms', delay);
            api.log.info('token-throttle: delaying provider call', { delayMs: delay, projected });
            await sleep(delay, signal);
          }

          const response = (await inner(_ctx, request)) as {
            usage?: { input?: number; output?: number };
          };
          const rawUsage = response?.usage as Record<string, unknown> | undefined;
          const inputTokens =
            (typeof rawUsage?.['input'] === 'number' ? rawUsage['input'] : undefined) ??
            (typeof rawUsage?.['prompt_tokens'] === 'number'
              ? rawUsage['prompt_tokens']
              : undefined) ??
            (typeof rawUsage?.['input_tokens'] === 'number'
              ? rawUsage['input_tokens']
              : undefined) ??
            (typeof rawUsage?.['promptTokens'] === 'number'
              ? rawUsage['promptTokens']
              : undefined) ??
            (typeof rawUsage?.['inputTokens'] === 'number' ? rawUsage['inputTokens'] : 0);
          const outputTokens =
            (typeof rawUsage?.['output'] === 'number' ? rawUsage['output'] : undefined) ??
            (typeof rawUsage?.['completion_tokens'] === 'number'
              ? rawUsage['completion_tokens']
              : undefined) ??
            (typeof rawUsage?.['output_tokens'] === 'number'
              ? rawUsage['output_tokens']
              : undefined) ??
            (typeof rawUsage?.['completionTokens'] === 'number'
              ? rawUsage['completionTokens']
              : undefined) ??
            (typeof rawUsage?.['outputTokens'] === 'number' ? rawUsage['outputTokens'] : 0);
          const totalTokens =
            (typeof rawUsage?.['total_tokens'] === 'number'
              ? rawUsage['total_tokens']
              : undefined) ??
            (typeof rawUsage?.['totalTokens'] === 'number' ? rawUsage['totalTokens'] : undefined) ??
            (typeof rawUsage?.['total'] === 'number' ? rawUsage['total'] : undefined) ??
            inputTokens + outputTokens;
          const used = totalTokens > 0 ? totalTokens : projected;
          state.window.push({ at: Date.now(), tokens: used });
          return response;
        },
      } as never);
    }

    api.tools.register({
      name: 'token_throttle_status',
      description:
        'Reports token-throttle state: window spend, throttle counters, and total injected delay.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        const now = Date.now();
        const live = pruneWindow(state.window, now);
        return {
          ok: true,
          enabled: cfg.enabled,
          tokensPerMinute: cfg.tokensPerMinute,
          maxDelayMs: cfg.maxDelayMs,
          windowSpend: windowSpend(live),
          windowEntries: live.length,
          counters: {
            invocations: state.invocations,
            throttled: state.throttled,
            totalDelayMs: state.totalDelayMs,
          },
        };
      },
    });

    api.log.info('token-throttle plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      tokensPerMinute: cfg.tokensPerMinute,
    });
  },

  teardown(api) {
    if (state.extensionUnregister) {
      try {
        state.extensionUnregister();
      } catch {
        // best-effort
      }
      state.extensionUnregister = null;
    }
    const final = {
      invocations: state.invocations,
      throttled: state.throttled,
      totalDelayMs: state.totalDelayMs,
    };
    state.window = [];
    state.invocations = 0;
    state.throttled = 0;
    state.totalDelayMs = 0;
    api.log.info('token-throttle: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `token-throttle: ${state.throttled} throttle(s) of ${state.invocations} call(s), ${state.totalDelayMs}ms total delay`,
      counters: {
        invocations: state.invocations,
        throttled: state.throttled,
        totalDelayMs: state.totalDelayMs,
      },
    };
  },
};

export default plugin;
