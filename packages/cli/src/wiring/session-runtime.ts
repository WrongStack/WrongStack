/**
 * Session-runtime wiring for the interactive CLI (card #7C slice 4).
 *
 * Extracted verbatim from cli-main.ts. Owns the post-establishment session
 * surface:
 *
 * - `wireSessionEvents` (error ring, session bridge, chronicle) plus the
 *   `process.once('beforeExit')` hook that flushes the chronicle on the way
 *   out — the last teardown hook that lived inline in the orchestrator.
 * - `SessionStats` fed by the shared EventBus + token counter.
 * - The active reasoning-config refresher (best-effort modelsRegistry lookup)
 *   and the warning-dedup set behind `model-runtime` pipeline warnings.
 * - `setupPipelines` with the modelRuntime overlay, then the governance
 *   tool-boundary install when replay-governance is active.
 *
 * `getActiveReasoningConfig()` exposes the CURRENT reasoning config exactly
 * the way the orchestrator's inline `let` did when `runCliExecution` read it
 * by value at call time.
 */
import type { Context } from '@wrongstack/core/agent';
import type { Provider } from '@wrongstack/core/types';
import type { CliContext } from '../cli-context.js';
import { wireSessionEvents } from '../session-event-wiring.js';
import { SessionStats } from '../session-stats.js';
import { setupPipelines } from './pipeline.js';
import type { setupReplayAndGovernance } from './replay-governance-setup.js';

type WireArgs = Parameters<typeof wireSessionEvents>[0];
type GovernanceHandle = Awaited<ReturnType<typeof setupReplayAndGovernance>>['governanceHandle'];

interface SessionRuntimeArgs {
  evOn: WireArgs['evOn'];
  events: NonNullable<WireArgs['events']>;
  /** Live config binding; provider/model are read once at setup time. */
  config: CliContext['config'];
  context: Context;
  session: WireArgs['session'];
  sessionRef: WireArgs['sessionRef'];
  wpaths: WireArgs['wpaths'];
  projectRoot: WireArgs['projectRoot'];
  renderer: NonNullable<WireArgs['renderer']>;
  tuiOwnsScreen: boolean;
  tokenCounter: ConstructorParameters<typeof SessionStats>[1];
  modelsRegistry: CliContext['modelsRegistry'];
  configStore: CliContext['configStore'];
  provider: { capabilities: Provider['capabilities'] };
  logger: CliContext['logger'];
  governanceHandle: GovernanceHandle;
}

export function setupSessionRuntime(args: SessionRuntimeArgs) {
  const {
    evOn,
    events,
    config,
    context,
    session,
    sessionRef,
    wpaths,
    projectRoot,
    renderer,
    tuiOwnsScreen,
    tokenCounter,
    modelsRegistry,
    configStore,
    provider,
    logger,
    governanceHandle,
  } = args;

  const { errorRing, sessionBridge, disposeChronicle } = wireSessionEvents({
    evOn,
    events,
    config: config as unknown as Record<string, unknown>,
    context: context as unknown as Record<string, unknown>,
    session,
    sessionRef,
    wpaths,
    projectRoot,
    renderer,
    tuiOwnsScreen,
  });

  const stats = new SessionStats(events, tokenCounter);

  let activeReasoningConfig: import('@wrongstack/core/types').ReasoningConfig | undefined;
  const warnedRuntimeMessages = new Set<string>();
  const refreshActiveReasoningConfig = async (providerId: string, modelId: string) => {
    warnedRuntimeMessages.clear();
    try {
      const resolved = await modelsRegistry.getModel(providerId, modelId);
      activeReasoningConfig = resolved?.capabilities.reasoningConfig;
    } catch {
      activeReasoningConfig = undefined;
    }
  };
  void refreshActiveReasoningConfig(config.provider, config.model);

  const pipelines = setupPipelines({
    events,
    logger,
    modelRuntime: {
      getSettings: () => configStore.get().modelRuntime,
      getReasoningConfig: () => activeReasoningConfig,
      getCapabilities: () => provider.capabilities,
      onWarning: (message) => {
        if (warnedRuntimeMessages.has(message)) return;
        warnedRuntimeMessages.add(message);
        logger.warn(`model-runtime: ${message}`);
      },
    },
  });
  governanceHandle?.installToolBoundary(pipelines);

  // NOTE: `getActiveReasoningConfig` must be invoked at the consume site
  // (cli-main passes `getActiveReasoningConfig()` into runCliExecution), never
  // destructured eagerly at setup — early capture would freeze a stale value
  // and silently break model-switch reasoning propagation
  // (switchProviderAndModel → refreshActiveReasoningConfig would no longer
  // reach runCliExecution).
  return {
    errorRing,
    sessionBridge,
    stats,
    pipelines,
    refreshActiveReasoningConfig,
    getActiveReasoningConfig: () => activeReasoningConfig,
    /**
     * Lifecycle registration is intentionally NOT done here — this module is
     * reusable and must not install process-level hooks (chimera review).
     * The composition root owns `process.once('beforeExit', ...)` wiring.
     */
    disposeChronicle,
  };
}
