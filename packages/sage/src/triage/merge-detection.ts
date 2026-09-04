/**
 * Phase 4: Merge Detection
 *
 * Groups memories into clusters by shared anchors and tags, then uses
 * a cheap LLM to compare pairs within each cluster to find duplicates.
 *
 * Pipeline:
 *   1. Cluster memories (deterministic — no LLM)
 *   2. Generate candidate pairs from clusters
 *   3. LLM pair-comparison: "Same fact? YES | NO | OVERLAP"
 *   4. Produce merge actions and overlap proposals
 *
 * Design:
 * - Clustering is deterministic and free.
 * - LLM calls are bounded (max 50 pairs per run).
 * - Merge actions are safe: only mark `superseded` (reversible).
 * - OVERLAP pairs get filed as investigate proposals.
 */

import type { Sage } from '../types.js';
import type { LlmCallFn } from './llm-evaluator.js';

// ── Types ───────────────────────────────────────────────────────────────

/** A cluster of memories sharing anchors or tags. */
export interface MemoryCluster {
  /** What the cluster members share (anchor path, symbol name, or tag set). */
  key: string;
  /** How the cluster was formed. */
  type: 'file' | 'symbol' | 'command' | 'tag_cluster';
  /** Memories in the cluster. */
  members: Sage[];
}

/** A candidate pair for LLM comparison. */
export interface MergeCandidate {
  memoryA: Sage;
  memoryB: Sage;
  /** Which cluster produced this pair. */
  clusterKey: string;
}

/** The LLM's verdict on a pair. */
export type MergeVerdict = 'YES' | 'NO' | 'OVERLAP';

export interface MergePairResult {
  candidate: MergeCandidate;
  verdict: MergeVerdict;
  raw: string;
  ok: boolean;
  error?: string;
}

/** A merge action — mark older as superseded. */
export interface MergeAction {
  /** The older memory to be superseded. */
  supersededId: string;
  /** The newer memory that survives. */
  keeperId: string;
  /** Text previews for audit. */
  supersededText: string;
  keeperText: string;
}

/** An overlap proposal for human review. */
export interface OverlapProposal {
  memoryAId: string;
  memoryBId: string;
  textAPreview: string;
  textBPreview: string;
  reason: string;
}

export interface MergeDetectionResult {
  /** Merge actions ready to apply via memory_update. */
  merges: MergeAction[];
  /** Overlap proposals for human review. */
  overlaps: OverlapProposal[];
  /** Summary counts. */
  summary: {
    totalMemories: number;
    clusters: number;
    pairsGenerated: number;
    pairsEvaluated: number;
    mergeYes: number;
    overlap: number;
    mergeNo: number;
    errors: number;
  };
}

// ── Constants ───────────────────────────────────────────────────────────

/** Maximum cluster size — larger clusters are skipped to avoid combinatorial explosion. */
const MAX_CLUSTER_SIZE = 5;

/** Maximum pairs to evaluate per run. */
const DEFAULT_MAX_PAIRS = 50;

/** Minimum shared tags for tag-based clustering. */
const MIN_SHARED_TAGS = 3;

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Run full merge detection on a set of memories.
 *
 * 1. Cluster by shared anchors and tags
 * 2. Generate candidate pairs
 * 3. Evaluate each pair with the LLM
 * 4. Produce merge actions and overlap proposals
 */
export async function detectMerges(
  memories: Sage[],
  callLlm: LlmCallFn,
  options: { maxPairs?: number; verbose?: boolean } = {},
): Promise<MergeDetectionResult> {
  const maxPairs = options.maxPairs ?? DEFAULT_MAX_PAIRS;
  const verbose = options.verbose ?? false;

  // Phase 4a: Cluster
  const clusters = buildClusters(memories);

  // Phase 4b: Generate pairs
  const allPairs = generatePairs(clusters);
  const pairs = allPairs.slice(0, maxPairs);

  if (verbose) {
    process.stderr.write(
      `[merge] ${clusters.length} clusters → ${allPairs.length} pairs, evaluating ${pairs.length}\n`,
    );
  }

  // Phase 4c: LLM evaluation
  const pairResults = await evaluateMergePairs(pairs, callLlm, verbose);

  // Phase 4d: Produce actions
  return buildResult(memories, clusters, allPairs, pairResults);
}

// ── Clustering ──────────────────────────────────────────────────────────

function buildClusters(memories: Sage[]): MemoryCluster[] {
  const clusters: MemoryCluster[] = [];

  // File-anchor clusters
  const byFile = new Map<string, Sage[]>();
  for (const m of memories) {
    for (const anchor of m.anchors) {
      if (anchor.type === 'file' && anchor.path) {
        const key = `file:${anchor.path}`;
        const group = byFile.get(key) ?? [];
        group.push(m);
        byFile.set(key, group);
      }
    }
  }
  for (const [key, rawMembers] of byFile) {
    const members = dedupeById(rawMembers);
    if (members.length >= 2 && members.length <= MAX_CLUSTER_SIZE) {
      clusters.push({ key, type: 'file', members });
    }
  }

  // Symbol-anchor clusters
  const bySymbol = new Map<string, Sage[]>();
  for (const m of memories) {
    for (const anchor of m.anchors) {
      if (anchor.type === 'symbol' && anchor.symbol) {
        const key = `symbol:${anchor.symbol}${anchor.path ? `@${anchor.path}` : ''}`;
        const group = bySymbol.get(key) ?? [];
        group.push(m);
        bySymbol.set(key, group);
      }
    }
  }
  for (const [key, rawMembers] of bySymbol) {
    const members = dedupeById(rawMembers);
    if (members.length >= 2 && members.length <= MAX_CLUSTER_SIZE) {
      clusters.push({ key, type: 'symbol', members });
    }
  }

  // Command-anchor clusters
  const byCommand = new Map<string, Sage[]>();
  for (const m of memories) {
    for (const anchor of m.anchors) {
      if (anchor.type === 'command' && anchor.command) {
        const key = `command:${anchor.command}`;
        const group = byCommand.get(key) ?? [];
        group.push(m);
        byCommand.set(key, group);
      }
    }
  }
  for (const [key, rawMembers] of byCommand) {
    const members = dedupeById(rawMembers);
    if (members.length >= 2 && members.length <= MAX_CLUSTER_SIZE) {
      clusters.push({ key, type: 'command', members });
    }
  }

  // Tag-based clusters (3+ shared tags)
  const tagClusters = buildTagClusters(memories);
  clusters.push(...tagClusters);

  return clusters;
}

function buildTagClusters(memories: Sage[]): MemoryCluster[] {
  const clusters: MemoryCluster[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < memories.length; i++) {
    const a = memories[i]!;
    if (a.tags.length < MIN_SHARED_TAGS) continue;

    for (let j = i + 1; j < memories.length; j++) {
      const b = memories[j]!;
      if (b.tags.length < MIN_SHARED_TAGS) continue;

      const shared = a.tags.filter((t) => b.tags.includes(t));
      if (shared.length >= MIN_SHARED_TAGS) {
        const key = `tags:${shared.sort().join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Find all other memories sharing these same tags
        const rawMembers = memories.filter((m) => shared.every((t) => m.tags.includes(t)));
        const members = dedupeById(rawMembers);
        if (members.length >= 2 && members.length <= MAX_CLUSTER_SIZE) {
          clusters.push({
            key,
            type: 'tag_cluster',
            members,
          });
        }
      }
    }
  }

  return clusters;
}

// ── Pair generation ─────────────────────────────────────────────────────

function generatePairs(clusters: MemoryCluster[]): MergeCandidate[] {
  const pairs: MergeCandidate[] = [];
  const seen = new Set<string>();

  for (const cluster of clusters) {
    const members = cluster.members;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i]!;
        const b = members[j]!;
        // Canonical ordering to deduplicate across clusters
        const pairKey = [a.id, b.id].sort().join('|');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        pairs.push({ memoryA: a, memoryB: b, clusterKey: cluster.key });
      }
    }
  }

  return pairs;
}

// ── LLM evaluation ──────────────────────────────────────────────────────

const MERGE_SYSTEM_PROMPT =
  'Do these two project memories describe the same fact? Reply: YES | NO | OVERLAP. OVERLAP means related but distinct — do not merge.';

function buildMergePrompt(a: Sage, b: Sage): string {
  return [`A: "${truncate(a.text, 250)}"`, `B: "${truncate(b.text, 250)}"`].join('\n');
}

async function evaluateMergePairs(
  pairs: MergeCandidate[],
  callLlm: LlmCallFn,
  verbose: boolean,
): Promise<MergePairResult[]> {
  const results: MergePairResult[] = [];

  for (const pair of pairs) {
    const prompt = buildMergePrompt(pair.memoryA, pair.memoryB);

    let result: MergePairResult;
    try {
      const raw = await callLlm(MERGE_SYSTEM_PROMPT, prompt);
      const verdict = parseMergeVerdict(raw);

      if (verbose && verdict !== 'NO') {
        process.stderr.write(
          `[merge] ${verdict}: ${pair.memoryA.id.slice(0, 12)} ↔ ${pair.memoryB.id.slice(0, 12)}\n`,
        );
      }

      result = { candidate: pair, verdict, raw, ok: true };
    } catch (err) {
      result = {
        candidate: pair,
        verdict: 'NO',
        raw: '',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    results.push(result);
  }

  return results;
}

function parseMergeVerdict(raw: string): MergeVerdict {
  const trimmed = raw.trim().toUpperCase();
  if (trimmed.startsWith('YES')) return 'YES';
  if (trimmed.startsWith('OVERLAP')) return 'OVERLAP';
  return 'NO';
}

// ── Result building ─────────────────────────────────────────────────────

function buildResult(
  _allMemories: Sage[],
  clusters: MemoryCluster[],
  allPairs: MergeCandidate[],
  pairResults: MergePairResult[],
): MergeDetectionResult {
  const merges: MergeAction[] = [];
  const overlaps: OverlapProposal[] = [];
  let errors = 0;

  for (const result of pairResults) {
    if (!result.ok) {
      errors++;
      continue;
    }

    const { memoryA, memoryB } = result.candidate;

    switch (result.verdict) {
      case 'YES': {
        // Pick the keeper by quality signals, not age.
        // Quality scoring (higher = better keeper):
        //   - text length: longer memories capture more detail
        //   - anchor count: more anchors = better grounded
        //   - confidence: higher = more reliable
        // Age is a tiebreaker only when quality scores are equal.
        const scoreA = memoryQualityScore(memoryA);
        const scoreB = memoryQualityScore(memoryB);
        let keeper: Sage;
        let superseded: Sage;
        if (scoreA > scoreB) {
          keeper = memoryA;
          superseded = memoryB;
        } else if (scoreB > scoreA) {
          keeper = memoryB;
          superseded = memoryA;
        } else {
          // Tie: prefer the newer memory as the keeper (the most recent
          // statement of the same fact is the most authoritative).
          const dateA = new Date(memoryA.createdAt).getTime();
          const dateB = new Date(memoryB.createdAt).getTime();
          keeper = dateA >= dateB ? memoryA : memoryB;
          superseded = dateA >= dateB ? memoryB : memoryA;
        }

        merges.push({
          supersededId: superseded.id,
          keeperId: keeper.id,
          supersededText: superseded.text.slice(0, 80),
          keeperText: keeper.text.slice(0, 80),
        });
        break;
      }

      case 'OVERLAP': {
        overlaps.push({
          memoryAId: memoryA.id,
          memoryBId: memoryB.id,
          textAPreview: memoryA.text.slice(0, 80),
          textBPreview: memoryB.text.slice(0, 80),
          reason: 'LLM flagged as OVERLAP — related but distinct. Human review recommended.',
        });
        break;
      }

      case 'NO':
        break;
    }
  }

  return {
    merges,
    overlaps,
    summary: {
      totalMemories: _allMemories.length,
      clusters: clusters.length,
      pairsGenerated: allPairs.length,
      pairsEvaluated: pairResults.length,
      mergeYes: merges.length,
      overlap: overlaps.length,
      mergeNo: pairResults.filter((r) => r.verdict === 'NO').length,
      errors,
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function dedupeById(memories: Sage[]): Sage[] {
  const seen = new Set<string>();
  return memories.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Quality score for keeper selection during merge.
 *
 * Higher score = better keeper. Combines:
 *   - text length: longer memories capture more detail (log-scaled, capped)
 *   - anchor count: more anchors = better grounded (more retrieval paths)
 *   - confidence: higher = more reliable
 *   - tag count: more tags = easier to find
 *   - revision: more revisions = more refined
 *
 * Returns a positive number; larger is better.
 *
 * Tiebreaker (when scores are equal): the older memory wins, on the
 * principle that established claims are more stable.
 */
function memoryQualityScore(memory: Sage): number {
  // Text length: log-scaled, capped at 200 chars to avoid favoring
  // run-on memories over concise ones indefinitely.
  const textScore = Math.min(Math.log2(memory.text.length + 1) * 5, 50);

  // Anchors: each anchor adds 5 points, capped at 25
  const anchorScore = Math.min(memory.anchors.length * 5, 25);

  // Confidence: 0-1 scaled to 0-15
  const confidenceScore = (memory.confidence ?? 0.5) * 15;

  // Tags: each tag adds 1 point, capped at 5
  const tagScore = Math.min(memory.tags.length, 5);

  // Revision: each revision adds 0.5 points, capped at 5
  const revisionScore = Math.min((memory.revision - 1) * 0.5, 5);

  return textScore + anchorScore + confidenceScore + tagScore + revisionScore;
}
