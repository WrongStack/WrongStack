import {
  applyHealthThresholds,
  createMCPServerOperationState,
  evaluateHealthThresholds,
  healthStateFor,
  MCP_OPERATION_LIMITS,
  type MCPFailureKind,
  type MCPOperationEvent,
  type MCPOperationKind,
  type MCPOperationListener,
  type MCPServerOperationState,
  pushBounded,
  safeOperationReason,
} from './operations.js';
import type { ServerSlot } from './registry-slots.js';

export function operationsForSlot(slot: ServerSlot): MCPServerOperationState {
  if (!slot.operations) slot.operations = createMCPServerOperationState();
  return slot.operations;
}

export function recordRegistrySuccess(slot: ServerSlot, resetFailures = true): void {
  const operations = operationsForSlot(slot);
  operations.lastSuccessAt = Date.now();
  if (resetFailures) operations.consecutiveFailures = 0;
}

export function recordRegistryFailure(
  slot: ServerSlot,
  listeners: Iterable<MCPOperationListener>,
  failureKind: MCPFailureKind,
  reason: string,
  durationMs?: number | undefined,
): void {
  const operations = operationsForSlot(slot);
  const safeReason = safeOperationReason(reason);
  operations.lastFailureAt = Date.now();
  operations.lastFailureKind = failureKind;
  operations.lastReason = safeReason;
  operations.consecutiveFailures++;
  operations.failures[failureKind]++;
  recordRegistryOperation(slot, listeners, 'failure', safeReason, failureKind, durationMs);
}

export function recordRegistryOperation(
  slot: ServerSlot,
  listeners: Iterable<MCPOperationListener>,
  kind: MCPOperationKind,
  reason?: string | undefined,
  failureKind?: MCPFailureKind | undefined,
  durationMs?: number | undefined,
  retain = true,
): void {
  const operations = operationsForSlot(slot);
  const baseHealth = healthStateFor(slot.state, operations, slot.cfg.enabled !== false);
  const checks = evaluateHealthThresholds(operations, slot.cfg.health?.thresholds);
  const event: MCPOperationEvent = {
    serverName: slot.cfg.name,
    kind,
    at: Date.now(),
    connectionState: slot.state,
    healthState: applyHealthThresholds(baseHealth, checks),
  };
  if (reason !== undefined) event.reason = safeOperationReason(reason);
  if (failureKind !== undefined) event.failureKind = failureKind;
  if (durationMs !== undefined) event.durationMs = Math.max(0, Math.round(durationMs));
  if (retain) pushBounded(operations.recentEvents, event, MCP_OPERATION_LIMITS.RECENT_EVENTS);
  for (const listener of listeners) {
    try {
      listener({ ...event });
    } catch {
      // Observability must never affect MCP execution.
    }
  }
}
