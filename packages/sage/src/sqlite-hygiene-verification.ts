import * as fs from 'node:fs';
import * as path from 'node:path';
import { verifyMemoryAnchors } from './anchors/verify.js';
import { snapshotMemoryEvidence } from './retrieval/source-evidence.js';
import { applySemanticChange } from './shared/semantic-rewrite.js';
import { isVerificationStale } from './shared/stale-reason.js';
import type { SqliteHygieneContext } from './sqlite-hygiene-anchors.js';
import { anchorsPresentOnDisk, existenceProvesAnchors } from './sqlite-hygiene-anchors.js';
import { anchorsChanged } from './sqlite-store-anchor-diff.js';
import { readSqliteSageRow } from './sqlite-store-codec.js';
import { stampSqliteVerification } from './sqlite-store-verification-stamp.js';
import type { MemoryAnchor, Sage } from './types.js';
export async function verifyHygieneMemories(inputs: {
  opts: import('./memory-hygiene-types.js').SageHygieneOptions | undefined;
  ctx: SqliteHygieneContext;
  active: import('./memory-model.js').Sage[];
}) {
  const { opts, ctx, active } = inputs;

  const stale: string[] = [];
  const verified: string[] = [];
  const reactivated: string[] = [];

  // Anchor verification depth is configurable:
  // - existence (default): cheap O(N) path presence only.
  // - content / git: deep verify via verifyMemoryAnchors (content hash,
  //   symbol, command; git blob when depth is git or the anchor carries one).
  if (opts?.verify !== false) {
    const depth = opts?.verifyDepth ?? 'existence';
    const verificationRunAt = ctx.nowIso();
    const verificationOutcomes = new Map<string, boolean>();
    // Stale memories are re-verified too. This pass used to demote active →
    // stale and never look back, and nothing else on the automatic path moves
    // stale → active: a memory whose file was restored or re-created stayed
    // out of search and injection for good.
    // Only memories verification itself demoted: a manually retired memory
    // (`memory_update status: "stale"`) must not be revived by a passing check.
    const staleMemories = (await ctx.listMemories({ status: 'stale', limit: 0 })).filter(
      (memory) => memory.anchors.length > 0 && isVerificationStale(memory),
    );
    const reactivations = new Map<string, MemoryAnchor[]>();

    if (depth === 'existence') {
      // Existence proves EXACTLY the anchor types that name a real path on
      // disk: `file`/`symbol`/`test`/`git` and `directory`/`package`.
      // `command` and `agent` carry no path and are left to the deep pass —
      // naming them here would resolve an unrelated path and then judge the
      // memory on it.
      const isPathAnchorType = (
        type: MemoryAnchor['type'],
      ): type is 'file' | 'symbol' | 'test' | 'git' | 'directory' | 'package' =>
        type === 'file' ||
        type === 'symbol' ||
        type === 'test' ||
        type === 'git' ||
        type === 'directory' ||
        type === 'package';

      const anchorPaths = new Set<string>();
      for (const m of active) {
        for (const anchor of m.anchors) {
          if (anchor.path && isPathAnchorType(anchor.type)) {
            anchorPaths.add(path.resolve(ctx.projectRoot, anchor.path));
          }
        }
      }
      const pathsToVerify = [...anchorPaths];
      // Resolved path -> whether it is a directory. Presence alone is not
      // enough: `anchorsPresentOnDisk` (sqlite-hygiene-anchors.ts:90-91) and the
      // deep pass (anchors/verify.ts:474-486) both demote a `directory`/`package`
      // anchor whose path still resolves but is no longer a directory, so the
      // cheap pass records the same fact rather than a bare existence flag.
      const existingPaths = new Map<string, boolean>();
      const realRoot = await fs.promises.realpath(ctx.projectRoot).catch(() => undefined);
      let nextPath = 0;
      const verifyWorker = async (): Promise<void> => {
        if (!realRoot) return;
        while (nextPath < pathsToVerify.length) {
          const anchorPath = pathsToVerify[nextPath++]!;
          try {
            const real = await fs.promises.realpath(anchorPath);
            const relative = path.relative(realRoot, real);
            if (
              relative === '..' ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative)
            ) {
              continue;
            }
            const stat = await fs.promises.stat(real);
            existingPaths.set(anchorPath, stat.isDirectory());
          } catch {
            // Missing, inaccessible, or broken-link anchors are stale.
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(32, pathsToVerify.length) }, () => verifyWorker()),
      );

      for (const m of active) {
        // A `directory`/`package` anchor names a path too: it must be present
        // AND still be a directory. Before this shared predicate existed, both
        // types fell through the `!(file|symbol|test|git)` test as TRUE for any
        // path, so a memory anchored to a deleted directory or package could
        // never be demoted by the DEFAULT existence depth — while the deep
        // pass (anchors/verify.ts), `existenceProvesAnchors` and
        // `anchorsPresentOnDisk` all treat it as stale. `command`/`agent`
        // anchors carry no path and stay out of existence's judgement.
        const allValid = m.anchors.every((anchor) => {
          if (!anchor.path) return true;
          if (!isPathAnchorType(anchor.type)) return true;
          const resolved = path.resolve(ctx.projectRoot, anchor.path);
          const isDirectory = existingPaths.get(resolved);
          if (isDirectory === undefined) return false; // missing or outside the root
          // A `directory`/`package` anchor must still name a directory.
          if (anchor.type === 'directory' || anchor.type === 'package') return isDirectory;
          return true;
        });
        verificationOutcomes.set(m.id, allValid);
        if (allValid) verified.push(m.id);
        else stale.push(m.id);
      }
      if (realRoot) {
        for (const m of staleMemories) {
          if (!existenceProvesAnchors(m.anchors)) continue;
          if (await anchorsPresentOnDisk(ctx.projectRoot, realRoot, m.anchors)) {
            reactivations.set(m.id, m.anchors);
          }
        }
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
            const result = await verifyMemoryAnchors(
              ctx.projectRoot,
              memory,
              verificationRunAt,
              undefined,
              ctx.symbolSpans,
            );
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
      let nextStale = 0;
      const staleWorker = async (): Promise<void> => {
        while (nextStale < staleMemories.length) {
          const memory = staleMemories[nextStale++]!;
          try {
            const result = await verifyMemoryAnchors(
              ctx.projectRoot,
              memory,
              verificationRunAt,
              undefined,
              ctx.symbolSpans,
            );
            // Only an explicit `verified` reactivates; `unknown` stays stale.
            if (result.status === 'verified') reactivations.set(memory.id, memory.anchors);
          } catch {
            // Fail-closed for reactivation: the memory stays stale.
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(DEEP_CONCURRENCY, staleMemories.length) }, () =>
          staleWorker(),
        ),
      );
    }

    // A memory's own `validity` source checks are part of whether it holds:
    // its anchor may still exist while the cited text is gone. Injection
    // already refuses such a memory; demoting it here also takes it out of
    // search and audience delivery. Checked for stale memories too, or the
    // anchor pass would revive one whose claim the code still contradicts on
    // every run (a revision and an HQ change per pass).
    const failingValidity = await failingValidityIds(ctx.projectRoot, [
      ...active,
      ...staleMemories,
    ]);
    for (const memoryId of failingValidity) {
      reactivations.delete(memoryId);
      if (verificationOutcomes.get(memoryId) === true) {
        verificationOutcomes.set(memoryId, false);
        const index = verified.indexOf(memoryId);
        if (index >= 0) verified.splice(index, 1);
        stale.push(memoryId);
      }
    }

    await ctx.runMutation(() => {
      for (const [memoryId, allValid] of verificationOutcomes) {
        const current = readSqliteSageRow(ctx.stmt, memoryId);
        if (!current) continue;
        if (current.status !== 'active') continue;
        if (allValid && current.anchors.length === 0) continue;
        if (allValid) {
          // Confirmed, not changed: bookkeeping only (see stampSqliteVerification).
          stampSqliteVerification(ctx.stmt, memoryId, verificationRunAt, 1);
          continue;
        }
        const updated = applySemanticChange(
          current,
          {
            status: 'stale' as const,
            lastVerifiedAt: verificationRunAt,
            staleReason: 'verification' as const,
          },
          ctx.nowIso(),
        );
        ctx.upsertMemory(updated);
        ctx.syncAnchorEdges(updated);
      }
      for (const [memoryId, observedAnchors] of reactivations) {
        const current = readSqliteSageRow(ctx.stmt, memoryId);
        // Re-read inside the mutation: a person may have retired it meanwhile.
        if (!current || !isVerificationStale(current)) continue;
        // Anchors edited while verification ran: what was verified is no
        // longer what the memory points at.
        if (anchorsChanged(current.anchors, observedAnchors)) continue;
        const updated = applySemanticChange(
          current,
          {
            status: 'active' as const,
            staleReason: undefined,
            lastVerifiedAt: verificationRunAt,
            freshness: 1,
          },
          ctx.nowIso(),
        );
        ctx.upsertMemory(updated);
        ctx.syncAnchorEdges(updated);
        reactivated.push(memoryId);
      }
    });
  }
  return { stale, verified, reactivated };
}

/** Ids of memories with a `source_contains` validity check the source no longer satisfies. */
async function failingValidityIds(
  projectRoot: string,
  memories: readonly Sage[],
): Promise<Set<string>> {
  const checked = memories.filter((memory) => memory.validity?.checks?.length);
  const failing = new Set<string>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < checked.length) {
      const memory = checked[next++]!;
      try {
        const snapshot = await snapshotMemoryEvidence(projectRoot, memory);
        // Only an explicit miss counts: an unreadable or oversized source is unknown.
        if (snapshot.validityChecks?.some((check) => check.status === 'not_satisfied')) {
          failing.add(memory.id);
        }
      } catch {
        // Fail-open: an evidence error never demotes a memory.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, checked.length) }, () => worker()));
  return failing;
}
