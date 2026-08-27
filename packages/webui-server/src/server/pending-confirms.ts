export type ConfirmDecision = 'yes' | 'no' | 'always' | 'deny';

export interface PendingConfirm {
  resolve: (decision: ConfirmDecision) => void;
  /**
   * Session this prompt belongs to. `pendingConfirms` is one process-wide map
   * replayed to every connected client, and the resolver keyed only on a
   * client-supplied id — with a session check that no-op'd whenever the client
   * omitted `sessionId`. So any client could answer any session's prompt
   * (WS-082). Recorded here so ownership is checked against the server's own
   * record rather than against whatever the client chose to send.
   */
  sessionId?: string | undefined;
  decisionSource?: string | undefined;
  riskTier?: 'safe' | 'standard' | 'destructive' | undefined;
  boundaryReason?: string | undefined;
  /** The exact `tool.confirm_needed` broadcast payload, kept so the prompt
   *  can be replayed to clients that connect while the confirm is pending
   *  (e.g. a browser refresh mid-prompt). */
  payload?: Record<string, unknown> | undefined;
}

export function isDestructivePendingConfirm(confirm: PendingConfirm): boolean {
  return confirm.riskTier === 'destructive' || confirm.decisionSource === 'yolo_destructive';
}

/**
 * Answer "yes" to the prompts YOLO now covers — for ONE session.
 *
 * `pendingConfirms` is one process-wide map holding the prompts of every open
 * tab. YOLO is a per-tab preference, so sweeping the whole map meant turning
 * it on in one tab silently approved the tool waiting on a prompt in another —
 * a conversation the user was not even looking at. Passing no session keeps
 * the old blanket behaviour for single-session hosts.
 */
export function resolveYoloEligiblePendingConfirms(
  pendingConfirms: Map<string, PendingConfirm>,
  sessionId?: string | undefined,
): void {
  for (const [id, confirm] of pendingConfirms) {
    // A prompt with no recorded owner belongs to the only session there is.
    if (
      sessionId !== undefined &&
      confirm.sessionId !== undefined &&
      confirm.sessionId !== sessionId
    )
      continue;
    if (confirm.boundaryReason) continue;
    // WS-022: this skipped only `boundaryReason` (set solely for kanban gate
    // violations), so flipping YOLO on blanket-answered "yes" to every prompt
    // already on screen — including a destructive one. `isDestructive
    // PendingConfirm` is declared directly above for exactly this and was
    // never called.
    if (isDestructivePendingConfirm(confirm)) continue;
    pendingConfirms.delete(id);
    confirm.resolve('yes');
  }
}

export function resolveAllPendingConfirms(
  pendingConfirms: Map<string, PendingConfirm>,
  decision: ConfirmDecision,
): void {
  for (const [id, confirm] of pendingConfirms) {
    pendingConfirms.delete(id);
    confirm.resolve(decision);
  }
}
