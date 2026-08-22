import type { MCPHealthThresholds } from '@wrongstack/core/types';
import type { ConnectionState } from './contracts.js';

/** Operator-facing health state. Intentionally separate from transport lifecycle state. */
export type MCPHealthState =
  | 'disabled'
  | 'dormant'
  | 'connecting'
  | 'healthy'
  | 'degraded'
  | 'failed';

export type MCPFailureKind = 'transport' | 'protocol' | 'tool';

export type MCPOperationKind =
  | 'connect'
  | 'reconnect'
  | 'discover'
  | 'call'
  | 'wake'
  | 'sleep'
  | 'restart'
  | 'stop'
  | 'failure';

/**
 * Safe lifecycle event. `reason` is a bounded code owned by WrongStack, never
 * a server error message, command, URL, tool name, argument, or token.
 */
export interface MCPOperationEvent {
  serverName: string;
  kind: MCPOperationKind;
  at: number;
  connectionState: ConnectionState;
  healthState: MCPHealthState;
  reason?: string | undefined;
  failureKind?: MCPFailureKind | undefined;
  durationMs?: number | undefined;
}

export interface MCPLatencySummary {
  count: number;
  lastMs?: number | undefined;
  minMs?: number | undefined;
  maxMs?: number | undefined;
  p50Ms?: number | undefined;
  p95Ms?: number | undefined;
}

export interface MCPServerOperationalHealth {
  name: string;
  connectionState: ConnectionState;
  healthState: MCPHealthState;
  lastSuccessAt?: number | undefined;
  lastFailureAt?: number | undefined;
  lastFailureKind?: MCPFailureKind | undefined;
  lastReason?: string | undefined;
  consecutiveFailures: number;
  failures: Record<MCPFailureKind, number>;
  reconnectCount: number;
  wakeCount: number;
  sleepCount: number;
  restartCount: number;
  connectionLatency: MCPLatencySummary;
  discoveryLatency: MCPLatencySummary;
  callLatency: MCPLatencySummary;
  inFlightCalls: number;
  peakInFlightCalls: number;
  recentEvents: MCPOperationEvent[];
  /** Last evaluation of configured health thresholds; empty if none configured. */
  healthChecks: MCPHealthCheckResult[];
}

/** Result of comparing one operational metric against its configured threshold. */
export interface MCPHealthCheckResult {
  name: string;
  passed: boolean;
  value?: number | undefined;
  threshold?: number | undefined;
}

export type MCPOperationListener = (event: Readonly<MCPOperationEvent>) => void;

export const MCP_OPERATION_LIMITS = Object.freeze({
  LATENCY_SAMPLES: 128,
  RECENT_EVENTS: 32,
  REASON_CHARS: 64,
});

const SAFE_OPERATION_REASONS = new Set([
  'automatic',
  'complete',
  'connect-attempt-failed',
  'connected',
  'http-disconnect',
  'http-disconnect-lazy',
  'idle-timeout',
  'lazy-demand',
  'manual',
  'ok',
  'process-exit',
  'process-exit-lazy',
  'prompt-discovery-failed',
  'reconnect-exhausted',
  'resource-discovery-failed',
  'resource-template-discovery-failed',
  'started',
  'tool-call-failed',
]);

export interface MCPServerOperationState {
  lastSuccessAt?: number | undefined;
  lastFailureAt?: number | undefined;
  lastFailureKind?: MCPFailureKind | undefined;
  lastReason?: string | undefined;
  consecutiveFailures: number;
  failures: Record<MCPFailureKind, number>;
  reconnectCount: number;
  wakeCount: number;
  sleepCount: number;
  restartCount: number;
  connectionSamples: number[];
  discoverySamples: number[];
  callSamples: number[];
  inFlightCalls: number;
  peakInFlightCalls: number;
  recentEvents: MCPOperationEvent[];
}

export function createMCPServerOperationState(): MCPServerOperationState {
  return {
    consecutiveFailures: 0,
    failures: { transport: 0, protocol: 0, tool: 0 },
    reconnectCount: 0,
    wakeCount: 0,
    sleepCount: 0,
    restartCount: 0,
    connectionSamples: [],
    discoverySamples: [],
    callSamples: [],
    inFlightCalls: 0,
    peakInFlightCalls: 0,
    recentEvents: [],
  };
}

export function healthStateFor(
  connectionState: ConnectionState,
  operations: MCPServerOperationState,
  enabled = true,
): MCPHealthState {
  if (!enabled) return 'disabled';
  if (connectionState === 'dormant') return 'dormant';
  if (
    connectionState === 'connecting' ||
    connectionState === 'reconnecting' ||
    connectionState === 'idle'
  ) {
    return 'connecting';
  }
  if (connectionState === 'failed') return 'failed';
  if (connectionState === 'disconnected' || operations.consecutiveFailures > 0) return 'degraded';
  return 'healthy';
}

/**
 * Compare bounded latency/in-flight samples against configured thresholds.
 * Returns one check per configured threshold. All thresholds are optional;
 * omitted thresholds produce no check and cannot mark a server degraded.
 */
export function evaluateHealthThresholds(
  operations: MCPServerOperationState,
  thresholds: MCPHealthThresholds | undefined,
): MCPHealthCheckResult[] {
  if (!thresholds) return [];
  const checks: MCPHealthCheckResult[] = [];
  if (thresholds.connectionLatencyP95Ms !== undefined && operations.connectionSamples.length > 0) {
    const value = percentile(
      [...operations.connectionSamples].sort((a, b) => a - b),
      0.95,
    );
    checks.push({
      name: 'connection-latency-p95',
      passed: value <= thresholds.connectionLatencyP95Ms,
      value,
      threshold: thresholds.connectionLatencyP95Ms,
    });
  }
  if (thresholds.discoveryLatencyP95Ms !== undefined && operations.discoverySamples.length > 0) {
    const value = percentile(
      [...operations.discoverySamples].sort((a, b) => a - b),
      0.95,
    );
    checks.push({
      name: 'discovery-latency-p95',
      passed: value <= thresholds.discoveryLatencyP95Ms,
      value,
      threshold: thresholds.discoveryLatencyP95Ms,
    });
  }
  if (thresholds.callLatencyP95Ms !== undefined && operations.callSamples.length > 0) {
    const value = percentile(
      [...operations.callSamples].sort((a, b) => a - b),
      0.95,
    );
    checks.push({
      name: 'call-latency-p95',
      passed: value <= thresholds.callLatencyP95Ms,
      value,
      threshold: thresholds.callLatencyP95Ms,
    });
  }
  if (thresholds.inFlightCalls !== undefined) {
    checks.push({
      name: 'in-flight-calls',
      passed: operations.peakInFlightCalls <= thresholds.inFlightCalls,
      value: operations.peakInFlightCalls,
      threshold: thresholds.inFlightCalls,
    });
  }
  return checks;
}

/**
 * Apply threshold checks to a lifecycle-derived health state. Only `healthy`
 * can be downgraded to `degraded`; existing degraded/failed states are kept
 * so the original lifecycle reason remains authoritative.
 */
export function applyHealthThresholds(
  state: MCPHealthState,
  checks: readonly MCPHealthCheckResult[],
): MCPHealthState {
  if (state !== 'healthy') return state;
  return checks.some((c) => !c.passed) ? 'degraded' : 'healthy';
}

export function summarizeLatency(samples: readonly number[]): MCPLatencySummary {
  if (samples.length === 0) return { count: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: samples.length,
    lastMs: samples[samples.length - 1],
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

export function pushBounded<T>(target: T[], value: T, limit: number): void {
  target.push(value);
  if (target.length > limit) target.splice(0, target.length - limit);
}

export function safeOperationReason(reason: string): string {
  const normalized = reason.toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-');
  const bounded = normalized.slice(0, MCP_OPERATION_LIMITS.REASON_CHARS);
  return SAFE_OPERATION_REASONS.has(bounded) ? bounded : 'other';
}

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]!;
}
