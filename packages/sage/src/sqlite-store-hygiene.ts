import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@wrongstack/core/utils';
import { verifyMemoryAnchors } from './anchors/verify.js';
import { applySemanticChange } from './shared/semantic-rewrite.js';
import { readSqliteSageRow } from './sqlite-store-codec.js';
import { memoryNodeId } from './sqlite-store-graph-helpers.js';
import {
  isNearDuplicateMemory,
  isPossiblyContradictory,
  normalizeAudience,
  normalizeTextKey,
} from './store-helpers.js';
import type {
  CandidateSuggestedAction,
  MemoryAnchor,
  MemoryCandidate,
  Sage,
  SageHygieneOptions,
  SageHygieneReport,
} from './types.js';
import { DEFAULT_PERSISTENCE } from './types.js';

/** Cap pairwise near-dup work inside a single scope/kind/audience bucket. */
const HYGIENE_NEAR_DUP_BUCKET_CAP = 80;

/**
 * Ascending byte comparison for ISO-8601 timestamps. `localeCompare` is
 * locale-aware and can reorder ASCII-only ISO strings across locales (Turkish
 * `i`/`I`, German `ß`/`ss`) — see `shared/pagination.ts:compareByUpdatedDesc`
 * for the canonical rationale. Oldest-first keeps the earliest record as the
 * dedup keeper. Valid for uniform-format strings (all writers use
 * `new Date().toISOString()`).
 */
function compareIsoAscending(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Oldest-first ordering for a pair of memories.
 *
 * `createdAt` is millisecond-precision, so two memories written in the same
 * tick compare EQUAL. The equal case used to fall through to the caller's
 * query order (`updated_at DESC, id DESC`) — which lists the newest record
 * first, so the "newer" pick resolved to the OLDER member and the
 * `contradicts` link plus the 'investigate' candidate landed on the wrong
 * claim. Ids are ULIDs and sort lexicographically by creation time, so they
 * break the tie in true insertion order. Byte comparison for the same reason
 * `compareIsoAscending` avoids `localeCompare`.
 */
function compareMemoryAgeAscending(a: Sage, b: Sage): number {
  const byCreated = compareIsoAscending(a.createdAt, b.createdAt);
  if (byCreated !== 0) return byCreated;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

interface SqliteHygieneContext {
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
  /** Soft-delete edge cascade for auto session GC. */
  cascadeDeleteEdges: (nodeId: string) => void;
  audit: (event: string, data?: Record<string, unknown>) => void;
  pruneAuditLog: () => void;
}

/**
 * Default age after which session-scoped memories without an explicit
 * `expiresAt` are soft-deleted by hygiene. Session scope is ephemeral by
 * contract; waiting for review candidates only pollutes the corpus.
 */
const DEFAULT_SESSION_RETENTION_DAYS = 7;

export async function runSqliteSageHygiene(
  ctx: SqliteHygieneContext,
  opts?: SageHygieneOptions,
): Promise<SageHygieneReport> {
  const startedAt = ctx.nowIso();

  const active = await ctx.listMemories({ status: 'active', limit: 0 });
  const stale: string[] = [];
  const verified: string[] = [];

  // Anchor verification depth is configurable:
  // - existence (default): cheap O(N) path presence only.
  // - content / git: deep verify via verifyMemoryAnchors (content hash,
  //   symbol, command; git blob when depth is git or the anchor carries one).
  if (opts?.verify !== false) {
    const depth = opts?.verifyDepth ?? 'existence';
    const verificationRunAt = ctx.nowIso();
    const verificationOutcomes = new Map<string, boolean>();

    if (depth === 'existence') {
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
    } else {
      // Deep pass: bound concurrency so hygiene stays usable on large corpora.
      const DEEP_CONCURRENCY = 8;
      let nextMem = 0;
      const deepWorker = async (): Promise<void> => {
        while (nextMem < active.length) {
          const memory = active[nextMem++]!;
          if (memory.anchors.length === 0) {
            verificationOutcomes.set(memory.id, true);
            verified.push(memory.id);
            continue;
          }
          try {
            const result = await verifyMemoryAnchors(ctx.projectRoot, memory, verificationRunAt);
            // `unknown` (e.g. git unavailable) does not force stale; only explicit
            // stale/contradicted outcomes demote the memory.
            const demote = result.status === 'stale' || result.status === 'contradicted';
            verificationOutcomes.set(memory.id, !demote);
            if (demote) stale.push(memory.id);
            else verified.push(memory.id);
          } catch {
            // Fail-open: leave active if deep verify itself errors.
            verificationOutcomes.set(memory.id, true);
            verified.push(memory.id);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(DEEP_CONCURRENCY, Math.max(1, active.length)) }, () =>
          deepWorker(),
        ),
      );
    }

    await ctx.runMutation(() => {
      for (const [memoryId, allValid] of verificationOutcomes) {
        const current = readSqliteSageRow(ctx.stmt, memoryId);
        if (!current) continue;
        if (current.status !== 'active') continue;
        if (allValid && current.anchors.length === 0) continue;
        const updated = applySemanticChange(
          current,
          {
            status: allValid ? ('active' as const) : ('stale' as const),
            lastVerifiedAt: verificationRunAt,
            ...(allValid ? { freshness: 1 } : {}),
          },
          ctx.nowIso(),
        );
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
          compareIsoAscending(a.createdAt, b.createdAt),
      );
      const keeper = sorted[0]!;
      const duplicates = sorted.slice(1);
      const updatedKeeper = applySemanticChange(
        keeper,
        {
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
        },
        ctx.nowIso(),
      );
      ctx.upsertMemory(updatedKeeper);
      ctx.syncAnchorEdges(updatedKeeper);
      for (const dup of duplicates) {
        const supersededDup = applySemanticChange(
          dup,
          { status: 'superseded' as const, supersededBy: keeper.id },
          ctx.nowIso(),
        );
        ctx.upsertMemory(supersededDup);
        ctx.syncAnchorEdges(supersededDup);
        try {
          ctx
            .stmt(
              `INSERT INTO edges (from_node, to_node, relation, weight, created_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(from_node, to_node, relation) DO UPDATE SET weight = MAX(weight, excluded.weight)`,
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

  // Near-duplicate pass: catch paraphrases that the exact-text key missed.
  // Remember-time merge already does this for new writes; hygiene heals
  // historical corpus that predated near-dup or arrived via import.
  // Opt-out via `nearDedup: false` for recall-tuning sessions.
  let transitiveMerges = 0;
  if (opts?.nearDedup !== false) {
    const nearActive = await ctx.listMemories({ status: 'active', limit: 0 });
    const nearBuckets = new Map<string, Sage[]>();
    for (const m of nearActive) {
      const audienceKey = JSON.stringify(normalizeAudience(m.audience) ?? null);
      const key = `${m.scope}\0${m.kind}\0${audienceKey}`;
      const bucket = nearBuckets.get(key);
      if (bucket) bucket.push(m);
      else nearBuckets.set(key, [m]);
    }
    await ctx.runMutation(() => {
      let nearPassDeduped = 0;
      for (const bucket of nearBuckets.values()) {
        if (bucket.length < 2) continue;
        const capped = [...bucket]
          .sort(
            (a, b) =>
              b.importance - a.importance ||
              b.confidence - a.confidence ||
              compareIsoAscending(a.createdAt, b.createdAt),
          )
          .slice(0, HYGIENE_NEAR_DUP_BUCKET_CAP);
        const parent = new Map<string, string>();
        const find = (id: string): string => {
          let cur = id;
          while (parent.get(cur) !== undefined && parent.get(cur) !== cur) {
            const next = parent.get(cur)!;
            parent.set(cur, parent.get(next) ?? next);
            cur = next;
          }
          if (!parent.has(cur)) parent.set(cur, cur);
          return cur;
        };
        const union = (a: string, b: string): void => {
          const ra = find(a);
          const rb = find(b);
          if (ra !== rb) parent.set(rb, ra);
        };
        for (let i = 0; i < capped.length; i++) {
          const left = capped[i]!;
          for (let j = i + 1; j < capped.length; j++) {
            const right = capped[j]!;
            // Skip pairs the contradiction pass is responsible for: merging a
            // polarity pair here would destroy the contradiction (e.g. "is
            // stable" vs "is not stable" would collapse into one memory).
            if (isNearDuplicateMemory(left, right) && !isPossiblyContradictory(left, right)) {
              union(left.id, right.id);
            }
          }
        }
        const mergedGroups = new Map<string, Sage[]>();
        for (const m of capped) {
          const root = find(m.id);
          const group = mergedGroups.get(root);
          if (group) group.push(m);
          else mergedGroups.set(root, [m]);
        }
        for (const group of mergedGroups.values()) {
          if (group.length < 2) continue;
          // Track raw union-find collapses (size > 2) before pair validation.
          if (group.length > 2) transitiveMerges++;
          const sorted = [...group].sort(
            (a, b) =>
              b.importance - a.importance ||
              b.confidence - a.confidence ||
              compareIsoAscending(a.createdAt, b.createdAt),
          );
          const keeper = sorted[0]!;
          // Pair validation: only supersede members that are near-dup with the
          // keeper itself. Transitively connected-but-unrelated facts stay.
          const duplicates = sorted.slice(1).filter((dup) => isNearDuplicateMemory(keeper, dup));
          if (duplicates.length === 0) continue;
          const mergeSet = [keeper, ...duplicates];
          const richest = mergeSet.reduce((best, cur) =>
            cur.text.length > best.text.length ? cur : best,
          );
          const updatedKeeper = applySemanticChange(
            keeper,
            {
              text: richest.text.length > keeper.text.length ? richest.text : keeper.text,
              tags: [...new Set(mergeSet.flatMap((m) => m.tags))],
              anchors: [
                ...new Map(
                  [...mergeSet.flatMap((m) => m.anchors)].map((a) => [
                    JSON.stringify(a, Object.keys(a).sort()),
                    a,
                  ]),
                ).values(),
              ] as MemoryAnchor[],
              sources: [
                ...new Set(mergeSet.flatMap((m) => m.sources.map((s) => JSON.stringify(s)))),
              ].map((s) => JSON.parse(s)),
              supersedes: [
                ...new Set([...(keeper.supersedes ?? []), ...duplicates.map((m) => m.id)]),
              ],
            },
            ctx.nowIso(),
          );
          ctx.upsertMemory(updatedKeeper);
          ctx.syncAnchorEdges(updatedKeeper);
          for (const dup of duplicates) {
            const supersededDup = applySemanticChange(
              dup,
              { status: 'superseded' as const, supersededBy: keeper.id },
              ctx.nowIso(),
            );
            ctx.upsertMemory(supersededDup);
            ctx.syncAnchorEdges(supersededDup);
            try {
              ctx
                .stmt(
                  `INSERT INTO edges (from_node, to_node, relation, weight, created_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(from_node, to_node, relation) DO UPDATE SET weight = MAX(weight, excluded.weight)`,
                )
                .run(memoryNodeId(keeper.id), memoryNodeId(dup.id), 'supersedes', 1, ctx.nowIso());
            } catch {
              /* transient edge race — non-critical */
            }
            deduplicated++;
            superseded++;
            nearPassDeduped++;
          }
        }
      }
      if (nearPassDeduped > 0 || transitiveMerges > 0) {
        ctx.audit('memory.hygiene_near_dedup', {
          details: { nearPassDeduped, transitiveMerges, deduplicated, superseded },
        });
      }
    });
  }

  // ─── Contradiction detection (v1, deterministic) ─────────────────────
  // Active pairs in the same scope+audience bucket whose token sets overlap
  // ≥ the near-dup threshold and differ by a negation cue (not/no/never/…)
  // are flagged as possible contradictions. Consistent with how archive and
  // delete retention work, hygiene never flips statuses here: it emits an
  // 'investigate' review candidate for the newer member, links `contradicts`
  // on it, and counts the pair in the report so a human/agent can resolve it
  // (memory_update can set status 'contradicted' explicitly).
  let contradicted = 0;
  {
    const activeNow = await ctx.listMemories({ status: 'active', limit: 0 });
    const buckets = new Map<string, Sage[]>();
    for (const memory of activeNow) {
      const audienceKey = JSON.stringify(normalizeAudience(memory.audience) ?? null);
      const key = `${memory.scope}\u0000${audienceKey}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(memory);
      else buckets.set(key, [memory]);
    }
    const flagged = new Map<string, { memory: Sage; other: Sage }>();
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      const capped = bucket.slice(0, HYGIENE_NEAR_DUP_BUCKET_CAP);
      for (let i = 0; i < capped.length; i++) {
        for (let j = i + 1; j < capped.length; j++) {
          const a = capped[i]!;
          const b = capped[j]!;
          if (!isPossiblyContradictory(a, b)) continue;
          // Skip pairs that are already linked — repeated hygiene runs must
          // not re-flag (and re-candidate) the same contradiction.
          if (a.contradicts?.includes(b.id) || b.contradicts?.includes(a.id)) continue;
          // Flag the newer member; the older one is the contradicted claim.
          const newer = compareMemoryAgeAscending(a, b) <= 0 ? b : a;
          const other = newer === a ? b : a;
          if (!flagged.has(newer.id)) flagged.set(newer.id, { memory: newer, other });
        }
      }
    }
    const pendingCandidates: Array<{ memory: Sage; other: Sage }> = [];
    if (flagged.size > 0) {
      await ctx.runMutation(() => {
        for (const { memory, other } of flagged.values()) {
          const contradictions = [...new Set([...(memory.contradicts ?? []), other.id])];
          const updated = applySemanticChange(
            memory,
            { contradicts: contradictions },
            ctx.nowIso(),
          );
          ctx.upsertMemory(updated);
          ctx.syncAnchorEdges(updated);
          pendingCandidates.push({ memory, other });
          contradicted++;
        }
        ctx.audit('memory.hygiene_contradictions', {
          details: { candidates: contradicted },
        });
      });
    }
    // Candidate creation is async and must not run inside the (synchronous)
    // mutation work; await it after the mutation commits. Failures are
    // best-effort — the contradicts link, audit event, and report count
    // already landed.
    for (const { memory, other } of pendingCandidates) {
      try {
        await ctx.addCandidate({
          id: ulid(),
          schemaVersion: 1,
          targetMemoryId: memory.id,
          text: memory.text,
          kind: 'memory_review',
          status: 'pending',
          scope: memory.scope,
          confidence: memory.confidence,
          importance: memory.importance,
          // E1: typed proposal metadata instead of review:/suggested:/
          // source: tag prefixes.
          reviewReason: `Possible contradiction with memory ${other.id}`,
          suggestedAction: 'investigate',
          tags: [...memory.tags],
          anchors: memory.anchors,
          sources: [{ type: 'session' }],
          createdAt: ctx.nowIso(),
          updatedAt: ctx.nowIso(),
        });
      } catch {
        // Best-effort — the contradicts link, audit event, and report count
        // already landed without the candidate.
      }
    }
  }

  const nowMs = ctx.now().getTime();
  const retentionMs = (opts?.retentionDays ?? 90) * 86_400_000;
  const sessionRetentionMs =
    (opts?.sessionRetentionDays ?? DEFAULT_SESSION_RETENTION_DAYS) * 86_400_000;
  const lowConfidenceMs = (opts?.archiveLowConfidenceAfterDays ?? 30) * 86_400_000;
  const unusedMs = (opts?.archiveUnusedAfterDays ?? 30) * 86_400_000;
  const unusedMinInjections = Math.max(1, Math.floor(opts?.unusedMinInjections ?? 10));

  const existingCandidates = await ctx.listCandidates();
  const existingPendingKeys = new Set(
    existingCandidates.filter((c) => c.status === 'pending').map((c) => c.targetMemoryId ?? ''),
  );

  let reviewCandidatesCreated = 0;
  let deleted = 0;
  let purgedDeleted = 0;
  const sessionGcTargets: Sage[] = [];
  const candidates = await ctx.listMemories({ status: 'all', limit: 0 });
  for (const m of candidates) {
    if (m.status === 'deleted' || m.status === 'superseded' || m.status === 'contradicted')
      continue;

    const age = nowMs - Date.parse(m.lastAccessedAt ?? m.updatedAt);
    const persistence = m.persistence ?? DEFAULT_PERSISTENCE;
    if (persistence === 'permanent') continue;

    // Session GC: soft-delete expired / aged-out session memories immediately.
    // These are ephemeral by contract; a review candidate only re-pollutes the
    // queue. Project-scope expiry still goes through the candidate path.
    const sessionExpired =
      m.scope === 'session' &&
      ((m.expiresAt !== undefined && Date.parse(m.expiresAt) <= nowMs) ||
        (m.expiresAt === undefined && nowMs - Date.parse(m.updatedAt) >= sessionRetentionMs));
    if (sessionExpired) {
      sessionGcTargets.push(m);
      continue;
    }

    let reason: string | undefined;
    let suggestedAction: 'delete' | 'archive' | 'investigate' = 'investigate';

    if (m.expiresAt && Date.parse(m.expiresAt) <= nowMs) {
      reason = 'expires_at_passed';
      suggestedAction = 'delete';
    } else if (
      m.status === 'active' &&
      m.scope !== 'session' &&
      (m.injectionCount ?? 0) >= unusedMinInjections &&
      (m.useCount ?? 0) === 0 &&
      // Age by injection activity (`age` = lastAccessedAt ?? updatedAt), not
      // content `updatedAt`: `recordInjection` no longer advances the content
      // clock, and a memory that keeps getting injected but never referenced
      // should only be flagged once it drops out of the rotation.
      age >= unusedMs
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

    if (reason && !existingPendingKeys.has(m.id)) {
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
        // E1: proposal metadata is typed (reviewReason / suggestedAction)
        // instead of the legacy `review:` / `suggested:` tag prefixes.
        reviewReason: reason,
        suggestedAction: suggestedAction as CandidateSuggestedAction,
        tags: [
          ...m.tags,
          // Review context about the TARGET memory: candidates carry no
          // persistence field, so the target's class is conveyed via a tag.
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

  if (sessionGcTargets.length > 0) {
    await ctx.runMutation(() => {
      for (const m of sessionGcTargets) {
        const tombstone: Sage = {
          ...m,
          status: 'deleted',
          revision: m.revision + 1,
          updatedAt: ctx.nowIso(),
          contextPolicy: 'never',
        };
        ctx.upsertMemory(tombstone);
        ctx.cascadeDeleteEdges(memoryNodeId(m.id));
        ctx.audit('memory.session_gc', {
          memoryId: m.id,
          reason: m.expiresAt ? 'expires_at_passed' : 'session_retention',
          details: {
            expiresAt: m.expiresAt,
            updatedAt: m.updatedAt,
            sessionRetentionDays: opts?.sessionRetentionDays ?? DEFAULT_SESSION_RETENTION_DAYS,
          },
        });
        deleted++;
      }
    });
  }

  // Opt-in physical purge of old tombstones (including session GC).
  const purgeAfterDays = opts?.purgeDeletedAfterDays;
  if (typeof purgeAfterDays === 'number' && purgeAfterDays > 0) {
    const purgeCutoff = nowMs - purgeAfterDays * 86_400_000;
    const tombstones = await ctx.listMemories({ status: 'deleted', limit: 0 });
    const purgeIds = tombstones
      .filter((m) => {
        if ((m.persistence ?? DEFAULT_PERSISTENCE) === 'permanent') return false;
        const deletedAt = Date.parse(m.updatedAt);
        return Number.isFinite(deletedAt) && deletedAt <= purgeCutoff;
      })
      .map((m) => m.id);
    if (purgeIds.length > 0) {
      await ctx.runMutation(() => {
        const del = ctx.stmt('DELETE FROM memories WHERE id = ?');
        for (const id of purgeIds) {
          ctx.cascadeDeleteEdges(memoryNodeId(id));
          del.run(id);
          purgedDeleted++;
        }
        ctx.audit('memory.purge_deleted', {
          details: { purgedDeleted, purgeDeletedAfterDays: purgeAfterDays },
        });
      });
    }
  }

  const report: SageHygieneReport = {
    startedAt,
    completedAt: ctx.nowIso(),
    examined: active.length,
    deduplicated,
    superseded,
    contradicted,
    staled: stale.length,
    reviewCandidatesCreated,
    archived: 0,
    archivedUnused: 0,
    deleted,
    purgedDeleted,
    verified: verified.length,
    transitiveMerges,
  };
  ctx.audit('memory.hygiene_completed', {
    details: report,
  });
  ctx.pruneAuditLog();
  return report;
}
