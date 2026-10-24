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
import type { MemoryPort } from '@wrongstack/contracts/types';
import {
  augmentLexicalWithVectorRecall,
  isSageVisibleForSearch,
  SAGE_RETRIEVAL_CAPABILITY,
  SAGE_SERVICE_CAPABILITY,
  SAGE_SURFACE_CAPABILITY,
  type Sage,
  type SageSearchOptions,
  type SageSurface,
  type VectorAugmentHit,
  type VectorRecallProvider,
} from '@wrongstack/sage';

import type { VectorMemoryStore } from './store.js';

/** The part of a SAGE read capability the wrapper replaces. */
interface SearchCapabilityShape {
  searchSage: (...args: never[]) => unknown;
  searchSageWithBreakdown?: ((...args: never[]) => unknown) | undefined;
}

function delegateWithOverrides<T extends object>(original: T, overrides: Partial<T>): T {
  const methods = new WeakMap<object, unknown>();
  const delegated = new Proxy(original, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
      const value = Reflect.get(target, key, target);
      if (key === 'constructor' || typeof value !== 'function' || Object.hasOwn(target, key)) {
        return value;
      }
      let bound = methods.get(value);
      if (bound === undefined) {
        bound = (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          return result === target ? delegated : result;
        };
        methods.set(value, bound);
      }
      return bound;
    },
  });
  return delegated;
}

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
        ...(h.entry.summary !== undefined ? { summary: h.entry.summary } : {}),
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

  const fusionOptions = (searchOpts: SageSearchOptions | undefined) => {
    const vectorWeight = searchOpts?.vectorRecallWeight ?? options.weight;
    const threshold = searchOpts?.vectorRecallMinScore ?? options.threshold;
    const vectorOnlyThreshold = searchOpts?.vectorRecallThreshold ?? options.vectorOnlyThreshold;
    return {
      vectorRecall: recall,
      vectorCandidateLimit: searchOpts?.vectorCandidateLimit,
      materializeVectorOnly: materializeFor(searchOpts),
      ...(vectorWeight !== undefined ? { vectorWeight } : {}),
      ...(threshold !== undefined ? { threshold } : {}),
      ...(vectorOnlyThreshold !== undefined ? { vectorOnlyThreshold } : {}),
      ...(options.maxMaterializations !== undefined
        ? { maxMaterializations: options.maxMaterializations }
        : {}),
      ...(searchOpts?.limit !== undefined ? { limit: searchOpts.limit } : {}),
    };
  };

  /**
   * A caller that supplied its own `vectorRecall` has opted into the
   * store-side fusion path explicitly (and is therefore talking to an
   * in-process store); double-fusing would rank the same hits twice.
   */
  const callerOwnsFusion = (searchOpts: SageSearchOptions | undefined): boolean =>
    typeof (searchOpts?.vectorRecall as { search?: unknown } | undefined)?.search === 'function';

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

  // Delegate lifecycle and capability members to their original receivers:
  // copying a prototype does not copy native private-field branding or state.
  const wrapSearchCapability = <C extends SearchCapabilityShape>(original: C): C => {
    const overrides: Partial<SearchCapabilityShape> = {
      searchSage: wrapSearchSage(original.searchSage.bind(original) as never),
    };
    if (original.searchSageWithBreakdown) {
      overrides.searchSageWithBreakdown = wrapSearchWithBreakdown(
        original.searchSageWithBreakdown.bind(original) as never,
      );
    }
    return delegateWithOverrides(original, overrides as Partial<C>);
  };

  // Every read-side capability that exposes `searchSage` is wrapped. The
  // service capability is included on purpose: the agent's memory tools
  // (`memory_search`, `memory_search_explain`) are built from it, so leaving
  // it unwrapped meant the model's own searches never reached the semantic
  // channel even on hosts where injection did.
  const wrappedCapabilityIds = new Set([
    SAGE_RETRIEVAL_CAPABILITY.id,
    SAGE_SURFACE_CAPABILITY.id,
    SAGE_SERVICE_CAPABILITY.id,
  ]);
  const getCapability = <T>(capability: {
    id: string;
    readonly __memoryCapabilityType?: ((value: T) => T) | undefined;
  }): T | undefined => {
    if (wrappedCapabilityIds.has(capability.id)) {
      const original = port.getCapability<SearchCapabilityShape>(capability as never);
      if (!original || typeof original.searchSage !== 'function') {
        return original as unknown as T | undefined;
      }
      return wrapSearchCapability(original) as unknown as T;
    }
    return port.getCapability<T>(capability as never);
  };
  return delegateWithOverrides(port, { getCapability });
}
