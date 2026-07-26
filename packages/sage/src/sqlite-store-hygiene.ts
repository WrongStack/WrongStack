import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@wrongstack/core/utils';

import { memoryNodeId } from './sqlite-store-graph-helpers.js';
import { sqliteRowToMemory } from './sqlite-store-codec.js';
import {
  normalizeAudience,
  normalizeTextKey,
} from './store-helpers.js';
import type {
  MemoryAnchor,
  MemoryCandidate,
  Sage,
  SageHygieneOptions,
  SageHygieneReport,
} from './types.js';
import { DEFAULT_PERSISTENCE } from './types.js';

export interface SqliteHygieneContext {
  projectRoot: string;
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  now: () => Date;
  nowIso: () => string;
  listMemories: (opts: { status: Sage['status'] | 'all'; limit: number }) => Promise<Sage[]>;
  listCandidates: () => Promise<MemoryCandidate[]>;
  addCandidate: (candidate: MemoryCandidate) => Promise<void>;
  runMutation: <T>(work: () => T) => Promise<T>;
  upsertMemory: (memory: Sage) => void;
  syncAnchorEdges: (memory: Sage) => void;
  audit: (event: string, data?: Record<string, unknown>) => void;
  pruneAuditLog: () => void;
}

export async function runSqliteSageHygiene(
  ctx: SqliteHygieneContext,
  opts?: SageHygieneOptions,
): Promise<SageHygieneReport> {
  const startedAt = ctx.nowIso();

  const active = await ctx.listMemories({ status: 'active', limit: 0 });
  const stale: string[] = [];
  const verified: string[] = [];

  if (opts?.verify !== false) {
    const anchorPaths = new Set<string>();
    for (const m of active) {
      for (const anchor of m.anchors) {
        if (
          anchor.path &&
          (anchor.type === 'file' ||
            anchor.type === 'symbol' ||
            anchor.type === 'test' ||
            anchor.type === 'git')
        ) {
          anchorPaths.add(path.resolve(ctx.projectRoot, anchor.path));
        }
      }
    }
    const pathsToVerify = [...anchorPaths];
    const existingPaths = new Set<string>();
    let nextPath = 0;
    const verifyWorker = async (): Promise<void> => {
      while (nextPath < pathsToVerify.length) {
        const anchorPath = pathsToVerify[nextPath++]!;
        try {
          await fs.promises.access(anchorPath);
          existingPaths.add(anchorPath);
        } catch {
          // Missing or inaccessible anchors are stale.
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(32, pathsToVerify.length) }, () => verifyWorker()),
    );

    const verificationRunAt = ctx.nowIso();
    const verificationOutcomes = new Map<string, boolean>();
    for (const m of active) {
      const allValid = m.anchors.every(
        (anchor) =>
          !anchor.path ||
          !(
            anchor.type === 'file' ||
            anchor.type === 'symbol' ||
            anchor.type === 'test' ||
            anchor.type === 'git'
          ) ||
          existingPaths.has(path.resolve(ctx.projectRoot, anchor.path)),
      );
      verificationOutcomes.set(m.id, allValid);
      if (allValid) verified.push(m.id);
      else stale.push(m.id);
    }

    await ctx.runMutation(() => {
      for (const [memoryId, allValid] of verificationOutcomes) {
        const row = ctx.stmt('SELECT data FROM memories WHERE id = ?').get(memoryId) as
          | { data: string }
          | undefined;
        if (!row) continue;
        const current = sqliteRowToMemory(row);
        if (current.status !== 'active') continue;
        if (allValid && current.anchors.length === 0) continue;
        const updated: Sage = {
          ...current,
          status: allValid ? 'active' : 'stale',
          lastVerifiedAt: verificationRunAt,
          ...(allValid ? { freshness: 1 } : {}),
        };
        ctx.upsertMemory(updated);
        ctx.syncAnchorEdges(updated);
      }
    });
  }

  let deduplicated = 0;
  let superseded = 0;
  const allActive = await ctx.listMemories({ status: 'active', limit: 0 });
  const groups = new Map<string, Sage[]>();
  for (const m of allActive) {
    const audienceKey = JSON.stringify(normalizeAudience(m.audience) ?? null);
    const key = `${m.scope}\0${normalizeTextKey(m.text)}\0${audienceKey}`;
    const group = groups.get(key);
    if (group) group.push(m);
    else groups.set(key, [m]);
  }
  await ctx.runMutation(() => {
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort(
        (a, b) =>
          b.importance - a.importance ||
          b.confidence - a.confidence ||
          a.createdAt.localeCompare(b.createdAt),
      );
      const keeper = sorted[0]!;
      const duplicates = sorted.slice(1);
      const updatedKeeper: Sage = {
        ...keeper,
        tags: [...new Set(sorted.flatMap((m) => m.tags))],
        anchors: [
          ...new Map(
            [...sorted.flatMap((m) => m.anchors)].map((a) => [
              JSON.stringify(a, Object.keys(a).sort()),
              a,
            ]),
          ).values(),
        ] as MemoryAnchor[],
        sources: [...new Set(sorted.flatMap((m) => m.sources.map((s) => JSON.stringify(s))))].map(
          (s) => JSON.parse(s),
        ),
        supersedes: [...new Set([...(keeper.supersedes ?? []), ...duplicates.map((m) => m.id)])],
        updatedAt: ctx.nowIso(),
      };
      ctx.upsertMemory(updatedKeeper);
      ctx.syncAnchorEdges(updatedKeeper);
      for (const dup of duplicates) {
        const supersededDup: Sage = {
          ...dup,
          status: 'superseded',
          supersededBy: keeper.id,
          updatedAt: ctx.nowIso(),
        };
        ctx.upsertMemory(supersededDup);
        ctx.syncAnchorEdges(supersededDup);
        try {
          ctx
            .stmt(
              `INSERT INTO edges (from_node, to_node, relation, weight, created_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(from_node, to_node, relation) DO UPDATE SET weight = excluded.weight`,
            )
            .run(memoryNodeId(keeper.id), memoryNodeId(dup.id), 'supersedes', 1, ctx.nowIso());
        } catch {
          /* transient edge race — non-critical */
        }
        deduplicated++;
        superseded++;
      }
    }
    ctx.audit('memory.hygiene_dedup', { details: { deduplicated, superseded } });
  });

  const nowMs = ctx.now().getTime();
  const retentionMs = (opts?.retentionDays ?? 90) * 86_400_000;
  const lowConfidenceMs = (opts?.archiveLowConfidenceAfterDays ?? 30) * 86_400_000;
  const unusedMs = (opts?.archiveUnusedAfterDays ?? 30) * 86_400_000;
  const unusedMinInjections = Math.max(1, Math.floor(opts?.unusedMinInjections ?? 10));

  const existingCandidates = await ctx.listCandidates();
  const existingPendingKeys = new Set(
    existingCandidates.filter((c) => c.status === 'pending').map((c) => c.targetMemoryId ?? ''),
  );

  let reviewCandidatesCreated = 0;
  const candidates = await ctx.listMemories({ status: 'all', limit: 0 });
  for (const m of candidates) {
    if (m.status === 'deleted' || m.status === 'superseded' || m.status === 'contradicted')
      continue;

    const age = nowMs - Date.parse(m.lastAccessedAt ?? m.updatedAt);
    const persistence = m.persistence ?? DEFAULT_PERSISTENCE;
    let reason: string | undefined;
    let suggestedAction: 'delete' | 'archive' | 'investigate' = 'investigate';

    if (m.scope === 'session' && m.expiresAt && Date.parse(m.expiresAt) <= nowMs) {
      reason = 'expires_at_passed';
      suggestedAction = 'delete';
    } else if (m.expiresAt && Date.parse(m.expiresAt) <= nowMs) {
      reason = 'expires_at_passed';
      suggestedAction = 'delete';
    } else if (
      m.status === 'active' &&
      m.scope !== 'session' &&
      (m.injectionCount ?? 0) >= unusedMinInjections &&
      (m.useCount ?? 0) === 0 &&
      nowMs - Date.parse(m.updatedAt) >= unusedMs
    ) {
      reason = 'injected_never_used';
      suggestedAction = 'delete';
    } else if (
      (m.status === 'stale' && age >= retentionMs) ||
      (m.confidence < 0.5 && age >= lowConfidenceMs)
    ) {
      reason = m.confidence < 0.5 ? 'confidence_low' : 'freshness_low';
      suggestedAction = 'investigate';
    }

    if (reason && persistence !== 'permanent' && !existingPendingKeys.has(m.id)) {
      const ageDays = Math.floor((nowMs - Date.parse(m.updatedAt)) / 86_400_000);
      await ctx.addCandidate({
        id: ulid(),
        schemaVersion: 1,
        targetMemoryId: m.id,
        text: m.text,
        kind: 'memory_review',
        status: 'pending',
        scope: 'project',
        confidence: 0.6,
        importance: 0.4,
        tags: [
          ...m.tags,
          `review:${reason}`,
          `suggested:${suggestedAction}`,
          `persistence:${persistence}`,
        ],
        anchors: m.anchors,
        sources: [{ type: 'session' }],
        createdAt: ctx.nowIso(),
        updatedAt: ctx.nowIso(),
      });
      ctx.audit('memory.review_candidate_created', {
        memoryId: m.id,
        reason,
        details: {
          suggestedAction,
          ageDays,
          persistence,
          status: m.status,
          confidence: m.confidence,
        },
      });
      reviewCandidatesCreated++;
    }
  }

  const report: SageHygieneReport = {
    startedAt,
    completedAt: ctx.nowIso(),
    examined: active.length,
    deduplicated,
    superseded,
    contradicted: 0,
    staled: stale.length,
    reviewCandidatesCreated,
    archived: 0,
    archivedUnused: 0,
    deleted: 0,
    purgedDeleted: 0,
    verified: verified.length,
    transitiveMerges: 0,
  };
  ctx.audit('memory.hygiene_completed', {
    details: report,
  });
  ctx.pruneAuditLog();
  return report;
}
