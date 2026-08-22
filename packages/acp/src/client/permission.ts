/**
 * Permission policy for ACP v1 client sessions.
 *
 * ACP agents can call `session/request_permission` to ask the user
 * before executing a tool call. The client is expected to surface
 * the question, get a decision, and respond. This module is the seam
 * where WrongStack-specific permission UI can plug in; for v1 we ship
 * a minimal default that auto-approves the first `allow_once` option
 * (or `allow_always` if present) and rejects on abort.
 */
import type {
  PermissionOption,
  RequestPermissionOutcome,
  ToolCallUpdateNotification,
} from '../types/acp-v1.js';

/** A single permission decision request. */
export interface PermissionRequest {
  toolCall: ToolCallUpdateNotification;
  options: readonly PermissionOption[];
  signal: AbortSignal;
}

/** A permission policy decides how to respond to a request. */
export type PermissionPolicy = (req: PermissionRequest) => Promise<RequestPermissionOutcome>;

/**
 * Default policy: pick the safest-looking allow option if the signal
 * is not aborted, otherwise report cancelled. Order of preference:
 *
 *   1. `allow_always`
 *   2. `allow_once`
 *   3. anything else with `optionId` (last resort)
 *
 * Real WrongStack permission UIs replace this; the contract is the
 * `PermissionPolicy` function type, not the implementation.
 */
function pickAllow(options: readonly PermissionOption[]): RequestPermissionOutcome {
  const ranked = [...options].sort((a, b) => {
    const score = (k: PermissionOption['kind']): number => {
      if (k === 'allow_once') return 0; // prefer once over always — least standing grant
      if (k === 'allow_always') return 1;
      if (k === 'reject_once') return 2;
      return 3;
    };
    return score(a.kind) - score(b.kind);
  });
  const chosen = ranked[0];
  if (!chosen || chosen.kind === 'reject_once' || chosen.kind === 'reject_always') {
    return { outcome: 'cancelled' };
  }
  return { outcome: 'selected', optionId: chosen.optionId };
}

function pickReject(options: readonly PermissionOption[]): RequestPermissionOutcome {
  const reject = options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
  return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
}

/**
 * Tool kinds considered side-effect-free (safe to auto-approve even in a
 * non-interactive run). Everything else (edit/delete/move/execute) mutates
 * the workspace or runs commands and should be gated by a real policy.
 */
const READ_ONLY_KINDS = new Set(['read', 'search', 'fetch', 'think']);

/**
 * Default policy: auto-approve the least-standing allow option.
 *
 * ⚠️ This auto-approves EVERY tool call, including file writes and shell
 * commands. It exists so non-interactive contexts (CLI `acp spawn`,
 * the Director fan-out) work without a human in the loop. Interactive
 * surfaces (TUI/WebUI) MUST inject a policy that surfaces the request to
 * the user — pass `permissionPolicy` to `ACPSession` / the subagent runner.
 *
 * NOTE: This is NO LONGER the default for `ACPSession` — the session now
 * defaults to {@link readOnlyPermissionPolicy} (safe-by-default). Pass this
 * policy explicitly when the agent is trusted and needs write/execute access.
 */
export const defaultPermissionPolicy: PermissionPolicy = async (req) => {
  if (req.signal.aborted) return { outcome: 'cancelled' };
  return pickAllow(req.options);
};

/**
 * Safe-by-default policy: auto-approve only side-effect-free tool calls
 * (read/search/fetch/think); reject anything that would write files or
 * run commands. This is the DEFAULT policy for `ACPSession` when no
 * `permissionPolicy` is provided. Pass {@link defaultPermissionPolicy}
 * explicitly when the agent is trusted and needs write/execute access.
 */
export const readOnlyPermissionPolicy: PermissionPolicy = async (req) => {
  if (req.signal.aborted) return { outcome: 'cancelled' };
  const kind = req.toolCall.kind;
  if (kind && READ_ONLY_KINDS.has(kind)) {
    return pickAllow(req.options);
  }
  return pickReject(req.options);
};

/**
 * Build a policy from a yes/no decision function. The decider receives the
 * tool call (title + kind + rawInput) and returns whether to allow it.
 * This is the seam an interactive host (TUI/WebUI confirm prompt, trust
 * store, exec-allowlist) plugs into.
 */
export function makePermissionPolicy(
  decide: (req: PermissionRequest) => boolean | Promise<boolean>,
): PermissionPolicy {
  return async (req) => {
    if (req.signal.aborted) return { outcome: 'cancelled' };
    const allow = await decide(req);
    return allow ? pickAllow(req.options) : pickReject(req.options);
  };
}
