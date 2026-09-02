/**
 * Wrap an existing SAGE `MemoryPort` so that every `searchSage` /
 * `unifiedSearch` / `retrieveForAudience` call automatically injects
 * the supplied `VectorRecallProvider`. The wrapper preserves the
 * underlying port's identity for callers that compare ports, but routes
 * the read-side capability methods through a vector-augmented
 * `searchSage`.
 *
 * Why a wrapper and not a direct constructor change:
 *   - non-invasive: no migration needed for existing host construction
 *   - opt-in: hosts that don't want vector augmentation just don't wrap
 *   - testable: easy to mock the wrapper in unit tests
 *
 * The wrapper only augments paths that go through the read-side
 * capability (`getCapability(SAGE_RETRIEVAL_CAPABILITY)` /
 * `getCapability(SAGE_SURFACE_CAPABILITY)`). Other capabilities
 * (write-side, hygiene, audit) pass through unchanged so the wrapper
 * never widens the trust boundary.
 */
import type { MemoryPort } from '@wrongstack/core/types';
import {
  SAGE_RETRIEVAL_CAPABILITY,
  SAGE_SURFACE_CAPABILITY,
  type SageRetrievalCapability,
  type SageSurface,
  type VectorRecallProvider,
} from '@wrongstack/sage';

import type { VectorMemoryStore } from './store.js';

export interface VectorPortWrappingOptions {
  /** Vector store. The wrapper adapts it to the SAGE recall contract. */
  store: VectorMemoryStore;
  /**
   * Optional pre-built provider. When omitted, the wrapper builds one via
   * `asVectorRecallProvider(store)`.
   */
  vectorRecall?: VectorRecallProvider | undefined;
  /**
   * Cosine threshold forwarded to the vector backend. 0 = no threshold
   * (keep all hits, let RRF decide).
   */
  threshold?: number | undefined;
  /**
   * Weight of the vector channel in the RRF blend. Default 0.3.
   */
  weight?: number | undefined;
}

function mergeVectorRecall(
  options: Record<string, unknown> | undefined,
  recall: VectorRecallProvider,
  weight: number | undefined,
  threshold: number | undefined,
): Record<string, unknown> {
  // Caller's explicit vectorRecall wins — but we still inject the
  // provider when not set, so `searchSage(query)` and `searchSage(query,
  // { limit: 5 })` both get the augmentation for free.
  if (
    options &&
    typeof options === 'object' &&
    'vectorRecall' in options &&
    options['vectorRecall']
  ) {
    return options;
  }
  return {
    ...(options ?? {}),
    vectorRecall: recall,
    ...(weight !== undefined ? { vectorRecallWeight: weight } : {}),
    ...(threshold !== undefined ? { vectorRecallMinScore: threshold } : {}),
  };
}

/**
 * Adapt a `VectorMemoryStore` to the SAGE `VectorRecallProvider` contract.
 * Exported so the wrapper can be used directly by hosts that want a
 * custom provider without wrapping the whole port.
 */
export function asVectorRecallProviderAdapter(store: VectorMemoryStore): VectorRecallProvider {
  return {
    async search(query, opts) {
      const hits = await store.search(query, {
        limit: opts.limit,
        ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      });
      return hits.map((h) => ({
        id: h.entry.id,
        score: h.score,
        text: h.entry.text,
        ...(h.entry.summary ? { summary: h.entry.summary } : {}),
        tags: h.entry.tags,
        ...(h.entry.metadata ? { metadata: h.entry.metadata } : {}),
      }));
    },
  };
}

/**
 * Return a new `MemoryPort` that routes `searchSage` calls through the
 * supplied `VectorRecallProvider`. All other capabilities are passed
 * through unchanged.
 */
export function wrapMemoryPortWithVectorRecall(
  port: MemoryPort,
  options: VectorPortWrappingOptions,
): MemoryPort {
  const recall = options.vectorRecall ?? asVectorRecallProviderAdapter(options.store);
  const weight = options.weight;
  const threshold = options.threshold;

  // Generic search-wrapper: takes any (query, opts) => Promise<unknown>
  // function, merges the vector recall into the opts, and returns a
  // function with the same return type. Lets us wrap both
  // `searchSage` (returns `Sage[]`) and `searchSageWithBreakdown`
  // (returns `VectorAugmentHit[]`) with the same options-merge logic
  // — TypeScript can't unify those two return types, so the generic
  // helper is the cleanest path that doesn't lose precision.
  const wrapSearch = <F extends (query: string, opts?: unknown) => Promise<unknown>>(
    original: F,
  ): F => {
    return ((query: string, searchOpts?: unknown) =>
      original(
        query,
        mergeVectorRecall(
          searchOpts as Record<string, unknown> | undefined,
          recall,
          weight,
          threshold,
        ) as Parameters<F>[1],
      )) as unknown as F;
  };

  // Build the wrapper on the port's prototype chain, NOT via a plain
  // spread. `{ ...port }` copies only own enumerable properties: for a
  // class-instance port, `withTraceId` / `dispose` / `health` / `read` /
  // `remember` live on the prototype and a spread silently drops them —
  // the first direct method call after wrapping (e.g. boot's
  // `memoryStore.withTraceId(traceId)`) then crashes. Test fakes built
  // as object literals hide this; the E2E boot path exposed it
  // (memoryStore.withTraceId is not a function).
  const wrapped = Object.create(
    Object.getPrototypeOf(port),
    Object.getOwnPropertyDescriptors(port),
  ) as MemoryPort;
  wrapped.getCapability = <T>(capability: {
    id: string;
    readonly __memoryCapabilityType?: ((value: T) => T) | undefined;
  }): T | undefined => {
    if (capability.id === SAGE_RETRIEVAL_CAPABILITY.id) {
      const original = port.getCapability<SageRetrievalCapability>(capability as never);
      if (!original) return undefined;
      return {
        ...original,
        searchSage: wrapSearch(original.searchSage as never),
        // The rich-breakdown variant uses the same options-merge
        // helper — pass the vector recall through so consumers that
        // want the per-channel score breakdown get the same fusion
        // behaviour as `searchSage`.
        ...(original.searchSageWithBreakdown
          ? {
              searchSageWithBreakdown: wrapSearch(original.searchSageWithBreakdown as never),
            }
          : {}),
      } as unknown as T;
    }
    if (capability.id === SAGE_SURFACE_CAPABILITY.id) {
      const original = port.getCapability<SageSurface>(capability as never);
      if (!original) return undefined;
      return {
        ...original,
        searchSage: wrapSearch(original.searchSage as never),
        ...(original.searchSageWithBreakdown
          ? {
              searchSageWithBreakdown: wrapSearch(original.searchSageWithBreakdown as never),
            }
          : {}),
      } as unknown as T;
    }
    return port.getCapability<T>(capability as never);
  };
  return wrapped;
}
