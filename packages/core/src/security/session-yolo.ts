/**
 * YOLO+ for a subagent follows the conversation that spawned it.
 *
 * A leader reads YOLO and YOLO+ from its own conversation's `ctx.meta` (one
 * WebUI tab, one meta). Subagents live in ONE process-wide fleet host shared by
 * every tab, so a subagent cannot read "the" meta — it has to find its own
 * tab's. A host that keeps several conversations registers how to find a
 * conversation's leader meta by session id; a subagent then answers with the
 * leader policy's own rule (`yoloModeFor`) on that meta, so one tab's YOLO+
 * never widens another tab's workers. A host with one conversation registers
 * nothing and the caller's fallback (the live config) answers, as before.
 *
 * The resolver sits on `globalThis` under a `Symbol.for` key: the fleet host
 * and the WebUI host can be bundled separately, and a module-level variable
 * would give each bundle its own empty copy.
 */
import type { PermissionPolicy } from '@wrongstack/contracts/types/permission';

type LeaderMetaResolver = (sessionId: string) => Record<string, unknown> | undefined;

const STORE_KEY = Symbol.for('wrongstack.security.sessionLeaderMeta');

function store(): { resolver?: LeaderMetaResolver | undefined } {
  const g = globalThis as unknown as Record<symbol, { resolver?: LeaderMetaResolver } | undefined>;
  let s = g[STORE_KEY];
  if (!s) {
    s = {};
    g[STORE_KEY] = s;
  }
  return s;
}

/**
 * Register how to find a conversation's leader meta. Returns an unregister
 * function that only clears the resolver if it is still this one.
 */
export function setSessionLeaderMetaResolver(resolver: LeaderMetaResolver): () => void {
  const s = store();
  s.resolver = resolver;
  return () => {
    if (s.resolver === resolver) s.resolver = undefined;
  };
}

/**
 * Whether YOLO+ is in force for a subagent spawned by `sessionId`. Read on
 * every call so a toggle in that tab reaches workers already running.
 *
 * - The tab is known: its leader's verdict — YOLO+ only while that tab is in
 *   YOLO+ (and therefore YOLO), whatever any other tab says.
 * - The tab is unknown (single-conversation host, or the tab is gone): the
 *   `fallback`.
 */
export function subagentYoloPlus(input: {
  sessionId: string | undefined;
  leaderPolicy: PermissionPolicy | undefined;
  fallback: () => boolean;
}): boolean {
  const meta = input.sessionId ? store().resolver?.(input.sessionId) : undefined;
  if (!meta) return input.fallback();
  if (input.leaderPolicy?.yoloModeFor) return input.leaderPolicy.yoloModeFor({ meta }).yoloPlus;
  // No policy to ask: only an explicit per-tab YOLO + YOLO+ counts.
  return meta['yolo'] === true && meta['yoloPlus'] === true;
}
