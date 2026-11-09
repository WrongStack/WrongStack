export interface CostTrackerConfig {
  budgetLimit: number;
  warningThreshold: number;
  /**
   * When > 0, the plugin posts a compact cost digest to the project
   * mailbox every N provider responses. Useful for fleet operators
   * who want a running total in their mailbox without polling the
   * `cost_summary` tool. Disabled (0) by default — set to 10 to get
   * a digest roughly every 10 LLM calls.
   */
  mailboxDigestEveryN: number;
  /**
   * Mailbox recipient. Defaults to `cost-tracker` (self-loop is fine
   * for the dedicated inbox view) or set to `*` to broadcast.
   */
  mailboxDigestTo: string;
}

/**
 * Read budget + warning-threshold from the user's config.
 *
 * @internal
 */
export function readCostTrackerConfig(raw: Record<string, unknown> | undefined): CostTrackerConfig {
  const digestEveryN =
    raw?.['mailboxDigestEveryN'] ?? raw?.['mailbox_digest_every_n'] ?? raw?.['digestEveryN'];
  const digestTo = raw?.['mailboxDigestTo'] ?? raw?.['mailbox_digest_to'] ?? raw?.['digestTo'];
  const rawBudget =
    raw?.['budgetLimit'] ?? raw?.['budget_limit'] ?? raw?.['budget'] ?? raw?.['limit'];
  const rawThreshold =
    raw?.['warningThreshold'] ??
    raw?.['warning_threshold'] ??
    raw?.['warnThreshold'] ??
    raw?.['warn_threshold'] ??
    raw?.['threshold'];
  const trimmedDigestTo = typeof digestTo === 'string' ? digestTo.trim() : '';
  return {
    budgetLimit:
      typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget >= 0 ? rawBudget : 0,
    warningThreshold:
      typeof rawThreshold === 'number' && Number.isFinite(rawThreshold) && rawThreshold > 0
        ? rawThreshold
        : 80,
    mailboxDigestEveryN:
      typeof digestEveryN === 'number' && Number.isFinite(digestEveryN) && digestEveryN >= 0
        ? Math.floor(digestEveryN)
        : 0,
    mailboxDigestTo: trimmedDigestTo.length > 0 ? trimmedDigestTo : 'cost-tracker',
  };
}
