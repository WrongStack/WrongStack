import type { ModelsDevModel, ModelsRegistry } from '@wrongstack/core/types';

interface CatalogModelMatch {
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  description?: string | undefined;
  releaseDate?: string | undefined;
  contextWindow?: number | undefined;
  maxOutput?: number | undefined;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
  capabilities: string[];
}

interface RankedMatch {
  score: number;
  match: CatalogModelMatch;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function scoreModel(query: string, model: ModelsDevModel): number {
  const id = normalize(model.id);
  const name = normalize(model.name);
  if (id === query) return 1_000;
  if (name === query) return 950;
  if (id.startsWith(query)) return 800 - Math.min(id.length - query.length, 100);
  if (name.startsWith(query)) return 750 - Math.min(name.length - query.length, 100);
  const idIndex = id.indexOf(query);
  if (idIndex >= 0) return 600 - Math.min(idIndex, 100);
  const nameIndex = name.indexOf(query);
  if (nameIndex >= 0) return 550 - Math.min(nameIndex, 100);
  return 0;
}

function describeMatch(
  providerId: string,
  providerName: string,
  model: ModelsDevModel,
): CatalogModelMatch {
  return {
    providerId,
    providerName,
    modelId: model.id,
    name: model.name,
    ...(model.description !== undefined ? { description: model.description } : {}),
    ...(model.release_date !== undefined ? { releaseDate: model.release_date } : {}),
    ...(model.limit?.context !== undefined ? { contextWindow: model.limit.context } : {}),
    ...(model.limit?.output !== undefined ? { maxOutput: model.limit.output } : {}),
    ...(model.cost?.input !== undefined ? { inputCost: model.cost.input } : {}),
    ...(model.cost?.output !== undefined ? { outputCost: model.cost.output } : {}),
    capabilities: [
      ...(model.tool_call ? ['tools'] : []),
      ...(model.reasoning || model.reasoningConfig ? ['reasoning'] : []),
      ...(model.modalities?.input?.includes('image') ? ['vision'] : []),
      ...(model.open_weights ? ['open_weights'] : []),
    ],
  };
}

/** Search the loaded models.dev registry without sending the full catalog to the browser. */
export async function searchCatalogModels(
  registry: Pick<ModelsRegistry, 'listProviders'>,
  rawQuery: string,
  limit = 8,
): Promise<CatalogModelMatch[]> {
  const query = normalize(rawQuery);
  if (!query) return [];
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 20));
  const ranked: RankedMatch[] = [];
  for (const provider of await registry.listProviders()) {
    for (const model of provider.models) {
      const score = scoreModel(query, model);
      if (score <= 0) continue;
      ranked.push({
        score,
        match: describeMatch(provider.id, provider.name, model),
      });
    }
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.match.modelId.localeCompare(b.match.modelId) ||
      a.match.providerId.localeCompare(b.match.providerId),
  );
  return ranked.slice(0, boundedLimit).map(({ match }) => match);
}
