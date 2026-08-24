/**
 * Public surface of the @wrongstack/wrongtrace package.
 *
 * Callers do this and never worry about whether the daemon is running:
 *
 *   import { getWrongTraceClient } from "@wrongstack/wrongtrace";
 *   const wt = await getWrongTraceClient();
 *   if (wt.isAvailable) { /* safe to use lock/lineage/telemetry APIs *\/ }
 */

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
} from "./types.js";

export { discover, defaultSocketPath } from "./discovery.js";
export type { DiscoveryOptions, DiscoveryResult } from "./discovery.js";

export { createWrongTraceClient } from "./client.js";
export type { WrongTraceClientOptions, WrongTraceClientInternal } from "./client.js";

export {
  getCrossAgentRisk,
  summarizeFriction,
  getRecentActivity,
  digestAtlas,
} from "./agent-helpers.js";
export type {
  CrossAgentRisk,
  FrictionSummary,
  AtlasDigest,
  RecentActivityEntry,
} from "./agent-helpers.js";

export { createIpcTransport } from "./adapters/ipc.js";
export type { IpcTransport, IpcCallResult, IpcTimeouts } from "./adapters/ipc.js";

export { createMcpTransport } from "./adapters/mcp.js";
export type { McpTransport, McpToolBag, McpToolHandler, McpToolName } from "./adapters/mcp.js";

// ── Shared guardrail gate + hooks (CLI leader, fleet subagents, WebUI server) ──

export {
  getWrongTrace,
  preflightFileEdit,
  resetWrongTraceGate,
  withFileLock,
} from "./gate.js";
export type { PreflightOptions, PreflightVerdict } from "./gate.js";

export {
  createWrongTraceHookPair,
  createWrongTracePostToolUseHook,
  createWrongTracePreToolUseHook,
} from "./hooks.js";
export type {
  WrongTraceGateDecisionEvent,
  WrongTraceHookInput,
  WrongTraceHookOptions,
  WrongTraceHookPair,
  WrongTracePreToolUseOutcome,
} from "./hooks.js";

/**
 * Drop-in replacement for the legacy `getWrongTraceClient()` from the
 * reference TypeScript snippet. Kept as a one-liner alias for caller
 * familiarity — implementation lives in `client.ts`.
 */
export async function getWrongTraceClient() {
  const { createWrongTraceClient } = await import("./client.js");
  return createWrongTraceClient();
}
