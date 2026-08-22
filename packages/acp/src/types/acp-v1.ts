/**
 * ACP v1 type definitions — Agent Client Protocol, stable v1 spec.
 *
 * Scope: discriminated union for the `session/update` notification payload
 * (the `update` field of a `session/update` JSON-RPC notification), plus the
 * subset of supporting types it depends on.
 *
 * Spec: https://agentclientprotocol.com/protocol/v1/overview
 *
 * Design notes
 * ────────────
 * • The stable v1 spec defines 11 `sessionUpdate` discriminator values. We
 *   type exactly those 11, plus an `_unstable_*` escape hatch for v2-RFD
 *   kinds (e.g. `next_edit_suggestions`, `elicitation`) that real agents
 *   may emit before the spec stabilises them, and an `unknown` fallback for
 *   everything else. We do NOT synthesise 32 fake variants to match a
 *   number cited in passing — the union is honest about the surface.
 *
 * • Per the spec's conventions, discriminator values use snake_case. The
 *   property keys inside each variant are camelCase (the JSON-RPC envelope
 *   is JSON-RPC 2.0, everything else is camelCase unless the spec says
 *   otherwise).
 *
 * • Optional fields that the spec marks optional are marked `?:`. Required
 *   fields have no `?`. We do not include spec fields the spec marks
 *   "SHOULD NOT" or "reserved".
 *
 * • The existing `acp-messages.ts` types describe an older draft of the
 *   protocol (string `protocolVersion: '2024-11'`, fake `tools/call`
 *   method, etc.). Do NOT import from it here — `acp-v1.ts` is
 *   self-contained so the new code path can be reviewed in isolation and
 *   deleted wholesale if the rewrite is ever reverted.
 */

// ────────────────────────────────────────────────────────────────────────────
// Shared building blocks
// ────────────────────────────────────────────────────────────────────────────

/** Stable protocol version (integer per the spec, not a date-string). */
export const ACP_PROTOCOL_VERSION = 1 as const;
export type ACPProtocolVersion = typeof ACP_PROTOCOL_VERSION;

/** Per the spec: opaque, unique id. We type as branded string. */
export type SessionId = string & { readonly __acpSessionId: unique symbol };
export type ToolCallId = string & { readonly __acpToolCallId: unique symbol };
export type MessageId = string & { readonly __acpMessageId: unique symbol };
export type TerminalId = string & { readonly __acpTerminalId: unique symbol };
export type PlanEntryId = string & { readonly __acpPlanEntryId: unique symbol };

// ────────────────────────────────────────────────────────────────────────────
// Implementation metadata
// ────────────────────────────────────────────────────────────────────────────

export interface Implementation {
  /** Programmatic/logical name — also a display-name fallback if title is absent. */
  name: string;
  /** Human-readable display name for UI contexts. */
  title?: string | undefined;
  /** Version string (display/debug/metrics). */
  version: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Client capabilities — sent in the initialize request
// ────────────────────────────────────────────────────────────────────────────

export interface ClientCapabilities {
  fs?:
    | {
        readTextFile?: boolean | undefined;
        writeTextFile?: boolean | undefined;
      }
    | undefined;
  terminal?: boolean | undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Agent capabilities — received in the initialize response
// ────────────────────────────────────────────────────────────────────────────

export interface PromptCapabilities {
  image?: boolean | undefined;
  audio?: boolean | undefined;
  embeddedContext?: boolean | undefined;
}

export interface McpCapabilities {
  http?: boolean | undefined;
  sse?: boolean | undefined;
}

export interface SessionCapabilities {
  close?: Record<string, unknown> | undefined;
  list?: Record<string, unknown> | undefined;
  delete?: Record<string, unknown> | undefined;
  resume?: Record<string, unknown> | undefined;
  additionalDirectories?: Record<string, unknown> | undefined;
}

export interface AuthCapabilities {
  logout?: Record<string, unknown> | undefined;
}

export interface AgentCapabilities {
  loadSession?: boolean | undefined;
  promptCapabilities?: PromptCapabilities | undefined;
  mcpCapabilities?: McpCapabilities | undefined;
  sessionCapabilities?: SessionCapabilities | undefined;
  auth?: AuthCapabilities | undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Authentication
// ────────────────────────────────────────────────────────────────────────────

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | undefined;
  type?: 'agent' | 'oauth' | 'http' | undefined;
}

export interface AuthenticateRequest {
  methodId: string;
}

export type AuthenticateResponse = {};

export type LogoutRequest = {};

export type LogoutResponse = {};

// ────────────────────────────────────────────────────────────────────────────
// MCP server configuration — sent in session lifecycle requests
// ────────────────────────────────────────────────────────────────────────────

export interface StdioMcpServer {
  name: string;
  command: string;
  args?: string[] | undefined;
  env?: { name: string; value: string }[] | undefined;
}

export interface HttpMcpServer {
  type: 'http';
  name: string;
  url: string;
  headers?: { name: string; value: string }[] | undefined;
}

export interface SseMcpServer {
  type: 'sse';
  name: string;
  url: string;
  headers?: { name: string; value: string }[] | undefined;
}

export type McpServer = StdioMcpServer | HttpMcpServer | SseMcpServer;

// ────────────────────────────────────────────────────────────────────────────
// Session lifecycle — request/response types
// ────────────────────────────────────────────────────────────────────────────

export interface NewSessionRequest {
  cwd: string;
  mcpServers: McpServer[];
  additionalDirectories?: string[] | undefined;
}

export interface NewSessionResponse {
  sessionId: SessionId;
  initialMode?: SessionModeState | null | undefined;
  configOptions?: SessionConfigOption[] | null | undefined;
}

export interface LoadSessionRequest {
  sessionId: SessionId;
  cwd: string;
  mcpServers: McpServer[];
  additionalDirectories?: string[] | undefined;
}

export interface LoadSessionResponse {
  initialMode?: SessionModeState | null | undefined;
  configOptions?: SessionConfigOption[] | null | undefined;
}

export interface ResumeSessionRequest {
  sessionId: SessionId;
  cwd: string;
  mcpServers: McpServer[];
  additionalDirectories?: string[] | undefined;
}

export interface ResumeSessionResponse {
  initialMode?: SessionModeState | null | undefined;
  configOptions?: SessionConfigOption[] | null | undefined;
}

export interface CloseSessionRequest {
  sessionId: SessionId;
}

export type CloseSessionResponse = {};

export interface ListSessionsRequest {
  cursor?: string | undefined;
  cwd?: string | undefined;
}

export interface ListSessionsResponse {
  sessions: SessionInfo[];
  nextCursor?: string | undefined;
}

export interface DeleteSessionRequest {
  sessionId: SessionId;
}

export type DeleteSessionResponse = {};

// ────────────────────────────────────────────────────────────────────────────
// Session config options
// ────────────────────────────────────────────────────────────────────────────

export interface SessionConfigOption {
  id: string;
  name: string;
  description?: string | undefined;
  category?: ConfigOptionCategory | undefined;
  type: ConfigOptionType;
  defaultValue?: string | undefined;
  currentValue: string;
  options: ConfigOptionValue[];
}

// ────────────────────────────────────────────────────────────────────────────
// Content blocks — reused from MCP per the spec
// ────────────────────────────────────────────────────────────────────────────

/**
 * Annotations attached to a content block. Optional, agent-supplied hint
 * about audience/priority. Spec leaves shape open; we mirror the fields
 * the spec shows in its examples.
 */
export interface ContentAnnotations {
  audience?: ('user' | 'assistant')[] | undefined;
  priority?: number | undefined;
  [key: string]: unknown;
}

export interface TextContent {
  type: 'text';
  text: string;
  annotations?: ContentAnnotations | undefined;
}

export interface ImageContent {
  type: 'image';
  mimeType: string;
  /** Base64-encoded image data. */
  data: string;
  uri?: string | undefined;
  annotations?: ContentAnnotations | undefined;
}

export interface AudioContent {
  type: 'audio';
  mimeType: string;
  /** Base64-encoded audio data. */
  data: string;
  annotations?: ContentAnnotations | undefined;
}

export interface TextResourceContents {
  uri: string;
  mimeType?: string | undefined;
  text: string;
}

export interface BlobResourceContents {
  uri: string;
  mimeType?: string | undefined;
  /** Base64-encoded binary. */
  blob: string;
}

export type EmbeddedResourceContents = TextResourceContents | BlobResourceContents;

export interface EmbeddedResourceContent {
  type: 'resource';
  resource: EmbeddedResourceContents;
  annotations?: ContentAnnotations | undefined;
}

export interface ResourceLinkContent {
  type: 'resource_link';
  uri: string;
  name: string;
  mimeType?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  size?: number | undefined;
  annotations?: ContentAnnotations | undefined;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | EmbeddedResourceContent
  | ResourceLinkContent;

// ────────────────────────────────────────────────────────────────────────────
// Tool calls
// ────────────────────────────────────────────────────────────────────────────

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** A single concrete content payload attached to a tool call. */
export type ToolCallContent =
  | { type: 'content'; content: ContentBlock }
  | {
      type: 'diff';
      path: string;
      oldText: string | null;
      newText: string;
    }
  | { type: 'terminal'; terminalId: TerminalId };

export interface ToolCallLocation {
  path: string;
  /** 1-based per the spec's argument requirements. */
  line?: number | undefined;
}

export interface ToolCall {
  toolCallId: ToolCallId;
  title: string;
  kind?: ToolKind | undefined;
  status?: ToolCallStatus | undefined;
  content?: ToolCallContent[] | undefined;
  locations?: ToolCallLocation[] | undefined;
  rawInput?: Record<string, unknown> | undefined;
  rawOutput?: Record<string, unknown> | undefined;
}

/**
 * Partial update of a previously-emitted tool call. All fields except
 * `toolCallId` are optional — only the changed fields are included.
 * Declared standalone (not `extends ToolCall`) because `title` is required
 * on `ToolCall` but optional here; the structural variance is the point.
 */
export interface ToolCallUpdateFields {
  toolCallId: ToolCallId;
  status?: ToolCallStatus | undefined;
  content?: ToolCallContent[] | undefined;
  title?: string | undefined;
  kind?: ToolKind | undefined;
  locations?: ToolCallLocation[] | undefined;
  rawInput?: Record<string, unknown> | undefined;
  rawOutput?: Record<string, unknown> | undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Plan
// ────────────────────────────────────────────────────────────────────────────

export type PlanEntryPriority = 'high' | 'medium' | 'low';
export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanEntry {
  /** Required by the spec for the array shape, but per-entry id is optional. */
  content: string;
  priority: PlanEntryPriority;
  status: PlanEntryStatus;
}

// ────────────────────────────────────────────────────────────────────────────
// Slash commands
// ────────────────────────────────────────────────────────────────────────────

export interface AvailableCommandInput {
  hint: string;
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: AvailableCommandInput | undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Session modes
// ────────────────────────────────────────────────────────────────────────────

export type SessionModeId = string & { readonly __acpModeId: unique symbol };

export interface SessionMode {
  id: SessionModeId;
  name: string;
  description?: string | undefined;
}

export interface SessionModeState {
  currentModeId: SessionModeId;
  availableModes: SessionMode[];
}

// ────────────────────────────────────────────────────────────────────────────
// Config options
// ────────────────────────────────────────────────────────────────────────────

/** Reserved spec categories. Underscore-prefixed names are free for custom use. */
export type ConfigOptionCategory = 'mode' | 'model' | 'thought_level' | `_${string}`;

export type ConfigOptionType = 'select' | string;

export interface ConfigOptionValue {
  value: string;
  name: string;
  description?: string | undefined;
}

export interface ConfigOption {
  id: string;
  name: string;
  description?: string | undefined;
  category?: ConfigOptionCategory | undefined;
  type: ConfigOptionType;
  currentValue: string;
  options: ConfigOptionValue[];
}

// ────────────────────────────────────────────────────────────────────────────
// Session info
// ────────────────────────────────────────────────────────────────────────────

export interface SessionInfo {
  sessionId: SessionId;
  cwd: string;
  title?: string | undefined;
  updatedAt?: string | undefined;
  /** Agent-supplied extension metadata; opaque to clients. */
  _meta?: Record<string, unknown> | undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Usage (token / cost) updates
// ────────────────────────────────────────────────────────────────────────────

export interface UsageCost {
  amount: number;
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
}

export interface UsageUpdate {
  /** Tokens used in the current session context. Required, non-null. */
  used: number;
  /** Total context window size in tokens. Required, non-null. */
  size: number;
  cost?: UsageCost | undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Permission requests
// ────────────────────────────────────────────────────────────────────────────

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export type RequestPermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string };

// ────────────────────────────────────────────────────────────────────────────
// Stop reasons
// ────────────────────────────────────────────────────────────────────────────

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | string;

// ────────────────────────────────────────────────────────────────────────────
// SessionUpdate — the discriminated union
// ────────────────────────────────────────────────────────────────────────────

/** Stable v1 variants. The spec currently defines exactly 11. */
export type SessionUpdate =
  | UserMessageChunkUpdate
  | AgentMessageChunkUpdate
  | ThoughtChunkUpdate
  | ToolCallUpdateUpdate
  | ToolCallUpdateNotification
  | PlanUpdate
  | AvailableCommandsUpdate
  | CurrentModeUpdate
  | ConfigOptionUpdate
  | SessionInfoUpdate
  | UsageUpdateUpdate;

// --- Streaming message chunks -----------------------------------------------

export interface UserMessageChunkUpdate {
  sessionUpdate: 'user_message_chunk';
  messageId?: MessageId | undefined;
  content: ContentBlock;
}

export interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  messageId?: MessageId | undefined;
  content: ContentBlock;
}

export interface ThoughtChunkUpdate {
  sessionUpdate: 'thought_chunk';
  messageId?: MessageId | undefined;
  content: ContentBlock;
}

// --- Tool calls ------------------------------------------------------------

/** First notification for a new tool call. */
export interface ToolCallUpdateUpdate {
  sessionUpdate: 'tool_call';
  toolCallId: ToolCallId;
  title: string;
  kind?: ToolKind | undefined;
  status?: ToolCallStatus | undefined;
  content?: ToolCallContent[] | undefined;
  locations?: ToolCallLocation[] | undefined;
  rawInput?: Record<string, unknown> | undefined;
}

/** Subsequent updates to a previously-emitted tool call. */
export interface ToolCallUpdateNotification {
  sessionUpdate: 'tool_call_update';
  toolCallId: ToolCallId;
  status?: ToolCallStatus | undefined;
  content?: ToolCallContent[] | undefined;
  title?: string | undefined;
  kind?: ToolKind | undefined;
  locations?: ToolCallLocation[] | undefined;
  rawInput?: Record<string, unknown> | undefined;
  rawOutput?: Record<string, unknown> | undefined;
}

// --- Plan ------------------------------------------------------------------

export interface PlanUpdate {
  sessionUpdate: 'plan';
  entries: PlanEntry[];
}

// --- Commands / modes / config ---------------------------------------------

export interface AvailableCommandsUpdate {
  sessionUpdate: 'available_commands_update';
  availableCommands: AvailableCommand[];
}

export interface CurrentModeUpdate {
  sessionUpdate: 'current_mode_update';
  modeId: SessionModeId;
}

export interface ConfigOptionUpdate {
  sessionUpdate: 'config_option_update';
  configOptions: ConfigOption[];
}

// --- Session metadata ------------------------------------------------------

export interface SessionInfoUpdate {
  sessionUpdate: 'session_info_update';
  title?: string | null | undefined;
  updatedAt?: string | null | undefined;
  _meta?: Record<string, unknown> | undefined;
}

// --- Usage -----------------------------------------------------------------

export interface UsageUpdateUpdate {
  sessionUpdate: 'usage_update';
  used: number;
  size: number;
  cost?: UsageCost | undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Escape hatches: unknown / unstable
// ────────────────────────────────────────────────────────────────────────────

/**
 * Escape hatch for v2-RFD `sessionUpdate` kinds that have been published
 * but are not yet stabilised in the v1 spec. Examples seen in the wild:
 * `next_edit_suggestions`, `elicitation`, `proxy_extension`. We surface
 * the raw payload so forward-compat code can switch on
 * `kind === 'next_edit_suggestions'` etc. without losing the data.
 */
export interface UnstableSessionUpdate {
  sessionUpdate: `_unstable_${string}`;
  [key: string]: unknown;
}

/**
 * Last-resort variant: the agent sent a discriminator string we don't
 * recognise at all. The full payload is preserved as a record so consumers
 * can still log/inspect it. Prefer matching the known variants first.
 */
export interface UnknownSessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

/** The full union, including escape hatches. */
export type AnySessionUpdate = SessionUpdate | UnstableSessionUpdate | UnknownSessionUpdate;

// ────────────────────────────────────────────────────────────────────────────
// Top-level notification envelope
// ────────────────────────────────────────────────────────────────────────────

export interface SessionUpdateNotification {
  jsonrpc?: '2.0' | undefined;
  method: 'session/update';
  params: {
    sessionId: SessionId;
    update: AnySessionUpdate;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Type guards
// ────────────────────────────────────────────────────────────────────────────

/**
 * Exhaustiveness helper. Call from the `default:` branch of a switch on
 * `sessionUpdate` to get a compile-time error when a new variant is added
 * without updating the consumer.
 */
export function assertNeverSessionUpdate(x: never): never {
  throw new Error(`Unhandled sessionUpdate: ${JSON.stringify(x)}`);
}
