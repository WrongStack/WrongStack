import type { Config } from '@wrongstack/contracts/types/config';
import type { MetricsSinkView, PluginJev } from '@wrongstack/contracts/types/plugin';
import { callWithDeadline } from '../execution/llm-call-deadline.js';

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_TIMEOUT_MS = 30_000;

/** Resolve the shared account only when a first-party plugin requests a judgment. */
export function makePluginJev(
  owner: string,
  getConfig: () => Config,
  metrics: MetricsSinkView,
  isBlocked: () => boolean,
  lifecycleSignal: AbortSignal,
): PluginJev {
  return {
    async judge(input, opts) {
      lifecycleSignal.throwIfAborted();
      opts?.signal?.throwIfAborted();
      if (isBlocked()) {
        throw Object.assign(new Error('Jev unavailable (tool disabled or restricted)'), {
          code: 'JEV_UNAVAILABLE' as const,
        });
      }
      const [{ resolveTypeSafeJudge }, { evaluateJevQuestions }] = await Promise.all([
        import('../typesafe/judgments.js'),
        import('../typesafe/jev-tool.js'),
      ]);
      const judge = resolveTypeSafeJudge({ config: getConfig(), feature: 'tool' });
      if (!judge || judge.unavailableReason) {
        throw Object.assign(
          new Error(
            `Jev unavailable (${judge?.unavailableReason ?? 'disabled or account missing'})`,
          ),
          { code: 'JEV_UNAVAILABLE' as const },
        );
      }
      const timeoutMs =
        typeof opts?.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)
          ? Math.min(MAX_TIMEOUT_MS, Math.max(1, opts.timeoutMs))
          : DEFAULT_TIMEOUT_MS;
      metrics.counter('jev.calls');
      try {
        const parentSignal = opts?.signal
          ? AbortSignal.any([opts.signal, lifecycleSignal])
          : lifecycleSignal;
        const result = await callWithDeadline(
          (signal) => evaluateJevQuestions(input, judge, signal, `plugin:${owner}`),
          parentSignal,
          timeoutMs,
          `Plugin "${owner}" Jev request timed out`,
        );
        metrics.counter('jev.answers');
        return result;
      } catch (error) {
        metrics.counter('jev.errors');
        throw error;
      }
    },
  };
}
