import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { LlmCallFn } from '../triage/llm-evaluator.js';
import type { CreateCandidateInput, MemoryCandidate, Sage, SageStatus } from '../types.js';
import {
  buildConsolidationBatches,
  proposedMemberIds,
  selectConsolidationPool,
} from './batches.js';
import {
  buildConsolidationPrompt,
  CONSOLIDATION_SYSTEM_PROMPT,
  parseConsolidationResponse,
} from './distill.js';

export const DEFAULT_CONSOLIDATION_CALLS = 20;
const MAX_PROPOSAL_SOURCES = 10;

export interface ConsolidationSurface {
  listSage(statuses?: SageStatus[]): Promise<Sage[]>;
  listCandidates(includeResolved?: boolean): Promise<MemoryCandidate[]>;
  createCandidate(input: CreateCandidateInput): Promise<MemoryCandidate>;
  rejectCandidate?(candidateId: string, reason: string): Promise<boolean>;
}

export interface ConsolidationReport {
  pool: number;
  batches: number;
  calls: number;
  proposed: number;
  /** Answers that were empty (`lesson: null`) or failed the grounding gate. */
  noLesson: number;
  /** Batches whose shared path no longer exists. */
  skippedMissing: number;
  errors: number;
  /** Members sent to the model this pass. */
  seenIds: string[];
  /** The store owner dropped the member list: it is older than this host. */
  staleOwner?: boolean | undefined;
}

/**
 * One consolidation pass: select the pool, batch it, ask the model for one
 * lesson per batch (at most `maxCalls` calls) and file each grounded lesson as
 * a `consolidate` proposal. Nothing is applied here: the daemon accepts
 * proposals nobody rejected within the review window.
 */
export async function runConsolidationPass(
  surface: ConsolidationSurface,
  llm: LlmCallFn,
  options: {
    maxCalls?: number | undefined;
    now?: (() => number) | undefined;
    signal?: AbortSignal | undefined;
    /** When set, a batch whose shared path is gone is skipped: its lesson would be stale on arrival. */
    projectRoot?: string | undefined;
    /** Members a recent pass already showed the model without retiring them. */
    skipIds?: ReadonlySet<string> | undefined;
  } = {},
): Promise<ConsolidationReport> {
  const nowMs = (options.now ?? Date.now)();
  const maxCalls = options.maxCalls ?? DEFAULT_CONSOLIDATION_CALLS;
  const report: ConsolidationReport = {
    pool: 0,
    batches: 0,
    calls: 0,
    proposed: 0,
    noLesson: 0,
    skippedMissing: 0,
    errors: 0,
    seenIds: [],
  };
  const [memories, candidates] = await Promise.all([
    surface.listSage(['active']),
    surface.listCandidates(true),
  ]);
  const covered = proposedMemberIds(candidates, nowMs);
  for (const id of options.skipIds ?? []) covered.add(id);
  const pool = selectConsolidationPool(memories, nowMs, covered);
  const batches = buildConsolidationBatches(pool);
  report.pool = pool.length;
  report.batches = batches.length;

  for (const batch of batches) {
    if (report.calls >= maxCalls || options.signal?.aborted) break;
    if (options.projectRoot && !existsSync(path.join(options.projectRoot, batch.key))) {
      report.skippedMissing++;
      continue;
    }
    report.calls++;
    let raw: string;
    try {
      raw = await llm(CONSOLIDATION_SYSTEM_PROMPT, buildConsolidationPrompt(batch));
    } catch {
      report.errors++;
      continue;
    }
    if (options.signal?.aborted) break;
    const lesson = parseConsolidationResponse(raw, batch);
    if (!lesson) {
      report.noLesson++;
      // Seen unless retired below: not sent again until the skip window passes.
      for (const memory of batch.members) report.seenIds.push(memory.id);
      continue;
    }
    const members = batch.members.filter((memory) => lesson.sourceIds.includes(memory.id));
    const sources = [
      ...new Map(
        members
          .flatMap((memory) => memory.sources)
          .map((source) => [JSON.stringify(source), source]),
      ).values(),
    ].slice(0, MAX_PROPOSAL_SOURCES);
    let created: MemoryCandidate;
    try {
      created = await surface.createCandidate({
        text: lesson.text,
        kind: lesson.kind,
        scope: 'project',
        importance: lesson.importance,
        confidence: 0.7,
        tags: lesson.tags,
        anchors: lesson.anchors,
        sources: sources.length > 0 ? sources : [{ type: 'session' }],
        reviewReason: `consolidation of ${lesson.sourceIds.length} memories about ${batch.key}`,
        suggestedAction: 'consolidate',
        supersedesMemoryIds: lesson.sourceIds,
        supersedesRevisions: lesson.sourceRevisions,
      });
    } catch {
      report.errors++;
      continue;
    }
    // A store owner from before consolidation drops the member list without
    // an error, leaving a proposal that adds the lesson and retires nothing.
    // Withdraw it and stop paying for calls until the owner is restarted.
    if (created.supersedesMemoryIds?.length !== lesson.sourceIds.length) {
      await surface
        .rejectCandidate?.(
          created.id,
          'SAGE store owner predates consolidation (member list dropped); restart it.',
        )
        .catch(() => false);
      report.staleOwner = true;
      break;
    }
    for (const memory of batch.members) report.seenIds.push(memory.id);
    report.proposed++;
  }
  return report;
}
