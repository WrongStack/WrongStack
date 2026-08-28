/**
 * Pure decision logic for the chat-input auto-collapse state machine.
 *
 * ChatView keeps `inputCollapsed` (a thin bar hides the full input) and two
 * transition refs: `prevHadMessages` (transcript presence on the last render)
 * and `prevAutoCollapse` (the pref on the last render). This function decides
 * whether the input should collapse given the CURRENT values and those
 * previous values — it fires only on transitions, never on steady state:
 *
 *  1. 0→N transcript arrival while the pref is on — covers fresh connects
 *     where history lands via WS replay AFTER mount, so the mount-time
 *     initializer saw an empty transcript.
 *  2. The pref flips false→true while history is already present — instant
 *     feedback for the opt-in toggle (mirrors the manual Collapse button).
 *  3. A session switch (sessionId changed to a new non-null id) while the
 *     pref is on and the new transcript has messages — session resume
 *     replaces the transcript wholesale (N→M in one commit, never through
 *     0), so the length transition alone would miss it.
 *
 * Deliberately NOT a trigger: plain message growth after history exists
 * (a manual expand stays sticky), and a pref flip while there is no history
 * (nothing to collapse yet). The ChatView caller additionally gates the whole
 * decision on `!isLoading` so a run in flight never collapses the input —
 * the user's first send in a fresh session is itself a 0→N arrival.
 *
 * Extracted as a pure function so the decision matrix is unit-testable
 * without mounting the heavy ChatView dependency graph.
 */
interface AutoCollapseDecision {
  /** Current transcript presence (messages.length > 0). */
  hasMessages: boolean;
  /** Current value of the autoCollapseInput pref. */
  autoCollapseInput: boolean;
  /** True when the active session id changed to a new non-null id. */
  sessionChanged: boolean;
  /** Transcript presence at the last render/effect run. */
  prevHadMessages: boolean;
  /** Pref value at the last render/effect run. */
  prevAutoCollapse: boolean;
}

export function shouldAutoCollapse(decision: AutoCollapseDecision): boolean {
  const { hasMessages, autoCollapseInput, sessionChanged, prevHadMessages, prevAutoCollapse } =
    decision;
  return (
    autoCollapseInput && hasMessages && (sessionChanged || !prevHadMessages || !prevAutoCollapse)
  );
}
