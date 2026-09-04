/**
 * Wrap an existing SAGE `MemoryPort` so that every `searchSage` /
 * `searchSageWithBreakdown` call fuses the port's lexical candidate set with
 * a semantic recall from the local vector store.
 *
 * Why a wrapper and not a direct constructor change:
 *   - non-invasive: no migration needed for existing host construction
 *   - opt-in: hosts that don't want vector augmentation just don't wrap
 *   - testable: easy to mock the wrapper in unit tests
 *
 * ## Why the fusion runs HERE and not inside the store
 *
 * The historical implementation merged a `vectorRecall` provider into the
 * search *options* and let `SqliteSageStore.searchSage` do the fusion. That
 * works only when the store is in-process. In production it is not: hosts
 * build the port with `createProjectSageMemoryPort`, which returns a
 * `ProjectSageMemoryPort` speaking line-delimited JSON to the per-project
 * SAGE daemon (`encodeSageProjectServerMessage` = `JSON.stringify`).
 * `JSON.stringify({ vectorRecall: { search: fn } })` yields
 * `{"vectorRecall":{}}` — functions do not survive the wire — so the daemon
 * saw a truthy-but-empty provider, threw `search is not a function` inside
 * the fusion's fail-open `try`, and silently returned the lexical list.
 * The entire semantic channel was dead in every production surface while
 * every diagnostic reported it as wired.
 *
 * The vector store also *cannot* simply move into the daemon: it owns an
 * ONNX embedding provider and `@wrongstack/vector-memory` already depends on
 * `@wrongstack/sage`, so wiring it the other way is a dependency cycle.
 *
 * So the fusion runs on the host side of the boundary:
 *   1. call the port's `searchSage` (remote or in-process) for the lexical list
 *   2. query the local vector store for the semantic list
 *   3. fuse with RRF via `augmentLexicalWithVectorRecall`
 *   4. resolve vector-only hits by id through the port's surface capability,
 *      re-applying every visibility rule the lexical channel enforces in SQL
 *      (`isSageVisibleForSearch`)
 *
 * Step 4 is one round-trip per admitted vector-only hit, which is why the
 * fusion is called with a `maxMaterializations` bound.
 *
 * The wrapper only augments read-side capabilities
 * (`SAGE_RETRIEVAL_CAPABILITY` / `SAGE_SURFACE_CAPABILITY`). Other
 * capabilities (write-side, hygiene, audit) pass through unchanged so the
 * wrapper never widens the trust boundary.
 */
import type { MemoryPort } from '@wrongstack/core/types';
import {
  augmentLexicalWithVectorRecall,
  isSageVisibleForSearch,
  SAGE_RETRIEVAL_CAPABILITY,
  SAGE_SURFACE_CAPABILITY,
  type Sage,
  type SageRetrievalCapability,
  type SageSearchOptions,
  type SageSurface,
  type VectorAugmentHit,
  type VectorRecallProvider,
} from '@wrongstack/sage';

import type { VectorMemoryStore } from './store.js';

export interface VectorPortWrappingOptions {
  /** Vector store. The wrapper adapts it to the SAGE recall contract. */
  store: VectorMemoryStore;
  /**
   * Optional pre-built provider. When omitted, the wrapper builds one via
   * `asVectorRecallProviderAdapter(store)`.
   */
  vectorRecall?: VectorRecallProvider | undefined;
  /**
   * Cosine threshold forwarded to the vector backend. Undefined = no
   * threshold (keep all hits, let RRF decide).
   */
  threshold?: number | undefined;
  /**
   * Weight of the vector channel in the RRF blend. Default 0.3.
   */
  weight?: number | undefined;
  /**
   * Cosine floor a semantic-only hit must clear before it is resolved and
   * admitted. Falls back to the fusion's own default (0.62).
   */
  vectorOnlyThreshold?: number | undefined;
  /**
   * Cap on by-id resolutions of semantic-only hits per search. Each one is a
   * round-trip when the port is remote. Falls back to the fusion default.
   */
  maxMaterializations?: number | undefined;
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
 * Return a new `MemoryPort` whose `searchSage` / `searchSageWithBreakdown`
 * fuse lexical and semantic recall. All other capabilities pass through
 * unchanged.
 */
export function wrapMemoryPortWithVectorRecall(
  port: MemoryPort,
  options: VectorPortWrappingOptions,
): MemoryPort {
  const recall = options.vectorRecall ?? asVectorRecallProviderAdapter(options.store);

  // Resolve a semantic-only hit by id, then re-apply the lexical channel's
  // visibility rules. `getSage` is a raw primary-key read — it knows nothing
  // about status filters, audience scoping, `contextPolicy: 'never'` or
  // session ownership — so skipping this check would make the vector channel
  // a hole in session isolation.
  const materializeFor =
    (searchOpts: SageSearchOptions | undefined) =>
    async (sageId: string): Promise<Sage | undefined> => {
      const surface = port.getCapability<SageSurface>(SAGE_SURFACE_CAPABILITY);
      if (!surface?.getSage) return undefined;
      const memory = await surface.getSage(sageId);
      if (!memory) return undefined;
      return isSageVisibleForSearch(memory, searchOpts) ? memory : undefined;
    };

  const fusionOptions = (searchOpts: SageSearchOptions | undefined) => ({
    vectorRecall: recall,
    materializeVectorOnly: materializeFor(searchOpts),
    ...(options.weight !== undefined ? { vectorWeight: options.weight } : {}),
    ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
    ...(options.vectorOnlyThreshold !== undefined
      ? { vectorOnlyThreshold: options.vectorOnlyThreshold }
      : {}),
    ...(options.maxMaterializations !== undefined
      ? { maxMaterializations: options.maxMaterializations }
      : {}),
    ...(searchOpts?.limit !== undefined ? { limit: searchOpts.limit } : {}),
  });

  /**
   * A caller that supplied its own `vectorRecall` has opted into the
   * store-side fusion path explicitly (and is therefore talking to an
   * in-process store); double-fusing would rank the same hits twice.
   */
  const callerOwnsFusion = (searchOpts: SageSearchOptions | undefined): boolean =>
    Boolean(searchOpts?.vectorRecall);

  const wrapSearchSage =
    (original: (query: string, opts?: unknown) => Promise<Sage[]>) =>
    async (query: string, searchOpts?: unknown): Promise<Sage[]> => {
      const opts = searchOpts as SageSearchOptions | undefined;
      const lexical = await original(query, searchOpts);
      if (callerOwnsFusion(opts)) return lexical;
      const fused = await augmentLexicalWithVectorRecall(query, lexical, fusionOptions(opts));
      return fused.map((hit) => hit.memory);
    };

  const wrapSearchWithBreakdown =
    (original: (query: string, opts?: unknown) => Promise<VectorAugmentHit[]>) =>
    async (query: string, searchOpts?: unknown): Promise<VectorAugmentHit[]> => {
      const opts = searchOpts as SageSearchOptions | undefined;
      const lexicalHits = await original(query, searchOpts);
      if (callerOwnsFusion(opts)) return lexicalHits;
      return augmentLexicalWithVectorRecall(
        query,
        lexicalHits.map((hit) => hit.memory),
        fusionOptions(opts),
      );
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
        searchSage: wrapSearchSage(original.searchSage as never),
        ...(original.searchSageWithBreakdown
          ? {
              searchSageWithBreakdown: wrapSearchWithBreakdown(
                original.searchSageWithBreakdown as never,
              ),
            }
          : {}),
      } as unknown as T;
    }
    if (capability.id === SAGE_SURFACE_CAPABILITY.id) {
      const original = port.getCapability<SageSurface>(capability as never);
      if (!original) return undefined;
      return {
        ...original,
        searchSage: wrapSearchSage(original.searchSage as never),
        ...(original.searchSageWithBreakdown
          ? {
              searchSageWithBreakdown: wrapSearchWithBreakdown(
                original.searchSageWithBreakdown as never,
              ),
            }
          : {}),
      } as unknown as T;
    }
    return port.getCapability<T>(capability as never);
  };
  return wrapped;
}
