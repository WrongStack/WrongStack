export type ConfirmDecision = 'yes' | 'no' | 'always' | 'deny';

export interface PendingConfirm {
  resolve: (decision: ConfirmDecision) => void;
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

export function resolveYoloEligiblePendingConfirms(
  pendingConfirms: Map<string, PendingConfirm>,
): void {
  for (const [id, confirm] of pendingConfirms) {
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
