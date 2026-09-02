/**
 * WrongTrace gate-decision events.
 *
 * Emitted by the WrongTrace lock-gate hooks (see
 * `@wrongstack/wrongtrace` hooks.ts) through each host's EventBus:
 * every mutating tool call's gate decision is observable — denied edits,
 * fragile-file nudges, lock acquisition / race-loss / release.
 *
 * Kept structurally matching the adapter's `WrongTraceGateDecisionEvent`
 * union so core never imports the adapter (direction: wrongtrace is the
 * leaf; core must not depend on it).
 */
export interface WrongTraceEventMap {
  'wrongtrace.gate.decision': {
    kind: 'deny' | 'allow-fragile' | 'lock-acquired' | 'lock-conflict-race' | 'lock-released';
    /** Target file path the gate decided on. */
    path: string;
    /** `deny` — human-readable owner/expiry reason shown to the model. */
    reason?: string | undefined;
    /** `allow-fragile` — why the file is considered fragile. */
    reasons?: readonly string[] | undefined;
    /** `lock-acquired` — lock owner identity (`wrongstack:<sessionId>`). */
    owner?: string | undefined;
  };
}
