/**
 * Classifier for the smart agent dispatcher.
 *
 * Two implementations behind one seam:
 *
 *   - `makeTypeSafeDispatchClassifier` — one typed `Choice` over the candidate
 *     roles plus a `Noul` that can decline. Used when `fleet.dispatch
 *     .typesafeClassifier` is on and a `typesafe` account resolves.
 *   - `makeLLMClassifier` — the historical path: render a prompt, ask the
 *     session provider for prose, regex out the first `{...}`. Still the
 *     default, and still the fallback when TypeSafe is unconfigured.
 *
 * Either way the dispatcher only reaches a classifier when its keyword
 * heuristic is ambiguous, so this runs on a minority of dispatches.
 */

import type { Config } from '@wrongstack/contracts/types';
import type { DispatchClassifier } from '@wrongstack/core/coordination';
import { makeLLMClassifier, makeTypeSafeDispatchClassifier } from '@wrongstack/core/coordination';
import {
  resolveTypeSafeAccount,
  type WarnSink,
  warnFeatureUnusable,
  warnOnce,
} from '@wrongstack/core/typesafe';
import type { CommitLLMProvider } from './commit-message.js';

/**
 * Wrap the session provider in the `complete(prompt) => text` shape
 * `makeLLMClassifier` expects. Mirrors `generateCommitMessageWithLLM`.
 */
export function makeProviderClassifier(
  provider: CommitLLMProvider,
  model: string,
): DispatchClassifier {
  return makeLLMClassifier(async (prompt: string): Promise<string> => {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const resp = await provider.complete(
        {
          model,
          system: [
            {
              type: 'text',
              text:
                'You are an agent router. Choose the single best agent for the task. ' +
                'Reply with ONLY a compact JSON object {"role":"...","reason":"..."}.',
            },
          ],
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          temperature: 0,
        },
        { signal: ctrl.signal },
      );
      const content = resp.content;
      return Array.isArray(content) ? (content[0]?.text ?? '') : '';
    } catch {
      return '';
    } finally {
      clearTimeout(timeout);
    }
  });
}

/**
 * Pick the classifier this config asks for.
 *
 * Falls back to the provider classifier — never to nothing — when TypeSafe is
 * requested but unconfigured. A missing API key is a setup problem, not a
 * reason to lose the routing the user already had.
 */
export function makeDispatchClassifier(deps: {
  config: Config;
  provider: CommitLLMProvider;
  model: string;
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * Where the one-time "you asked for this and it is not running" line goes.
   * Only `warn` is required; `debug` carries per-request token accounting when
   * the host has somewhere to put it.
   */
  logger?: (WarnSink & { debug?(message: string): void }) | undefined;
}): DispatchClassifier {
  const dispatch = deps.config.fleet?.dispatch;
  if (deps.config.typesafe?.enabled === true && dispatch?.typesafeClassifier === true) {
    const account = resolveTypeSafeAccount({
      config: deps.config,
      env: deps.env,
      onUsage: (usage) =>
        deps.logger?.debug?.(
          `dispatch classifier: ${usage.inputTokens} input tokens (${usage.model ?? 'unknown model'})`,
        ),
      onDisabled: (reason) => warnOnce(deps.logger, reason),
    });
    if (account.status === 'ready') {
      return makeTypeSafeDispatchClassifier({
        client: account.client,
        model: deps.config.typesafe?.model,
        fitThreshold: dispatch.fitThreshold,
        minConfidence: dispatch.minConfidence,
      });
    }
    // Falling back to the prose classifier keeps the routing the user already
    // had — but they asked for the typed one, so say so once. Without this the
    // only difference a missing key makes is worse routing, silently.
    warnFeatureUnusable(deps.logger, 'fleet.dispatch.typesafeClassifier', account.reason);
  }
  return makeProviderClassifier(deps.provider, deps.model);
}
