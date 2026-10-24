/**
 * The leader's own reasoning-effort override (`leader_effort_set`).
 *
 * The leader may raise or lower its OWN effort mid-session when the work
 * changes shape — deep debugging wants more thinking than a run of mechanical
 * edits. That is a statement the leader makes, and it must never outrank the
 * user: whatever the user picks afterwards, on any surface, wins.
 *
 * So the override is NOT written into the user's own fields
 * (`Config.modelRuntime.reasoning.effort`, or the conversation's
 * `reasoningEffort` pref). It lives in its own conversation-meta record that
 * remembers what the user's two settings were when the leader spoke. It stays
 * in force only while both are still exactly that; the moment the user changes
 * either one (`/effort`, Settings, the WebUI composer select), the record goes
 * dormant and the user's choice applies — with no extra wiring in any of those
 * paths.
 *
 * Leaf module: imported by the request middleware (`model-runtime.ts`) and by
 * the tool, so neither has to reach into the other.
 */

import type { ReasoningEffort } from '@wrongstack/contracts/types/provider';
import { isReasoningEffort } from '@wrongstack/contracts/types/provider';
import type { SessionEvent } from '@wrongstack/contracts/types/session';

/** Conversation-meta key holding the {@link LeaderEffortOverride} record. */
export const LEADER_EFFORT_META_KEY = 'leaderReasoningEffort';

export interface LeaderEffortOverride {
  effort: ReasoningEffort;
  /** Project-wide effort (`Config.modelRuntime.reasoning.effort`) when the leader spoke. */
  baseProject: string | null;
  /** The conversation's own `reasoningEffort` pref when the leader spoke. */
  baseConversation: string | null;
  /** Why the leader changed it — shown back by `show`. */
  reason?: string | undefined;
  at: string;
}

function normalized(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The stored record, when well-formed. Does not judge whether it is still in force. */
export function readLeaderEffortOverride(
  meta: Record<string, unknown> | undefined,
): LeaderEffortOverride | undefined {
  const raw = meta?.[LEADER_EFFORT_META_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Partial<LeaderEffortOverride>;
  if (!isReasoningEffort(rec.effort)) return undefined;
  return {
    effort: rec.effort,
    baseProject: normalized(rec.baseProject),
    baseConversation: normalized(rec.baseConversation),
    ...(typeof rec.reason === 'string' ? { reason: rec.reason } : {}),
    at: typeof rec.at === 'string' ? rec.at : '',
  };
}

/**
 * The leader's effort, if its override is still in force: the user has
 * changed neither the project-wide effort nor this conversation's effort
 * since the leader set it.
 */
export function activeLeaderEffort(
  meta: Record<string, unknown> | undefined,
  projectEffort: unknown,
): ReasoningEffort | undefined {
  const rec = readLeaderEffortOverride(meta);
  if (!rec) return undefined;
  if (rec.baseProject !== normalized(projectEffort)) return undefined;
  if (rec.baseConversation !== normalized(meta?.['reasoningEffort'])) return undefined;
  return rec.effort;
}

/** Record a leader override against the user's current settings. */
export function writeLeaderEffortOverride(
  meta: Record<string, unknown>,
  effort: ReasoningEffort,
  projectEffort: unknown,
  reason?: string | undefined,
): LeaderEffortOverride {
  const rec: LeaderEffortOverride = {
    effort,
    baseProject: normalized(projectEffort),
    baseConversation: normalized(meta['reasoningEffort']),
    ...(reason ? { reason } : {}),
    at: new Date().toISOString(),
  };
  meta[LEADER_EFFORT_META_KEY] = rec;
  return rec;
}

/** Drop the leader override; the user's setting applies again. */
export function clearLeaderEffortOverride(meta: Record<string, unknown> | undefined): boolean {
  if (!meta || !(LEADER_EFFORT_META_KEY in meta)) return false;
  delete meta[LEADER_EFFORT_META_KEY];
  return true;
}

/**
 * The leader conversation's own effort, as it would reach the wire: the
 * leader's in-force override, else the conversation's concrete
 * `reasoningEffort` pref (`auto` = follow the project, so no answer). Undefined
 * means the project setting applies.
 */
export function conversationEffort(
  meta: Record<string, unknown> | undefined,
  projectEffort: unknown,
): ReasoningEffort | undefined {
  const leader = activeLeaderEffort(meta, projectEffort);
  if (leader) return leader;
  const own = meta?.['reasoningEffort'];
  return isReasoningEffort(own) ? own : undefined;
}

/**
 * The two meta keys {@link conversationEffort} reads, copied off a live
 * conversation. Stamped on a worker at spawn time so the resolver can judge
 * them against the project effort it resolves with — without holding the
 * leader's live (and mutable) meta bag.
 */
export function snapshotConversationEffort(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const snap: Record<string, unknown> = {};
  if (meta['reasoningEffort'] !== undefined) snap['reasoningEffort'] = meta['reasoningEffort'];
  if (meta[LEADER_EFFORT_META_KEY] !== undefined) {
    snap[LEADER_EFFORT_META_KEY] = meta[LEADER_EFFORT_META_KEY];
  }
  return Object.keys(snap).length > 0 ? snap : undefined;
}

/**
 * Resume: replay the journal's last `leader_effort` event onto a conversation's
 * meta. The record keeps its baselines, so if the user changed effort while
 * the session was closed the override comes back dormant, exactly as it would
 * have been live. A journal with no such event leaves the meta untouched.
 */
export function restoreLeaderEffortOverride(
  meta: Record<string, unknown> | undefined,
  events: readonly SessionEvent[] | undefined,
): void {
  if (!meta) return;
  let last: { override: unknown } | undefined;
  for (const event of events ?? []) {
    if (event.type === 'leader_effort') last = event;
  }
  if (!last) return;
  const rec = readLeaderEffortOverride({ [LEADER_EFFORT_META_KEY]: last.override });
  if (rec) meta[LEADER_EFFORT_META_KEY] = rec;
  else delete meta[LEADER_EFFORT_META_KEY];
}
