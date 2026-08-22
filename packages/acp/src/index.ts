/**
 * @wrongstack/acp — ACP integration public surface.
 *
 * DIR-2: WrongStack as ACP Server
 *   import { WrongStackACPServer } from '@wrongstack/acp/agent';
 *
 * DIR-1: WrongStack as ACP Client
 *   import { makeACPSubagentRunner } from '@wrongstack/acp/client';
 */

export { ACPProtocolHandler } from './agent/protocol-handler.js';
export type {
  ACPChildProcess,
  ACPClientTransport,
  AgentServerTransport,
  ClientTransportOptions,
} from './agent/stdio-transport.js';
// Agent (server) side
// Client side (DIR-1: WrongStack spawns external ACP agents)
export { ClientTransport, StdioTransport } from './agent/stdio-transport.js';
export { ACPToolsRegistry } from './agent/tools-registry.js';
export type { WrongStackACPServerOptions } from './agent/wrongstack-acp-agent.js';
export { WrongStackACPServer } from './agent/wrongstack-acp-agent.js';
export type {
  ACPCapturedDiff,
  ACPCapturedToolCall,
  ACPProgressEvent,
  ACPProgressHandler,
  ACPSessionErrorKind,
  ACPSessionOptions,
  ACPSessionRunResult,
} from './client/acp-session.js';
// Client session — the v1-correct ACP client (added in feat/acp-ensemble).
export {
  ACPSession,
  ACPSessionError,
  audioContent,
  imageContent,
  textContent,
} from './client/acp-session.js';
export type {
  FileServerOptions,
  FsErrorCode,
  ReadFileParams,
  WriteFileParams,
} from './client/file-server.js';
export { FileServer, FsError } from './client/file-server.js';
export type { PermissionPolicy, PermissionRequest } from './client/permission.js';
export {
  defaultPermissionPolicy,
  makePermissionPolicy,
  readOnlyPermissionPolicy,
} from './client/permission.js';
export type { TerminalServerOptions } from './client/terminal-server.js';
export { TerminalServer } from './client/terminal-server.js';
export type { ToolTranslatorOptions } from './client/tool-translator.js';
export { ToolTranslator } from './client/tool-translator.js';
export type { ACPTrustBoundaryAdapterOptions } from './client/trust-boundary-permission.js';
export {
  makeTrustBoundaryPermissionPolicy,
  toTrustBoundaryRequest,
} from './client/trust-boundary-permission.js';
export type { WebSocketClientTransportOptions } from './client/websocket-transport.js';
export { WebSocketClientTransport } from './client/websocket-transport.js';
export type {
  AcpBenchAgentResult,
  AcpBenchCheck,
  AcpBenchCmdResolver,
  AcpBenchOptions,
  AcpBenchResult,
  AcpBenchStatus,
} from './integration/acp-bench.js';
// ACP client bench — end-to-end per-agent verification + report.
export { renderAcpBenchText, runAcpBench } from './integration/acp-bench.js';
export type {
  ACPSubagentRunnerOptions,
  AcpAgentCommandOverrides,
  AcpLiveCatalog,
  AcpProbeResult,
  ProbeAcpAgentsOptions,
} from './integration/acp-subagent-runner.js';
export {
  ACP_AGENT_COMMANDS,
  makeACPSubagentRunner,
  makeACPSubagentRunnerWithStop,
  probeAcpAgent,
  probeAcpAgents,
  REGISTRY_ID_ALIASES,
  resolveAcpAgentCommand,
} from './integration/acp-subagent-runner.js';
// Ensemble runner — fan a single task out to multiple ACP agents.
export {
  defaultEnsembleCmdResolver,
  type EnsembleAgentResult,
  type EnsembleCmdResolver,
  type EnsembleProgressHandler,
  type EnsembleResult,
  type EnsembleRunnerOptions,
  renderEnsembleText,
  runEnsemble,
} from './integration/ensemble-runner.js';
export type {
  RunOneAcpTaskOptions,
  RunOneAcpTaskResult,
} from './integration/run-one-acp-task.js';
export { runOneAcpTask } from './integration/run-one-acp-task.js';
export type {
  FetchAcpRegistryOptions,
  FetchAcpRegistryResult,
  RegistryAgentEntry,
} from './registry/acp-registry-fetch.js';
// Live registry sync — the official agentclientprotocol/registry snapshot.
export {
  ACP_REGISTRY_URL,
  fetchAcpRegistry,
  mapRegistryEntry,
} from './registry/acp-registry-fetch.js';
// Discovery — the catalog + registry (added in feat/acp-ensemble).
export { AGENTS_CATALOG, findAgentDescriptor } from './registry/agents.catalog.js';
export type { ACPAgentDescriptor } from './registry/contracts.js';
export type {
  ACPAgentVendor,
  ACPIntegration,
  DetectedAgent,
  EnsembleRegistryOptions,
} from './registry/ensemble-registry.js';
export { EnsembleRegistry } from './registry/ensemble-registry.js';

// Stable protocol contracts. Pre-v1 draft envelopes live at `/legacy` only.
export * from './v1.js';
export { ACP_PACKAGE_VERSION } from './version.js';
