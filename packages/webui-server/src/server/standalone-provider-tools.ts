/**
 * The provider-backed tools of the standalone engine (WebUI server / desktop).
 *
 * CLI parity: `cli-main-boot.ts` registers `llm`, `council` and
 * `image_generate` through `registerProviderUtilityTools`, and
 * `cli-infrastructure.ts` registers `jev` / `jev_status` through
 * `registerJevTools`. Both are shared code; this module only supplies the
 * standalone's answers for the provider builder, the provider-runner chain and
 * the config store. Without it the desktop's generated-images card never had an
 * image to show and its Jev settings configured a tool the engine never offered.
 *
 * The SAGE `memory-curator` call shares the same provider chain, so it is built
 * here too.
 */

import { type Container, TOKENS } from '@wrongstack/contracts/kernel';
import type {
  Config,
  ConfigStore,
  ModelsRegistry,
  OneShotOrchestratorOptions,
} from '@wrongstack/contracts/types';
import type { Agent, FallbackProfileManager } from '@wrongstack/core/agent';
import type { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { registerProviderUtilityTools } from '@wrongstack/runtime/provider-utility-tools';
import { createMemoryCuratorLlmCall, type LlmCallFn } from '@wrongstack/sage';
import { registerJevTools } from '@wrongstack/tools/management';
import { buildSavedProvider } from './saved-provider.js';

type Compactor = Parameters<typeof registerProviderUtilityTools>[0]['compactor'];

export interface StandaloneProviderToolsInput {
  agent: Agent;
  container: Container;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  modelsRegistry: Pick<ModelsRegistry, 'getProvider'>;
  compactor: Compactor;
  /** The LIVE config: providers added or switched mid-session count. */
  getConfig: () => Config;
  /** Jev registration follows `typesafe` edits through the store's watch. */
  configStore?: ConfigStore | undefined;
}

export interface StandaloneProviderTools {
  /** SAGE background passes on the `memory-curator` route; absent without a fallback manager. */
  memoryCuratorLlm: LlmCallFn | undefined;
  /** Stops following config edits (the Jev registration watch). */
  dispose(): void;
}

export function installStandaloneProviderTools(
  input: StandaloneProviderToolsInput,
): StandaloneProviderTools {
  const { agent, container, toolRegistry, providerRegistry, getConfig } = input;
  const stopJev = input.configStore
    ? registerJevTools(toolRegistry, input.configStore)
    : () => undefined;
  const fallbackProfileManager = container.safeResolve(TOKENS.FallbackProfileManager);
  if (!fallbackProfileManager) return { memoryCuratorLlm: undefined, dispose: stopJev };
  // Providers are built with the Brain's saved-config rule (the primary's key
  // never leaks to another vendor), from the config as it is NOW.
  const buildProvider = (providerId: string) =>
    buildSavedProvider(providerRegistry, getConfig(), providerId);
  const statusTracker = container.safeResolve(TOKENS.ProviderModelStatusTracker);
  // Every one-shot call runs the agent's provider-runner chain (prompt
  // firewall, cache, router), minus the conversation's own model fallback.
  const wrapProviderCall: NonNullable<OneShotOrchestratorOptions['wrapProviderCall']> = (
    request,
    inner,
  ) =>
    agent.extensions.wrapProviderRunner(
      (_ctx: typeof agent.ctx, wrapped: typeof request) => inner(wrapped),
      { exclude: ['fallback-model'] },
    )(agent.ctx, request);
  registerProviderUtilityTools({
    toolRegistry,
    buildProvider,
    getConfig,
    // The container binds the runtime's concrete manager under the port token.
    fallbackProfileManager: fallbackProfileManager as FallbackProfileManager,
    statusTracker,
    wrapProviderCall,
    compactor: input.compactor,
    modelsRegistry: input.modelsRegistry,
  });
  const memoryCuratorLlm = createMemoryCuratorLlmCall({
    buildProvider,
    getConfig,
    fallbackProfileManager,
    statusTracker,
    wrapProviderCall,
  });
  return { memoryCuratorLlm, dispose: stopJev };
}
