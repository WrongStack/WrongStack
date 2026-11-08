/**
 * Provider-neutral one-shot, council, image and context-summary tools.
 *
 * The registration itself lives in `@wrongstack/runtime/provider-utility-tools`
 * so the standalone engine behind WebUI/desktop registers the same tools with
 * the same gates; this module keeps the CLI's import path and its own
 * resume-time provider adoption. The live model router and the Council
 * registries live there too: plugin `api.llm` (`@wrongstack/runtime/plugin-host`)
 * uses the same two helpers on every host.
 */

import type { Config } from '@wrongstack/contracts/types';

export {
  buildCouncilRegistries,
  createLiveModelRouter,
  type ProviderUtilityToolsInput,
  registerProviderUtilityTools,
} from '@wrongstack/runtime/provider-utility-tools';

export async function adoptResumedProvider(input: {
  resumedProvider?: string | undefined;
  resumedModel?: string | undefined;
  getConfig: () => Config;
  switchProviderAndModel: (providerId: string, modelId: string) => Promise<string | null>;
  logger: { warn(message: string): void };
}): Promise<void> {
  if (!input.resumedProvider && !input.resumedModel) return;
  const config = input.getConfig();
  const provider = input.resumedProvider?.trim() || config.provider;
  const model = input.resumedModel?.trim() || config.model;
  if (provider === config.provider && model === config.model) return;
  const error = await input.switchProviderAndModel(provider, model);
  if (error) {
    const current = input.getConfig();
    input.logger.warn(
      `Resume: could not switch to the session's model ${provider}/${model} (${error}); continuing with ${current.provider}/${current.model}.`,
    );
  }
}
