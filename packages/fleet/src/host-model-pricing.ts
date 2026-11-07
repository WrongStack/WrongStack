import type { MultiAgentDeps } from './host-types.js';

/** Match the configured model's rates, including user overrides absent from the catalog. */
export async function resolveHostModelPrice(
  deps: Pick<MultiAgentDeps, 'modelsRegistry' | 'configStore'>,
  provider: string,
  model: string,
) {
  // Pricing metadata must not make a configured worker depend on catalog availability.
  const catalog = (await deps.modelsRegistry?.getModel(provider, model).catch(() => undefined))
    ?.cost;
  const custom =
    deps.configStore.get().providers?.[provider]?.customModels?.[model]?.modelsDev?.['cost'];
  const overrides =
    custom && typeof custom === 'object' && !Array.isArray(custom)
      ? (custom as Record<string, unknown>)
      : {};
  const cost = { ...catalog, ...overrides };
  const rate = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const input = rate(cost['input']),
    output = rate(cost['output']);
  const cacheRead = rate(cost['cache_read'] ?? input),
    cacheWrite = rate(cost['cache_write'] ?? input);
  if ([input, output, cacheRead, cacheWrite].every((value) => value === undefined))
    return undefined;
  return { input, output, cacheRead, cacheWrite };
}
