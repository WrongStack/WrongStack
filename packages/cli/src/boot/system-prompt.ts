// PR 4 of Issue #29: extract the modeId + modelCapabilities
// resolution block (the 35 lines that ran between the
// `wireContainer()` call and the `DefaultSystemPromptBuilder`
// binding) into a separate file.
//
// Why this split:
//
//   - This block is order-sensitive: setupProvider() must run
//     first (so we have a `provider.id` to pass to
//     `capabilitiesFor`), and the capabilities/model lookups
//     must run with `Promise.all` so they parallelize. Pulling
//     the wiring into a single `resolveModeAndCapabilities()`
//     call makes the order explicit and reviewable in one
//     place, instead of being scattered across the middle of
//     the 2,300-line main() body.
//
//   - The function is the *only* caller of `setupProvider`
//     in cli-main. Collapsing the 16-line try/catch + 3
//     destructurings into a single helper return means future
//     readers don't have to know the provider factory's
//     contract to follow the boot sequence.
//
//   - The `writeErr(...)` + `await reader.close()` + `return 2`
//     path on provider-resolution failure was duplicated
//     logic (the same shape appears later in main() for
//     other resolution failures). Lifting it to a single
//     return type (`{ kind: 'exit', code: 2 }` vs
//     `{ kind: 'ok', ... }`) means the caller can dispatch
//     on the kind without re-implementing the same teardown.
//
// What is *not* in this helper:
//
//   - The `DefaultSystemPromptBuilder` binding. That comes
//     *after* the mode and capabilities are resolved, and
//     depends on the container's services (memory store,
//     skill loader) plus a forward declaration
//     (`autonomyModeRef`) that the autonomy state machine
//     later mutates. Lifting the builder binding into
//     `resolveModeAndCapabilities` would force the helper
//     to know about the autonomy mode state, which is a
//     different concern. That part of the wiring stays in
//     main() for now and is targeted by a follow-up PR.
//
//   - The `setupProvider` retry / backoff logic. The
//     factory's call is wrapped in a single try/catch here;
//     any retry policy belongs in `setupProvider` itself, not
//     in this helper.

import type { ProviderRegistry } from '@wrongstack/core/registry';
import type { Config, Logger, ModelsRegistry, ResolvedProvider } from '@wrongstack/core/types';
import { mergeCustomModelDefs } from '@wrongstack/core/utils';
import { capabilitiesFor } from '@wrongstack/providers';
import { setupProvider } from '../wiring/provider.js';
import { awaitFirstWrongProxyProbe, bootstrapWrongProxy } from '../wiring/proxy-wiring.js';
import { getWrongTrace } from '../wiring/wrongtrace-gate.js';

export type ModeId = string;
export type ModePrompt = string;

export interface ModelCapabilities {
  maxContextTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
}

export type ResolvedModeResult =
  | {
      kind: 'ok';
      resolvedProvider: ResolvedProvider;
      providerRegistry: ProviderRegistry;
      provider: ReturnType<ProviderRegistry['create']>;
      modeId: ModeId;
      modePrompt: ModePrompt;
      modelCapabilities: ModelCapabilities | undefined;
    }
  | {
      kind: 'exit';
      code: 2;
      /** The error message that was written to stderr before
       *  the exit. Callers may want to log or display it
       *  before tearing down. */
      message: string;
    };

interface ResolveModeDeps {
  config: Config;
  modelsRegistry: ModelsRegistry;
  logger: Logger;
  /** Result of `container.resolve(TOKENS.ModeStore).getActiveMode()`. */
  activeMode: { id: string; prompt: string } | undefined | null;
}

/**
 * Run the three resolution steps that the system prompt
 * depends on:
 *
 *   1. `setupProvider({...})` \u2014 picks the provider for this run
 *      and returns the resolved `{ provider, providerRegistry,
 *      resolvedProvider }` triple. On failure, returns
 *      `{ kind: 'exit', code: 2, message }` so the caller can
 *      dispatch on the kind without re-implementing the
 *      teardown.
 *
 *   2. `capabilitiesFor(...)` + `modelsRegistry.getModel(...)`
 *      \u2014 run in parallel via `Promise.all` so the slow
 *      `getModel` doesn't block the (usually fast) `capabilitiesFor`
 *      or vice-versa. If either fails, we fall back to
 *      `undefined` modelCapabilities rather than crashing;
 *      the system prompt builder treats undefined as
 *      "don't include the model-aware hints".
 *
 *   3. Mode id + mode prompt extraction \u2014 falls back to
 *      `'default'` mode and an empty prompt when there's no
 *      active mode. The fallback is identical to the
 *      pre-refactor inline logic.
 *
 * The function is `async` because both `setupProvider` and
 * `capabilitiesFor` are async. The caller awaits the result
 * and dispatches on `result.kind`.
 */
export async function resolveModeAndCapabilities(
  deps: ResolveModeDeps,
): Promise<ResolvedModeResult> {
  let resolvedProvider: ResolvedProvider | undefined;
  let providerRegistry: ProviderRegistry;
  let provider: ReturnType<ProviderRegistry['create']>;
  try {
    // Seed the WrongProxy / WrongTrace singleton from the persisted
    // `tools.wrongProxy.{enabled,url}` block BEFORE setupProvider() runs.
    // Without this, the rewriter defaults to {enabled:false, active:false}
    // and the Provider gets the raw baseUrl baked in — so toggling the
    // WebUI/Settings toggle mid-session flips the probe's `active` flag
    // but the Provider transport still points at the upstream directly.
    // The probe boots inside bootstrapWrongProxy() and runs its first
    // /api/health check on the next macrotask, so by the time
    // resolveProviderCfg reads the singleton (synchronously inside
    // setupProvider) the URL is set; `active` will flip to true within
    // ~10ms of the first tick, which is fast enough that subsequent
    // request-batches see it. See proxy-rewrite.ts:51-59.
    bootstrapWrongProxy(deps.config.tools?.wrongProxy);
    // Warm the WrongTrace observability gate in the background — fire and
    // forget. Discovery has a 1s timeout and degrades to isAvailable:false,
    // so it can never stall boot (and we deliberately do NOT await here:
    // the awaitFirstWrongProxyProbe gate below is the only serialization
    // point this path tolerates). First preflightFileEdit() call reuses the
    // warmed singleton.
    void getWrongTrace();
    // Close the boot race that otherwise leaves the LEADER provider on the
    // raw URL even when the toggle is on: `bootstrapWrongProxy` sets
    // `enabled`/`url` synchronously, but the probe's first `/api/health`
    // check (which flips `active` → true) only resolves on a later
    // macrotask. `setupProvider` reads `getProxyConfig()` synchronously on
    // the very next line, so without this gate `shouldRewriteFor()` returns
    // false and the raw base URL is baked into the leader provider. This
    // mirrors the same gate `cli-main.ts:358` applies before
    // `setupProviderRuntime` — the leader boot path must do it too.
    await awaitFirstWrongProxyProbe();
    const result = await setupProvider({
      config: deps.config,
      modelsRegistry: deps.modelsRegistry,
      logger: deps.logger,
    });
    resolvedProvider = result.resolvedProvider;
    providerRegistry = result.providerRegistry;
    provider = result.provider;
  } catch (err) {
    return {
      kind: 'exit',
      code: 2,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (resolvedProvider == null) {
    return {
      kind: 'exit',
      code: 2,
      message: `setupProvider returned no resolved provider for ${deps.config.provider}`,
    };
  }

  const modeId = deps.activeMode?.id ?? 'default';
  const modePrompt = deps.activeMode?.prompt ?? '';

  const [resolvedCaps, resolvedModel] = await Promise.all([
    capabilitiesFor(
      deps.modelsRegistry,
      provider.id,
      deps.config.model,
      mergeCustomModelDefs(deps.config.providers?.[provider.id]?.customModels, deps.config.models),
    ).catch(() => undefined),
    deps.modelsRegistry.getModel(deps.config.provider, deps.config.model).catch(() => undefined),
  ]);

  // When the model isn't in the models.dev catalog (config-only providers such
  // as the OAuth subscription families openai-codex / anthropic-oauth /
  // github-copilot), `capabilitiesFor` falls back to the `unsupported` family
  // and would wrongly report no tools / 0 context. The provider INSTANCE was
  // built from the configured family and carries the correct capabilities, so
  // prefer it whenever the catalog has no entry for this model.
  const instanceCaps = provider.capabilities as typeof provider.capabilities | undefined;
  const useInstanceCaps = !resolvedModel && !!instanceCaps;
  const modelCapabilities: ModelCapabilities | undefined =
    resolvedCaps || useInstanceCaps
      ? {
          maxContextTokens:
            (useInstanceCaps ? instanceCaps?.maxContext : resolvedCaps?.maxContext) ||
            instanceCaps?.maxContext ||
            0,
          supportsTools: useInstanceCaps ? !!instanceCaps?.tools : (resolvedCaps?.tools ?? false),
          supportsVision: useInstanceCaps
            ? !!instanceCaps?.vision
            : (resolvedCaps?.vision ?? false),
          supportsReasoning:
            resolvedModel?.capabilities.reasoning ?? instanceCaps?.reasoning ?? false,
        }
      : undefined;

  return {
    kind: 'ok',
    resolvedProvider,
    providerRegistry,
    provider,
    modeId,
    modePrompt,
    modelCapabilities,
  };
}
