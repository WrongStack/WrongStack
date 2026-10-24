import type { MCPHealthThresholds } from '@wrongstack/contracts/types';
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
  'unsupported-protocol-version',
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
  const connectionP95 = thresholds.connectionLatencyP95Ms;
  if (isUsableThreshold(connectionP95) && operations.connectionSamples.length > 0) {
    const value = percentile(
      [...operations.connectionSamples].sort((a, b) => a - b),
      0.95,
    );
    checks.push({
      name: 'connection-latency-p95',
      passed: value <= connectionP95,
      value,
      threshold: connectionP95,
    });
  }
  const discoveryP95 = thresholds.discoveryLatencyP95Ms;
  if (isUsableThreshold(discoveryP95) && operations.discoverySamples.length > 0) {
    const value = percentile(
      [...operations.discoverySamples].sort((a, b) => a - b),
      0.95,
    );
    checks.push({
      name: 'discovery-latency-p95',
      passed: value <= discoveryP95,
      value,
      threshold: discoveryP95,
    });
  }
  const callP95 = thresholds.callLatencyP95Ms;
  if (isUsableThreshold(callP95) && operations.callSamples.length > 0) {
    const value = percentile(
      [...operations.callSamples].sort((a, b) => a - b),
      0.95,
    );
    checks.push({
      name: 'call-latency-p95',
      passed: value <= callP95,
      value,
      threshold: callP95,
    });
  }
  const inFlight = thresholds.inFlightCalls;
  if (isUsableThreshold(inFlight)) {
    checks.push({
      name: 'in-flight-calls',
      passed: operations.peakInFlightCalls <= inFlight,
      value: operations.peakInFlightCalls,
      threshold: inFlight,
    });
  }
  return checks;
}

/**
 * A threshold counts as configured only when it is a finite number.
 *
 * `!== undefined` was not enough. These values are read straight off
 * `config.json` (`registry-health.ts` / `registry-operations.ts` pass
 * `slot.cfg.health?.thresholds`), and `null` or a hand-edited string passes every
 * `!== undefined` guard while being useless as a bound. Every threshold is
 * compared with `<=`, which is false for a non-number on every sample — so a
 * typo pinned an otherwise-healthy server to `degraded` permanently, recomputed
 * from the same config on every read and across restarts, with nothing in the
 * config to change. The WebSocket validator rejects these on its own surface,
 * but the REPL/TUI path in `manage.ts` copies `health` verbatim, and a config
 * can predate that check or be edited by hand.
 *
 * Ignoring an unusable value is the right direction for a health signal: it
 * means "this threshold is not configured", and per the contract above an
 * unconfigured threshold cannot mark a server degraded. The loud rejection still
 * lives at the validator, where the operator actually types the value.
 */
function isUsableThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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
