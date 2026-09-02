/**
 * TechStack — DeliveryCoordinator.
 *
 * Per-session idle-delivery coordinator for TechStack reports.
 *
 * Guarantees (per SDD §5):
 * 1. Idle-only: report is never injected while a run is in progress.
 * 2. Exactly-once visible delivery: duplicate outbox entries → single delivery.
 * 3. Durable: survives store close/reopen; pending entries retry on recovery.
 * 4. Bounded: at most one delivery per report per session.
 *
 * @see docs/specs/techstack-sdd.md §5
 */

import type { TechStackStore } from '../store/sqlite.js';
import type { Snapshot } from '../types.js';

export interface DeliveryCoordinatorOptions {
  readonly store: TechStackStore;
  /** Check whether an agent run is currently in progress. */
  readonly isRunInProgress: () => boolean;
  /** Deliver the report summary to the chat session (append to journal). */
  readonly deliverToSession: (
    sessionId: string,
    reportId: string,
    summary: string,
  ) => Promise<boolean>;
  /** Called when a delivery completes (for WS event broadcasting). */
  readonly onDelivered?: ((deliveryId: string, sessionId: string) => void) | undefined;
  /** Poll interval in ms. Default: 2000. */
  readonly pollIntervalMs?: number | undefined;
}

export interface DeliveryResult {
  deliveryId: string;
  sessionId: string;
  delivered: boolean;
}

/**
 * Attempt to deliver a single pending outbox entry.
 *
 * Returns `{ delivered: false }` if the run is still in progress or the
 * entry has already been delivered. Returns `{ delivered: true }` on success.
 *
 * This function is idempotent: calling it twice for the same deliveryId
 * will deliver exactly once (the CAS in claimOutbox prevents double-claim).
 */
export async function attemptDelivery(
  deliveryId: string,
  opts: DeliveryCoordinatorOptions,
): Promise<DeliveryResult> {
  const { store, isRunInProgress, deliverToSession, onDelivered } = opts;

  // Idle-only gate
  if (isRunInProgress()) {
    return { deliveryId, sessionId: '', delivered: false };
  }

  // Find the outbox entry
  const pending = store.listOutboxByStatus('pending');
  const entry = pending.find((e: { deliveryId: string }) => e.deliveryId === deliveryId);
  if (!entry) {
    return { deliveryId, sessionId: '', delivered: false };
  }

  // Atomic CAS claim — prevents double-delivery
  const claimed = store.claimOutbox(deliveryId, entry.sessionId);
  if (!claimed) {
    return { deliveryId, sessionId: entry.sessionId, delivered: false };
  }

  // Generate a summary from the snapshot
  const snapshot = store.getSnapshotById(entry.reportId);
  const summary = snapshot
    ? buildSummary(snapshot)
    : `TechStack report ${entry.reportId} is ready.`;

  // Deliver to session
  const success = await deliverToSession(entry.sessionId, entry.reportId, summary);

  if (success) {
    store.deliverOutbox(deliveryId);
    onDelivered?.(deliveryId, entry.sessionId);
    return { deliveryId, sessionId: entry.sessionId, delivered: true };
  }

  store.failOutbox(deliveryId);
  return { deliveryId, sessionId: entry.sessionId, delivered: false };
}

/**
 * Process all pending outbox entries for a given session.
 * Called by the coordinator loop when the session becomes idle.
 */
export async function drainPendingDeliveries(
  sessionId: string,
  opts: DeliveryCoordinatorOptions,
): Promise<number> {
  const { store, isRunInProgress } = opts;
  if (isRunInProgress()) return 0;

  const pending = store.listOutboxByStatus('pending');
  let delivered = 0;
  for (const entry of pending) {
    if (entry.sessionId !== sessionId) continue;
    const result = await attemptDelivery(entry.deliveryId, opts);
    if (result.delivered) delivered++;
  }
  return delivered;
}

/**
 * Build a concise chat-friendly summary from a snapshot.
 *
 * Format: counts + top findings + report link.
 */
function buildSummary(snapshot: Snapshot): string {
  const lines: string[] = [
    `📊 **TechStack Report Ready**`,
    '',
    `**${snapshot.workspaces.length}** workspaces · **${snapshot.dependencies.length}** dependencies · **${snapshot.findings.length}** findings`,
  ];

  const findings = snapshot.findings as ReadonlyArray<{
    severity: string;
    type: string;
    rationale: string;
    dependencyId: string;
  }>;
  const critical = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  if (critical.length > 0) {
    lines.push('', `**Top ${Math.min(5, critical.length)} urgent findings:**`);
    for (const f of critical.slice(0, 5)) {
      const dep = snapshot.dependencies.find((d: { id: string }) => d.id === f.dependencyId);
      lines.push(`  • **${dep?.name ?? f.dependencyId}** — ${f.type}: ${f.rationale}`);
    }
  }

  lines.push('', `_Open the TechStack view for the full report._`);
  return lines.join('\n');
}
