/**
 * TechStack — the research stage.
 *
 * Takes the deterministic snapshot's problem cases (see `triage.ts`), gathers
 * public context for them via web search, and asks the LLM the one question
 * the registry cannot answer: *what should I actually do about this?*
 *
 * Structure follows SDD §557 — one pass per finding-type cluster
 * (breaking-change / replacement / CVE-applicability), not one per package and
 * not one per ecosystem. That keeps the call count at ≤3 per analyze while
 * still letting each prompt be a focused specialist.
 *
 * @see docs/specs/techstack-sdd.md §31, §472, §557
 */

import type { DependencyObservation, Evidence, Finding } from '../types.js';
import { parseResearchJson } from './llm.js';
import { clusterCandidates } from './triage.js';
import type {
  ResearchCluster,
  ResearchLlm,
  ResearchOptions,
  ResearchSearch,
  ResearchSearchResult,
  TechStackResearcher,
  TriageCandidate,
} from './types.js';

// ── Tunables ──────────────────────────────────────────────────────────────

const SEARCH_CONCURRENCY = 4;
const MAX_SNIPPET_CHARS = 320;
const MAX_TOKENS_PER_CLUSTER = 2_000;

/**
 * Confidence ceiling for anything the LLM produced. `1.0` is reserved for
 * deterministic findings (registry/OSV facts) — an interpretation must never
 * be able to present itself as a fact, however sure the model claims to be.
 */
const MAX_LLM_CONFIDENCE = 0.95;
const MIN_LLM_CONFIDENCE = 0.1;
const DEFAULT_LLM_CONFIDENCE = 0.5;

const FINDING_TYPE_BY_CLUSTER: Record<ResearchCluster, Finding['type']> = {
  breaking_change: 'upgrade',
  replacement: 'replacement',
  vulnerability: 'vulnerability',
};

const VALID_SEVERITIES: ReadonlySet<string> = new Set([
  'info',
  'low',
  'medium',
  'high',
  'critical',
]);

const VALID_ACTIONS: ReadonlySet<string> = new Set([
  'none',
  'upgrade_patch',
  'upgrade_minor',
  'upgrade_major',
  'replace',
  'remove',
  'investigate',
]);

// ── Prompts ───────────────────────────────────────────────────────────────

const SHARED_RULES = [
  'Return only JSON. No markdown, prose, or code fences.',
  'Only reason about the packages listed in the input. Never introduce a package that is not listed.',
  'Never state or guess version numbers other than the ones given to you; the version facts are already established.',
  'If the provided sources do not support a conclusion, say so in the rationale and lower the confidence.',
  'Be concrete and short. The reader is an engineer deciding what to do this afternoon.',
].join('\n');

const SYSTEM_BY_CLUSTER: Record<ResearchCluster, string> = {
  breaking_change: [
    'You assess upgrade risk for software dependencies.',
    'For each package, judge how disruptive moving to the latest version would be for a typical consumer,',
    'and what the migration actually involves.',
    SHARED_RULES,
  ].join('\n'),
  replacement: [
    'You advise on deprecated, yanked, and unmaintained software dependencies.',
    'For each package, say whether it should be replaced, what the community has moved to, and how urgent it is.',
    'Prefer platform-native or well-maintained successors. If the package is fine to keep, say so plainly.',
    SHARED_RULES,
  ].join('\n'),
  vulnerability: [
    'You triage security advisories for software dependencies.',
    'For each package, judge how exploitable the known advisory is in practice and what the fix is.',
    'Distinguish advisories that require unusual usage from ones that affect every consumer.',
    SHARED_RULES,
  ].join('\n'),
};

const QUESTION_BY_CLUSTER: Record<ResearchCluster, string> = {
  breaking_change: 'How breaking is this upgrade, and what does the migration involve?',
  replacement: 'Should this be replaced, and with what?',
  vulnerability: 'Does this advisory realistically affect a consumer, and what is the fix?',
};

const RESEARCH_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          package: { type: 'string', description: 'Exact package name from the input list.' },
          severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
          action: {
            type: 'string',
            enum: [
              'none',
              'upgrade_patch',
              'upgrade_minor',
              'upgrade_major',
              'replace',
              'remove',
              'investigate',
            ],
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          rationale: { type: 'string' },
          breakingRisk: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
        },
        required: ['package', 'severity', 'action', 'confidence', 'rationale'],
      },
    },
  },
  required: ['findings'],
};

// ── Search queries ────────────────────────────────────────────────────────

function searchQuery(candidate: TriageCandidate): string {
  const dep = candidate.dependency;
  const from = dep.locked ?? dep.requested ?? '';
  const to = dep.latestStable ?? '';
  switch (candidate.cluster) {
    case 'breaking_change':
      return `${dep.name} ${from} to ${to} migration guide breaking changes`;
    case 'replacement':
      return `${dep.name} ${dep.ecosystem} deprecated recommended alternative replacement`;
    case 'vulnerability':
      return `${dep.name} ${from} security advisory CVE affected versions`;
  }
}

/** Run `task` over `items` with bounded concurrency, preserving order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await task(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Prompt assembly ───────────────────────────────────────────────────────

function describeDependency(dep: DependencyObservation): string {
  const bits = [
    `ecosystem: ${dep.ecosystem}`,
    `installed: ${dep.locked ?? dep.installed ?? dep.requested ?? 'unknown'}`,
  ];
  if (dep.latestStable) bits.push(`latest stable: ${dep.latestStable}`);
  if (dep.requested) bits.push(`constraint: ${dep.requested}`);
  bits.push(dep.direct ? 'direct dependency' : 'transitive dependency');
  bits.push(`scope: ${dep.scope}`);
  if (dep.license) bits.push(`license: ${dep.license}`);
  if (dep.deprecated) bits.push('registry flag: deprecated');
  if (dep.yanked) bits.push('registry flag: yanked');
  bits.push(`status: ${dep.status}`);
  return bits.join(', ');
}

function renderSources(results: readonly ResearchSearchResult[]): string {
  if (results.length === 0) return '  (no sources found — say so and lower confidence)';
  return results
    .map((r) => `  - ${r.title}\n    ${r.url}\n    ${truncate(r.snippet, MAX_SNIPPET_CHARS)}`)
    .join('\n');
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

function buildPrompt(
  cluster: ResearchCluster,
  entries: readonly { candidate: TriageCandidate; sources: readonly ResearchSearchResult[] }[],
): string {
  const blocks = entries.map(({ candidate, sources }, i) =>
    [
      `${i + 1}. ${candidate.dependency.name}`,
      `   ${describeDependency(candidate.dependency)}`,
      '   Web search results:',
      renderSources(sources),
    ].join('\n'),
  );

  return [
    `Question for every package below: ${QUESTION_BY_CLUSTER[cluster]}`,
    '',
    'Packages:',
    ...blocks,
    '',
    'Return JSON shaped exactly as:',
    '{"findings":[{"package":"exact-name-from-the-list","severity":"medium","action":"upgrade_major",' +
      '"confidence":0.7,"rationale":"one or two sentences","breakingRisk":"optional short note",' +
      '"sources":["https://…"]}]}',
    '',
    'Emit one entry per package you can say something useful about. Omit packages you cannot.',
  ].join('\n');
}

// ── Response → Finding ────────────────────────────────────────────────────

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LLM_CONFIDENCE;
  return Math.min(MAX_LLM_CONFIDENCE, Math.max(MIN_LLM_CONFIDENCE, value));
}

function sourceEvidence(
  raw: unknown,
  sources: readonly ResearchSearchResult[],
  retrievedAt: string,
): Evidence[] {
  const known = new Set(sources.map((s) => s.url));
  const cited = Array.isArray(raw)
    ? raw.filter((u): u is string => typeof u === 'string' && known.has(u))
    : [];
  // Fall back to everything we actually fetched when the model cited nothing —
  // the user still deserves to see what the interpretation was based on.
  const urls = cited.length > 0 ? cited : sources.map((s) => s.url);
  return urls.map((url) => ({
    kind: 'agent' as const,
    source: url,
    retrievedAt,
    detail: sources.find((s) => s.url === url)?.title,
  }));
}

function toFinding(
  raw: Record<string, unknown>,
  cluster: ResearchCluster,
  byName: ReadonlyMap<
    string,
    { candidate: TriageCandidate; sources: readonly ResearchSearchResult[] }
  >,
  retrievedAt: string,
): Finding | null {
  const name = optionalString(raw.package);
  if (!name) return null;

  // Anti-hallucination gate: a finding for a package we did not ask about is
  // discarded outright. The model does not get to expand the inventory.
  const entry = byName.get(name);
  if (!entry) return null;

  const rationale = optionalString(raw.rationale);
  if (!rationale) return null;

  const severity = VALID_SEVERITIES.has(raw.severity as string)
    ? (raw.severity as Finding['severity'])
    : 'info';
  const action = VALID_ACTIONS.has(raw.action as string)
    ? (raw.action as Finding['action'])
    : 'investigate';

  const breakingRisk = optionalString(raw.breakingRisk);

  return {
    id: `research-${entry.candidate.dependency.id}-${cluster}`,
    dependencyId: entry.candidate.dependency.id,
    type: FINDING_TYPE_BY_CLUSTER[cluster],
    severity,
    action,
    confidence: clampConfidence(raw.confidence),
    rationale,
    ...(breakingRisk ? { breakingRisk } : {}),
    evidence: sourceEvidence(raw.sources, entry.sources, retrievedAt),
  };
}

function parseFindings(
  parsed: Record<string, unknown> | null,
  cluster: ResearchCluster,
  byName: ReadonlyMap<
    string,
    { candidate: TriageCandidate; sources: readonly ResearchSearchResult[] }
  >,
  retrievedAt: string,
): Finding[] {
  if (!parsed || !Array.isArray(parsed.findings)) return [];
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const raw of parsed.findings) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const finding = toFinding(raw as Record<string, unknown>, cluster, byName, retrievedAt);
    if (!finding || seen.has(finding.id)) continue;
    seen.add(finding.id);
    out.push(finding);
  }
  return out;
}

// ── Researcher ────────────────────────────────────────────────────────────

export interface CreateResearcherOptions {
  readonly llm: ResearchLlm;
  readonly search: ResearchSearch;
  /** Injectable clock — keeps evidence timestamps deterministic in tests. */
  readonly now?: (() => Date) | undefined;
}

/**
 * Build a {@link TechStackResearcher} over the injected LLM and search ports.
 *
 * Failure policy throughout: a cluster that throws contributes zero findings
 * and does not disturb its siblings. Research is enrichment — a provider
 * outage or a dry search must degrade the report, never fail the analyze job
 * that already produced a complete deterministic inventory.
 */
export function createResearcher(options: CreateResearcherOptions): TechStackResearcher {
  const now = options.now ?? (() => new Date());

  return {
    async research(candidates, opts: ResearchOptions = {}): Promise<readonly Finding[]> {
      if (candidates.length === 0) return [];

      const clusters = [...clusterCandidates(candidates).entries()];
      const findings: Finding[] = [];
      let completed = 0;
      opts.onProgress?.(0, clusters.length);

      for (const [cluster, members] of clusters) {
        if (opts.signal?.aborted) break;

        try {
          const sources = await mapLimit(members, SEARCH_CONCURRENCY, (candidate) =>
            options.search(searchQuery(candidate), { signal: opts.signal }),
          );
          if (opts.signal?.aborted) break;

          const entries = members.map((candidate, i) => ({
            candidate,
            sources: sources[i] ?? [],
          }));
          const byName = new Map(entries.map((entry) => [entry.candidate.dependency.name, entry]));

          const text = await options.llm({
            system: SYSTEM_BY_CLUSTER[cluster],
            prompt: buildPrompt(cluster, entries),
            schema: RESEARCH_JSON_SCHEMA,
            schemaName: `techstack_${cluster}_findings`,
            maxTokens: MAX_TOKENS_PER_CLUSTER,
            signal: opts.signal,
          });

          findings.push(
            ...parseFindings(parseResearchJson(text), cluster, byName, now().toISOString()),
          );
        } catch {
          // This cluster contributed nothing. The others still run, and the
          // deterministic findings from `enrich()` are untouched.
        }

        completed++;
        opts.onProgress?.(completed, clusters.length);
      }

      return findings;
    },
  };
}
