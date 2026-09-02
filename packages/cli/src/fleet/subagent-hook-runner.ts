import { HookRegistry, HookRunner } from '@wrongstack/core/hooks';

import { createWrongTraceHookPair } from '../wiring/wrongtrace-hooks.js';

/** Tools that mutate a single target file — must match lifecycle-plugins.ts. */
const WRONGTRACE_MATCHER = 'edit|write|replace|patch|codebase-ast-replace';

/**
 * Dedicated WrongTrace-only HookRunner for fleet subagents.
 *
 * Why not hand subagents the leader's own HookRunner: the leader's
 * HookRegistry also carries shell hooks loaded from `config.hooks`, and
 * those are a leader-session automation surface — replaying them on every
 * worker tool call would be a silent behavior change beyond WrongTrace.
 * This runner registers ONLY the fail-open lock-gate hooks, so a worker's
 * `edit`/`write`/`replace`/`patch`/`codebase-ast-replace` call honors
 * peer locks exactly like the leader does while nothing else changes.
 *
 * Lock claims are stamped `wrongstack:<leaderSessionId>` — one process,
 * one lock-owner identity; per-worker ids would fragment the TTL picture
 * without adding safety (the daemon lock is advisory coordination).
 *
 * Mirrors the registration contract in lifecycle-plugins.ts (same events,
 * same matcher, same owner id). If production drifts, update both.
 * `emit` (optional) forwards typed gate-decision events to the host bus.
 */
export function createSubagentWrongTraceHookRunner(
  sessionId: () => string,
  emit?: (event: import('@wrongstack/wrongtrace').WrongTraceGateDecisionEvent) => void,
): HookRunner {
  const registry = new HookRegistry();
  // Per-runner pair: pre/post share one lock set, so one executor's release
  // can never free another executor's active claim (see hooks.ts concurrency
  // note). Same events/matcher/owner contract as lifecycle-plugins.ts.
  const hooks = createWrongTraceHookPair(sessionId, {
    emit: (event) => emit?.(event),
  });
  registry.registerInProcess('PreToolUse', WRONGTRACE_MATCHER, hooks.preToolUse, 'wrongtrace-gate');
  registry.registerInProcess(
    'PostToolUse',
    WRONGTRACE_MATCHER,
    hooks.postToolUse,
    'wrongtrace-gate',
  );
  // allowNonPolicy: true — these hooks are coordination, not enforcement;
  // they are fail-open by construction and must run regardless of any
  // shell-hook gating the leader applied to config-declared hooks.
  return new HookRunner({ registry, sessionId, allowNonPolicy: true });
}
