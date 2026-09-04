import type { ToolCallPipelinePayload } from "@wrongstack/core/agent";
import {
  memoryQueryRelevance,
  memorySemanticRelevance,
  memoryStructuralRelevance,
} from "../retrieval/relevance.js";
import type { VectorAugmentHit } from "../retrieval/vector-augment.js";
import { normalizeTextKey } from "../store-helpers.js";
import type { Sage } from "../types.js";
import {
  contextualInjectionScore,
  MIN_CONTAINS_LENGTH,
  MIN_RELATION_STRENGTH,
} from "./tool-call-memory-scoring.js";
import type {
  ExtractedTriggerContext,
  MemoryToolTrigger,
} from "./tool-call-memory-triggers.js";
import { isMutationTrigger } from "./tool-call-memory-triggers.js";

export interface RetrievedMemory {
  memory: Sage;
  relationStrength: number;
  retrievalReasons: string[];
}

export interface SageRetrieverLike {
  retrieveForPath(opts: {
    path: string;
    limit?: number;
    includeAncestors?: boolean;
    includeStatuses?: Sage["status"][];
    includeAudienceScoped?: boolean;
    sessionId?: string | undefined;
    includeAllSessions?: boolean | undefined;
  }): Promise<Sage[]>;
  searchSage(
    query: string,
    opts?: {
      limit?: number;
      kind?: Sage["kind"];
      types?: Sage["kind"][];
      includeAudienceScoped?: boolean;
      requireAllTerms?: boolean;
      sessionId?: string | undefined;
      includeAllSessions?: boolean | undefined;
    },
  ): Promise<Sage[]>;
  /**
   * Rich variant of `searchSage` carrying per-channel scores. Optional: only
   * ports that can produce the breakdown implement it (the in-process store,
   * and any port wrapped for vector recall). When present it is preferred,
   * because the flat `searchSage` shape discards `vectorScore` — and without
   * that score a semantic-only hit has no admissible evidence at all (see
   * `memorySemanticRelevance`).
   */
  searchSageWithBreakdown?(
    query: string,
    opts?: {
      limit?: number;
      includeAudienceScoped?: boolean;
      requireAllTerms?: boolean;
      sessionId?: string | undefined;
      includeAllSessions?: boolean | undefined;
    },
  ): Promise<VectorAugmentHit[]>;
  findRelatedSage?(
    seedIds: string[],
    opts?: {
      limit?: number;
      maxDepth?: number;
      includeStatuses?: Sage["status"][];
      includeAudienceScoped?: boolean;
      sessionId?: string | undefined;
      includeAllSessions?: boolean | undefined;
    },
  ): Promise<Sage[]>;
  recordInjection?(
    memoryIds: string[],
    trigger: MemoryToolTrigger | string,
    sessionId?: string | undefined,
  ): void | Promise<void>;
  recordUse?(
    memoryIds: string[],
    source: string,
    sessionId?: string | undefined,
  ): void | Promise<void>;
  verifyForPaths?(paths: string[], signal?: AbortSignal): Promise<unknown>;
}

const MIN_ANCESTOR_ANCHOR_SEGMENTS = 2;
const ANCESTOR_DECAY_PER_SEGMENT = 0.11;

export function pathAnchorRelation(
  memory: Sage,
  relPath: string,
): { strength: number; reason: string } | undefined {
  if (!relPath || relPath === ".") return undefined;
  const targetDepth = relPath.split("/").filter(Boolean).length;
  let best: { strength: number; reason: string } | undefined;
  for (const anchor of memory.anchors) {
    // Every path-bearing anchor counts — `symbol` and `command` anchors pin a
    // narrower scope than a bare `file` anchor, so an exact path hit scores
    // higher (matches memoryQueryRelevance / trigger scoring). Accumulate the
    // strongest candidate instead of returning on the first match: anchor
    // order must not determine the score when both a file and a symbol anchor
    // target the same path.
    if (!anchor.path) continue;
    const anchorNorm = anchor.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (
      (anchor.type === "file" ||
        anchor.type === "symbol" ||
        anchor.type === "command") &&
      anchorNorm === relPath
    ) {
      const exact =
        anchor.type === "symbol" || anchor.type === "command" ? 0.98 : 0.95;
      if (!best || exact > best.strength) {
        best = {
          strength: exact,
          reason: `anchor:exact-${anchor.type}:${anchorNorm}`,
        };
      }
      continue;
    }
    const isPrefix = relPath.startsWith(`${anchorNorm}/`);
    if (isPrefix) {
      const anchorSegments = anchorNorm.split("/").filter(Boolean);
      if (anchorSegments.length < MIN_ANCESTOR_ANCHOR_SEGMENTS) continue;
      const distance = targetDepth - anchorSegments.length;
      const decayed = Math.max(
        0.35,
        0.95 - distance * ANCESTOR_DECAY_PER_SEGMENT,
      );
      if (!best || decayed > best.strength) {
        best = {
          strength: decayed,
          reason: `anchor:ancestor:${anchorNorm}+${distance}`,
        };
      }
    }
  }
  return best;
}

function relativeProjectPath(
  projectRoot?: string,
  targetPath?: string,
): string {
  if (!targetPath) return "";
  const normalized = targetPath.replace(/\\/g, "/");
  if (!projectRoot) return normalized;
  const root = projectRoot.replace(/\\/g, "/");
  if (normalized.startsWith(`${root}/`)) {
    return normalized.slice(root.length + 1);
  }
  return normalized;
}

export function dedupeRetrievedByText(
  memories: RetrievedMemory[],
): RetrievedMemory[] {
  const seen = new Set<string>();
  return memories.filter(({ memory }) => {
    const key = normalizeTextKey(memory.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function selectDiverseMemories(
  memories: Sage[],
  limit: number,
  reasonsById: Map<string, string[]> = new Map(),
): {
  selected: Sage[];
  dropped: ReadonlyArray<{ memory: Sage; reason: string }>;
} {
  const dropped: { memory: Sage; reason: string }[] = [];
  if (limit <= 0) {
    for (const memory of memories) {
      dropped.push({ memory, reason: `diversity cap is 0 (limit=${limit})` });
    }
    return { selected: [], dropped };
  }
  const selected: Sage[] = [];
  const deferred: Sage[] = [];
  const byKind = new Map<Sage["kind"], number>();
  let queryOnly = 0;
  let graphOnly = 0;
  for (const memory of memories) {
    const reasons = reasonsById.get(memory.id) ?? [];
    const hasPath = reasons.some((reason) => reason.startsWith("anchor:"));
    const hasGraph = reasons.some((reason) => reason.startsWith("graph:"));
    const hasQuery = reasons.some((reason) => reason.startsWith("query:"));
    if (!hasPath && hasGraph && graphOnly >= 1) {
      dropped.push({
        memory,
        reason: `graph-only diversity cap (1) for kind=${memory.kind}`,
      });
      continue;
    }
    if (!hasPath && !hasGraph && hasQuery && queryOnly >= 2) {
      dropped.push({
        memory,
        reason: `query-only diversity cap (2) for kind=${memory.kind}`,
      });
      continue;
    }
    const count = byKind.get(memory.kind) ?? 0;
    if (count >= 3) {
      deferred.push(memory);
      continue;
    }
    selected.push(memory);
    if (!hasPath && hasGraph) graphOnly++;
    else if (!hasPath && hasQuery) queryOnly++;
    byKind.set(memory.kind, count + 1);
    if (selected.length >= limit) {
      for (let i = memories.indexOf(memory) + 1; i < memories.length; i++) {
        const rest = memories[i]!;
        dropped.push({
          memory: rest,
          reason: `limit=${limit} reached before kind-diversity`,
        });
      }
      for (const pending of deferred) {
        dropped.push({
          memory: pending,
          reason: `limit=${limit} reached before kind-diversity (deferred drain)`,
        });
      }
      return { selected, dropped };
    }
  }
  for (const memory of deferred) {
    if (selected.length >= limit) {
      dropped.push({
        memory,
        reason: `deferred list exhausted; limit=${limit}`,
      });
      continue;
    }
    const reasons = reasonsById.get(memory.id) ?? [];
    const hasPath = reasons.some((reason) => reason.startsWith("anchor:"));
    const hasGraph = reasons.some((reason) => reason.startsWith("graph:"));
    const hasQuery = reasons.some((reason) => reason.startsWith("query:"));
    if (!hasPath && hasGraph && graphOnly >= 1) {
      dropped.push({
        memory,
        reason: `graph-only diversity cap (1) for kind=${memory.kind}`,
      });
      continue;
    }
    if (!hasPath && !hasGraph && hasQuery && queryOnly >= 2) {
      dropped.push({
        memory,
        reason: `query-only diversity cap (2) for kind=${memory.kind}`,
      });
      continue;
    }
    selected.push(memory);
    if (!hasPath && hasGraph) graphOnly++;
    else if (!hasPath && hasQuery) queryOnly++;
  }
  return { selected, dropped };
}

export function applyCooldown(
  memories: Sage[],
  seen: Map<string, number>,
  repeatCooldownMs: number,
  sessionId?: string | undefined,
): Sage[] {
  const now = Date.now();
  return memories.filter((memory) => {
    const key = cooldownKey(memory.id, sessionId);
    const last = seen.get(key);
    if (last === undefined) return true;
    if (repeatCooldownMs <= 0 || !Number.isFinite(repeatCooldownMs))
      return false;
    return now - last >= repeatCooldownMs;
  });
}

export function cooldownKey(
  memoryId: string,
  sessionId?: string | undefined,
): string {
  return `${sessionId || "<no-session>"}:${memoryId}`;
}

export function pruneCooldowns(
  seen: Map<string, number>,
  pruneState: { lastPruneAt: number },
  now: number,
  repeatCooldownMs: number,
): void {
  if (repeatCooldownMs <= 0 || !Number.isFinite(repeatCooldownMs)) return;
  if (now - pruneState.lastPruneAt < 60_000) return;
  pruneState.lastPruneAt = now;
  for (const [id, timestamp] of seen) {
    if (now - timestamp >= repeatCooldownMs) seen.delete(id);
  }
}

export function visibleContextText(payload: ToolCallPipelinePayload): string {
  const parts: string[] = [];
  if (typeof payload.result?.content === "string") {
    parts.push(payload.result.content.toLowerCase());
  }
  const prompt = (
    payload.ctx as { systemPrompt?: Array<{ text?: string }> } | undefined
  )?.systemPrompt;
  if (Array.isArray(prompt)) {
    for (const block of prompt) {
      if (typeof block?.text === "string") parts.push(block.text.toLowerCase());
    }
  }
  return parts.length > 0 ? `${parts.join("\n")}\n` : "";
}

export function containsMemoryText(
  visibleContext: string,
  memoryText: string,
): boolean {
  const haystack = visibleContext.toLowerCase();
  const needle = memoryText.trim().toLowerCase();
  if (needle.length < MIN_CONTAINS_LENGTH) return false;
  return haystack.includes(needle);
}

export function availableHintChars(
  payload: ToolCallPipelinePayload,
  configured: number,
): number {
  const wanted = Math.max(0, Math.floor(configured));
  const cap = payload.tool?.maxOutputBytes;
  if (!cap) return wanted;
  const remainingBytes =
    cap - Buffer.byteLength(payload.result.content, "utf8") - 2;
  return Math.max(0, Math.min(wanted, Math.floor(remainingBytes / 3)));
}

export async function retrieveTriggeredMemories(
  memory: SageRetrieverLike,
  trigger: ExtractedTriggerContext,
  limit: number,
  projectRoot?: string | undefined,
  relationFloor?: number | undefined,
  sessionId?: string | undefined,
): Promise<RetrievedMemory[]> {
  const candidateLimit = Math.max(limit * 2, limit);
  const pending: Array<Promise<RetrievedMemory[]>> = trigger.paths.map((p) =>
    memory
      .retrieveForPath({
        path: p,
        limit: candidateLimit,
        includeAncestors: true,
        includeStatuses: isMutationTrigger(trigger.trigger)
          ? ["active", "stale"]
          : ["active"],
        includeAudienceScoped: false,
        sessionId,
      })
      .then((matches) =>
        matches.flatMap((item) => {
          const relation = pathAnchorRelation(
            item,
            relativeProjectPath(projectRoot, p),
          );
          if (!relation) return [];
          return [
            {
              memory: item,
              relationStrength: relation.strength,
              retrievalReasons: [relation.reason],
            },
          ];
        }),
      ),
  );
  if (trigger.queryText.trim()) {
    const searchOptions = {
      limit: Math.max(candidateLimit * 4, 64),
      includeAudienceScoped: false,
      // Deliberately NOT `requireAllTerms`. The query handed to this
      // channel is `enrichPathQuery`'s output — the full path plus its
      // basename, stem and parent directory (e.g.
      // `packages/sage/src/retrieval/format.ts format.ts format retrieval`)
      // — which FTS5 expands into six ANDed prefix terms. Requiring all of
      // them meant a memory only matched if its text literally quoted the
      // whole path, so the query channel returned nothing on almost every
      // tool call and path anchors were doing all the work alone.
      //
      // Precision does not come from the MATCH here; it comes from the
      // `relationFloor` gate downstream (0.85 by default), which admits
      // only an exact anchor value in the query, two or more anchor-term
      // matches, three or more tag matches, or five-plus text terms that
      // cover the question. Letting the any-term retry run widens recall
      // without moving that bar.
      sessionId,
    };
    // Score one search hit against BOTH channels and keep the stronger
    // evidence. `vectorScore` is null for a purely lexical hit, and
    // `memoryQueryRelevance` is 0 for a purely semantic one — taking the max
    // is what lets a single gate serve both without a second threshold.
    const scoreHit = (
      item: Sage,
      vectorScore: number | null,
    ): RetrievedMemory => {
      const lexical = memoryQueryRelevance(item, trigger.queryText);
      const semantic = memorySemanticRelevance(vectorScore);
      const evidence = [...lexical.evidence, ...semantic.evidence];
      return {
        memory: item,
        relationStrength: Math.max(lexical.strength, semantic.strength),
        retrievalReasons:
          evidence.length > 0 ? evidence : ["query:insufficient-evidence"],
      };
    };
    pending.push(
      memory.searchSageWithBreakdown
        ? memory
            .searchSageWithBreakdown(trigger.queryText, searchOptions)
            .then((hits) =>
              hits.map((hit) => scoreHit(hit.memory, hit.vectorScore)),
            )
        : memory
            .searchSage(trigger.queryText, searchOptions)
            .then((matches) => matches.map((item) => scoreHit(item, null))),
    );
  }
  const byId = new Map<string, RetrievedMemory>();
  for (const matches of await Promise.all(pending)) {
    for (const item of matches) {
      const existing = byId.get(item.memory.id);
      if (!existing) {
        byId.set(item.memory.id, item);
      } else {
        byId.set(item.memory.id, {
          memory:
            item.relationStrength > existing.relationStrength
              ? item.memory
              : existing.memory,
          relationStrength: Math.max(
            item.relationStrength,
            existing.relationStrength,
          ),
          retrievalReasons: [
            ...new Set([
              ...existing.retrievalReasons,
              ...item.retrievalReasons,
            ]),
          ],
        });
      }
    }
  }

  const graphSeeds = [...byId.values()].filter(
    (item) =>
      item.relationStrength >= 0.9 &&
      item.retrievalReasons.some(
        (reason) =>
          reason.startsWith("anchor:") || reason.startsWith("query:exact-"),
      ),
  );
  if (memory.findRelatedSage && graphSeeds.length > 0) {
    const related = await memory.findRelatedSage(
      graphSeeds.map((item) => item.memory.id),
      {
        limit: candidateLimit,
        maxDepth: 2,
        includeStatuses: isMutationTrigger(trigger.trigger)
          ? ["active", "stale"]
          : ["active"],
        includeAudienceScoped: false,
        sessionId,
      },
    );
    for (const item of related) {
      const relevance = memoryStructuralRelevance(
        item,
        graphSeeds.map((seed) => seed.memory),
      );
      if (
        !byId.has(item.id) &&
        relevance.strength >= (relationFloor ?? MIN_RELATION_STRENGTH)
      ) {
        byId.set(item.id, {
          memory: item,
          relationStrength: relevance.strength,
          retrievalReasons: relevance.evidence,
        });
      }
    }
  }

  return [...byId.values()]
    .filter(
      ({ memory: item }) =>
        (item.status === "active" || item.status === "stale") &&
        item.contextPolicy !== "never" &&
        item.kind !== "memory_review",
    )
    .sort(
      (a, b) =>
        contextualInjectionScore(b.memory, b.relationStrength) -
        contextualInjectionScore(a.memory, a.relationStrength),
    );
}
