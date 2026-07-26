import type { MCPServerConfig } from '@wrongstack/core/types';
import {
  applyHealthThresholds,
  createMCPServerOperationState,
  evaluateHealthThresholds,
  healthStateFor,
  type MCPServerOperationalHealth,
  summarizeLatency,
} from './operations.js';
import type { ServerSlot } from './registry-slots.js';

export function buildRegistryOperationalHealth(
  servers: Iterable<ServerSlot>,
  disabledServers: Iterable<MCPServerConfig>,
): MCPServerOperationalHealth[] {
  const active = Array.from(servers).map((slot) => {
    const op = slot.operations;
    const baseHealth = healthStateFor(slot.state, op, slot.cfg.enabled !== false);
    const checks = evaluateHealthThresholds(op, slot.cfg.health?.thresholds);
    return {
      name: slot.cfg.name,
      connectionState: slot.state,
      healthState: applyHealthThresholds(baseHealth, checks),
      lastSuccessAt: op.lastSuccessAt,
      lastFailureAt: op.lastFailureAt,
      lastFailureKind: op.lastFailureKind,
      lastReason: op.lastReason,
      consecutiveFailures: op.consecutiveFailures,
      failures: { ...op.failures },
      reconnectCount: op.reconnectCount,
      wakeCount: op.wakeCount,
      sleepCount: op.sleepCount,
      restartCount: op.restartCount,
      connectionLatency: summarizeLatency(op.connectionSamples),
      discoveryLatency: summarizeLatency(op.discoverySamples),
      callLatency: summarizeLatency(op.callSamples),
      inFlightCalls: op.inFlightCalls,
      peakInFlightCalls: op.peakInFlightCalls,
      recentEvents: op.recentEvents.map((event) => ({ ...event })),
      healthChecks: checks,
    };
  });
  const disabled = Array.from(disabledServers).map((cfg) => {
    const operations = createMCPServerOperationState();
    return {
      name: cfg.name,
      connectionState: 'idle' as const,
      healthState: 'disabled' as const,
      consecutiveFailures: 0,
      failures: { ...operations.failures },
      reconnectCount: 0,
      wakeCount: 0,
      sleepCount: 0,
      restartCount: 0,
      connectionLatency: summarizeLatency([]),
      discoveryLatency: summarizeLatency([]),
      callLatency: summarizeLatency([]),
      inFlightCalls: 0,
      peakInFlightCalls: 0,
      recentEvents: [],
      healthChecks: [],
    };
  });
  return [...active, ...disabled];
}
