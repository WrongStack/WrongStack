/**
 * Public surface of the @wrongstack/wrongtrace package.
 *
 * Callers do this and never worry about whether the daemon is running:
 *
 *   import { getWrongTraceClient } from "@wrongstack/wrongtrace";
 *   const wt = await getWrongTraceClient();
 *   if (wt.isAvailable) { /* safe to use lock/lineage/telemetry APIs *\/ }
 */

export type { IpcCallResult, IpcTimeouts, IpcTransport } from './adapters/ipc.js';
export { createIpcTransport } from './adapters/ipc.js';
export type { McpToolBag, McpToolHandler, McpToolName, McpTransport } from './adapters/mcp.js';
export { createMcpTransport } from './adapters/mcp.js';
export type {
  AtlasDigest,
  CrossAgentRisk,
  FrictionSummary,
  RecentActivityEntry,
} from './agent-helpers.js';

export {
  digestAtlas,
  getCrossAgentRisk,
  getRecentActivity,
  summarizeFriction,
} from './agent-helpers.js';
export type { WrongTraceClientInternal, WrongTraceClientOptions } from './client.js';
export { createWrongTraceClient } from './client.js';
export type { DiscoveryOptions, DiscoveryResult } from './discovery.js';
export { defaultSocketPath, discover } from './discovery.js';
export type {
  WrongTraceAtlasFile,
  WrongTraceAtlasQuery,
  WrongTraceAtlasSummary,
  WrongTraceClient,
  WrongTraceFileHealth,
  WrongTraceFrictionRow,
  WrongTraceHealth,
  WrongTraceLockInfo,
  WrongTraceLockOwnership,
  WrongTraceLockRequest,
  WrongTraceLockResult,
  WrongTraceRecentEvent,
  WrongTraceRecentEventsQuery,
  WrongTraceSymbolEvent,
  WrongTraceTelemetryReport,
  WrongTraceUnlockRequest,
} from './types.js';

// ── Shared guardrail gate + hooks (CLI leader, fleet subagents, WebUI server) ──

export type { PreflightOptions, PreflightVerdict } from './gate.js';
export {
  getWrongTrace,
  preflightFileEdit,
  resetWrongTraceGate,
  withFileLock,
} from './gate.js';
export type {
  WrongTraceGateCounter,
  WrongTraceGateCounterSnapshot,
} from './gate-counters.js';
export {
  countersFilePath,
  createWrongTraceGateCounter,
  formatGateCounterReport,
  loadWrongTraceGateCounters,
  persistWrongTraceGateCounters,
  recordGateDecision,
  resetGateDecisions,
  snapshotGateDecisions,
} from './gate-counters.js';
export type {
  WrongTraceGateDecisionEvent,
  WrongTraceHookInput,
  WrongTraceHookOptions,
  WrongTraceHookPair,
  WrongTracePreToolUseOutcome,
} from './hooks.js';
export {
  createWrongTraceHookPair,
  createWrongTracePostToolUseHook,
  createWrongTracePreToolUseHook,
} from './hooks.js';

/**
 * Drop-in replacement for the legacy `getWrongTraceClient()` from the
 * reference TypeScript snippet. Kept as a one-liner alias for caller
 * familiarity — implementation lives in `client.ts`.
 */
export async function getWrongTraceClient() {
  const { createWrongTraceClient } = await import('./client.js');
  return createWrongTraceClient();
}
