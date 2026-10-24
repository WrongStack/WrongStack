import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import { WrongStackError } from '@wrongstack/contracts/types/errors';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { Provider, Request, Response } from '@wrongstack/contracts/types/provider';
import { classifyProviderError, ProviderError } from '@wrongstack/contracts/types/provider';
import { describe, expect, it } from 'vitest';
import { ProviderModelStatusTracker } from '../../src/coordination/provider-status-tracker.js';
import { runProviderWithRetry } from '../../src/core/provider-runner.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';

/**
 * Kimi answers an exhausted billing cycle with HTTP 403 plus a prose message.
 * Reproduced verbatim: the classifier's quota branch must win over the
 * 401/403 auth branch, otherwise the pair never enters the waiting room.
 */
const KIMI_QUOTA_MESSAGE =
  'You have reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing';

/**
 * A ProviderError built against a DIFFERENT class identity than the one
 * `provider-runner.ts` imports — exactly what `@wrongstack/providers` produces
 * at runtime, because the package builder emits each `@wrongstack/core`
 * subpath as its own esbuild bundle carrying its own copy of the class.
 * Anything in the failure path that relies on `instanceof` sees a stranger.
 */
class ForeignProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly providerId: string;
  readonly kind: ReturnType<typeof classifyProviderError>;
  readonly code = 'PROVIDER_QUOTA_EXHAUSTED';
  readonly subsystem = 'provider';
  readonly severity = 'warning';
  readonly recoverable = false;
  readonly body: { type: string; message: string };

  constructor(providerId: string, status: number, body: { type: string; message: string }) {
    super(`${providerId} HTTP ${status}`);
    this.name = 'ProviderError';
    this.status = status;
    this.providerId = providerId;
    this.body = body;
    this.kind = classifyProviderError(status, body);
    this.retryable = false;
  }

  describe(): string {
    return `${this.providerId} forbidden (${this.status}): ${this.body.message}`;
  }
}

function quotaProvider(id: string, onCall: () => void): Provider {
  return {
    id,
    capabilities: { streaming: false, tools: true, vision: false },
    async complete(): Promise<Response> {
      onCall();
      throw new ForeignProviderError(id, 403, {
        type: 'permission_error',
        message: KIMI_QUOTA_MESSAGE,
      });
    },
  } as unknown as Provider;
}

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

function makeCtx(): AgentContext {
  return { agentId: 'test-agent', session: { id: 'sess-1' } } as unknown as AgentContext;
}

function makeRequest(model: string): Request {
  return { model, messages: [{ role: 'user', content: 'hi' }] } as unknown as Request;
}

function baseOpts(tracker: ProviderModelStatusTracker) {
  return {
    request: makeRequest('k3'),
    signal: new AbortController().signal,
    ctx: makeCtx(),
    events: new EventBus(),
    retry: new DefaultRetryPolicy(),
    logger: silentLogger,
    statusTracker: tracker,
  };
}

describe('provider-runner waiting-room middleware', () => {
  it('keeps a cross-bundle ProviderError intact instead of flattening it to AgentError', async () => {
    const tracker = new ProviderModelStatusTracker();
    let calls = 0;
    const err = await runProviderWithRetry({
      provider: quotaProvider('kimi-for-coding', () => {
        calls++;
      }),
      ...baseOpts(tracker),
    }).catch((e: unknown) => e);

    expect(calls).toBe(1);
    // Before the fix this arrived as `AgentError` with no kind/status/body, so
    // the fallback engine could neither hop nor quarantine.
    expect((err as ForeignProviderError).name).toBe('ProviderError');
    expect((err as ForeignProviderError).kind).toBe('quota_exhausted');
    expect((err as ForeignProviderError).status).toBe(403);
  });

  it('quarantines the pair on the first quota response', async () => {
    const tracker = new ProviderModelStatusTracker();
    await runProviderWithRetry({
      provider: quotaProvider('kimi-for-coding', () => {}),
      ...baseOpts(tracker),
    }).catch(() => undefined);

    expect(tracker.isAvailable('kimi-for-coding', 'k3')).toBe(false);
    // Account-level exhaustion is provider-wide: siblings go down with it.
    expect(tracker.isAvailable('kimi-for-coding', 'some-other-model')).toBe(false);
  });

  it('cuts the next request before the wire while the pair is quarantined', async () => {
    const tracker = new ProviderModelStatusTracker();
    let calls = 0;
    const provider = quotaProvider('kimi-for-coding', () => {
      calls++;
    });

    await runProviderWithRetry({ provider, ...baseOpts(tracker) }).catch(() => undefined);
    expect(calls).toBe(1);

    const gateErr = await runProviderWithRetry({ provider, ...baseOpts(tracker) }).catch(
      (e: unknown) => e,
    );

    // No second HTTP call — the middleware answered from the waiting room.
    expect(calls).toBe(1);
    // …and it answers with a fallback-worthy error so an outer chain rotates.
    expect((gateErr as { kind?: string }).kind).toBe('rate_limit');
    expect((gateErr as Error).message).toContain('provider waiting room');
  });

  // A ChatGPT session tripped OpenAI's cyber classifier twice and the pair went
  // `degraded` (consecutive_failures_2) for every session sharing it. The
  // refusal judged the content; the provider was healthy.
  it('does not count a safety-classifier refusal against the pair', async () => {
    const tracker = new ProviderModelStatusTracker();
    const refusing = (code: string | undefined): Provider =>
      ({
        id: 'openai-chatgpt',
        capabilities: { streaming: false, tools: true, vision: false },
        async complete(): Promise<Response> {
          throw new ProviderError('flagged', 400, false, 'openai-chatgpt', {
            kind: 'invalid_request',
            body: { type: 'invalid_request', message: 'flagged', ...(code ? { code } : {}) },
          });
        },
      }) as unknown as Provider;

    for (let i = 0; i < 3; i++) {
      await runProviderWithRetry({
        provider: refusing('cyber_policy'),
        ...baseOpts(tracker),
      }).catch(() => undefined);
    }
    expect(tracker.getStatus('openai-chatgpt', 'k3')?.consecutiveFailures ?? 0).toBe(0);
    expect(tracker.isAvailable('openai-chatgpt', 'k3')).toBe(true);

    // Control: an ordinary invalid request is still recorded.
    await runProviderWithRetry({ provider: refusing(undefined), ...baseOpts(tracker) }).catch(
      () => undefined,
    );
    expect(tracker.getStatus('openai-chatgpt', 'k3')?.consecutiveFailures).toBe(1);
  });

  it('records successes so a healthy pair keeps its streak', async () => {
    const tracker = new ProviderModelStatusTracker();
    const ok = {
      id: 'kimi-for-coding',
      capabilities: { streaming: false, tools: true, vision: false },
      async complete(): Promise<Response> {
        return {
          content: [{ type: 'text', text: 'ok' }],
          stopReason: 'end_turn',
          usage: { input: 1, output: 1 },
        } as unknown as Response;
      },
    } as unknown as Provider;

    for (let i = 0; i < 3; i++) {
      await runProviderWithRetry({ provider: ok, ...baseOpts(tracker) });
    }

    expect(tracker.getStatus('kimi-for-coding', 'k3')?.totalSuccesses).toBe(3);
  });
});

describe('toWrongStackError cross-bundle passthrough', () => {
  it('duck-types a WrongStackError built against another bundle copy', () => {
    const foreign = new ForeignProviderError('kimi-for-coding', 403, {
      type: 'permission_error',
      message: KIMI_QUOTA_MESSAGE,
    });
    expect(foreign instanceof WrongStackError).toBe(false);
    expect(WrongStackError.isWrongStackError(foreign)).toBe(true);
  });
});
