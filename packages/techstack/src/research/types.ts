/**
 * TechStack — Research stage contracts.
 *
 * The research stage is the "agents for interpretation" half of the SDD's
 * guiding principle (§31): the inventory, version comparison, and advisory
 * matching are deterministic; the LLM only answers contextual questions the
 * registry cannot ("is this major bump breaking?", "what replaces this dead
 * package?", "does this CVE apply to how we use it?").
 *
 * Everything here is expressed as a narrow injected port so the engine stays
 * unit-testable with fakes and `packages/techstack` never reaches for a live
 * provider or the network on its own.
 *
 * @see docs/specs/techstack-sdd.md §4.2, §31, §472, §557
 */

import type { DependencyObservation, Finding } from '../types.js';

// ── Clusters ──────────────────────────────────────────────────────────────

/**
 * Research clusters, per SDD §557 — group by finding-type rather than by
 * ecosystem so one prompt can answer one kind of question well, and the agent
 * count stays bounded regardless of how many ecosystems the repo mixes.
 */
export type ResearchCluster = 'breaking_change' | 'replacement' | 'vulnerability';

/** A dependency selected by triage, with the question it needs answered. */
export interface TriageCandidate {
  readonly dependency: DependencyObservation;
  readonly cluster: ResearchCluster;
  /** Higher runs first and survives the cap. Deterministic — see `triage.ts`. */
  readonly priority: number;
}

// ── Ports ─────────────────────────────────────────────────────────────────

/** One web-search hit. Mirrors the shape `searchTool` returns. */
export interface ResearchSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/**
 * Web search port. Implementations must resolve to `[]` rather than throw —
 * search is scraped best-effort (`packages/tools/src/search.ts` has no API
 * key and can legitimately return nothing), and a dry search must degrade the
 * finding, never fail the job.
 */
export type ResearchSearch = (
  query: string,
  opts: { readonly signal?: AbortSignal | undefined },
) => Promise<readonly ResearchSearchResult[]>;

/** A single structured LLM request. */
export interface ResearchLlmRequest {
  readonly system: string;
  readonly prompt: string;
  /** JSON Schema the response should conform to, when the provider supports it. */
  readonly schema: Record<string, unknown>;
  readonly schemaName: string;
  readonly maxTokens: number;
  readonly signal?: AbortSignal | undefined;
}

/**
 * LLM port. Returns the raw response text (JSON, possibly fenced) — parsing
 * lives in `llm.ts` so fakes stay trivial to write.
 */
export type ResearchLlm = (req: ResearchLlmRequest) => Promise<string>;

// ── Researcher ────────────────────────────────────────────────────────────

/**
 * Per-dependency streaming partial surfaced from the research stage so the
 * caller can update UI as each triage candidate is processed.
 *
 * `dependencyId` is absent for the cluster-level "starting / finished" emit
 * (one per cluster) and present for every per-dependency partial inside the
 * cluster (one per `TriageCandidate` the researcher processes).
 */
export interface ResearchPartial {
  readonly dependencyId?: string | undefined;
  readonly cluster: ResearchCluster;
  readonly completed: number;
  readonly total: number;
}

export interface ResearchOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((completed: number, total: number) => void) | undefined;
  readonly onPartial?: ((partial: ResearchPartial) => void) | undefined;
}

/**
 * The seam `TechStackEngine.analyze()` calls during the `researching` /
 * `synthesizing` phases.
 *
 * Contract: returns *only* `Finding`s. `Finding` structurally cannot carry
 * `latestStable` / `locked` / `requested`, which is how SDD §472 ("LLM
 * fabricating version numbers") is enforced by the type system rather than by
 * review. The engine appends these to `snapshot.findings` and never lets them
 * touch `snapshot.dependencies`.
 */
export interface TechStackResearcher {
  research(
    candidates: readonly TriageCandidate[],
    opts?: ResearchOptions,
  ): Promise<readonly Finding[]>;
}
