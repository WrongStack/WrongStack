import {
  projectPopularProviderCatalog,
  type PopularProviderProjection,
} from '@wrongstack/providers/definitions';

export type PopularProvider = Omit<PopularProviderProjection, 'family'> & { family: string };

export const DEFAULT_POPULAR_PROVIDERS: PopularProvider[] = projectPopularProviderCatalog();

export async function loadPopularProviders(
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<PopularProvider[]> {
  try {
    const res = await fetch(sourceUrl, { signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) {
      throw new Error('Expected JSON array');
    }
    const valid = (data as PopularProvider[]).filter(
      (p): p is PopularProvider =>
        typeof p.id === 'string' && typeof p.name === 'string' && typeof p.family === 'string',
    );
    return valid.length > 0 ? valid : DEFAULT_POPULAR_PROVIDERS;
  } catch {
    return DEFAULT_POPULAR_PROVIDERS;
  }
}
