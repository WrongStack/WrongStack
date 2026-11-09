import type {
  TrustActor,
  TrustAuthContext,
  TrustBoundary,
  TrustScope,
} from '@wrongstack/core/security';
import type {
  AnySessionUpdate,
  McpServer,
  PlanEntry,
  StopReason,
  ToolCallStatus,
  ToolKind,
  UsageCost,
} from '../types/acp-v1.js';
import type { PermissionPolicy } from './permission.js';

export interface ACPSessionOptions {
  command: string;
  args?: readonly string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  role?: string | undefined;
  projectRoot: string;
  /**
   * Serve `fs/*` calls for absolute paths outside `projectRoot`, matching the
   * host's `features.allowOutsideProjectRoot` policy for its own file tools.
   * Without it an agent reading its own config or a temp file got "path is
   * outside the project root". Writes still go through `permissionPolicy`.
   * Default false.
   */
  allowOutsideProjectRoot?: boolean | undefined;
  /** Cap for each request to the agent other than a prompt turn. Default 5 minutes. */
  timeoutMs?: number | undefined;
  /**
   * How long a prompt turn may go without hearing from the agent (an update,
   * a permission request, a file or terminal call) before it counts as
   * stalled and is cancelled. Default 10 minutes. A turn that keeps reporting
   * runs until it ends: a coding agent's turn routinely outlasts any fixed cap.
   */
  promptIdleTimeoutMs?: number | undefined;
  permissionPolicy?: PermissionPolicy | undefined;
  trustBoundary?: TrustBoundary | undefined;
  trustActor?: TrustActor | undefined;
  trustScope?: TrustScope | undefined;
  trustAuthContext?: TrustAuthContext | undefined;
  fsTimeoutMs?: number | undefined;
  terminalTimeoutMs?: number | undefined;
  terminalOutputByteLimit?: number | undefined;
  terminalMaxCount?: number | undefined;
  mcpServers?: McpServer[] | undefined;
  /**
   * Opaque `_meta` sent with `session/new`. ACP reserves `_meta` for
   * agent-specific extensions; e.g. the Claude adapter reads
   * `systemPrompt: { append }` from it. Agents that know no key ignore it.
   */
  sessionMeta?: Record<string, unknown> | undefined;
  /**
   * Session mode to switch to right after `session/new`, when the agent
   * offers it (e.g. Claude's `default`, so it asks before edits and
   * commands instead of following the user's own Claude permission mode).
   */
  initialModeId?: string | undefined;
  /**
   * Refuse the session when the agent does not offer `initialModeId`: the
   * host depends on that mode (an agent left in its own mode may never ask).
   */
  requireInitialMode?: boolean | undefined;
  /**
   * An earlier session of this agent to continue instead of starting one
   * (`session/resume`, with this session's MCP servers, `_meta` and mode).
   * Used when the agent advertises resume; when it does not, or no longer has
   * the session, a new session starts. `openSession()` says which happened.
   */
  resumeSessionId?: string | undefined;
}

export interface ACPCapturedDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

export interface ACPCapturedToolCall {
  toolCallId: string;
  title: string;
  kind?: ToolKind | undefined;
  status: ToolCallStatus;
  rawOutput?: Record<string, unknown> | undefined;
  rawInput?: Record<string, unknown> | undefined;
  /**
   * What the call returned, as text: its `content` text blocks, else a
   * string or text-block `rawOutput`. Claude's adapter sends the result in
   * those shapes, which `rawOutput` (an object only) never held.
   */
  output?: string | undefined;
}

export interface ACPSessionRunResult {
  text: string;
  stopReason: StopReason;
  hasText: boolean;
  usage?: { used: number; size: number; cost?: UsageCost | undefined } | undefined;
  /**
   * Token counts for the turn, from the `session/prompt` response
   * (`PromptResponse.usage`). `usage.cost`, by contrast, is the session's
   * running total.
   */
  tokens?: ACPTokenUsage | undefined;
  plan?: PlanEntry[] | undefined;
  toolCalls: ACPCapturedToolCall[];
  diffs: ACPCapturedDiff[];
  thoughts: string;
}

export interface ACPTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ACPProgressHandler = (event: ACPProgressEvent) => void;

export type ACPProgressEvent =
  | { type: 'message'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool_call'; toolCall: ACPCapturedToolCall }
  | { type: 'tool_call_update'; toolCall: ACPCapturedToolCall }
  | { type: 'diff'; diff: ACPCapturedDiff }
  | { type: 'plan'; entries: PlanEntry[] }
  | { type: 'usage'; usage: { used: number; size: number; cost?: UsageCost | undefined } }
  /**
   * The agent's account rate-limit reading, as it sent it (Claude's adapter:
   * `usage_update._meta["_claude/rateLimit"]` — status, resetsAt, windows).
   */
  | { type: 'rate_limit'; info: Record<string, unknown> }
  /** Emitted by the subagent runner once a turn ends: what the turn consumed. */
  | { type: 'turn_usage'; tokens?: ACPTokenUsage | undefined; costUsd: number }
  | { type: 'raw'; update: AnySessionUpdate };

export type ACPSessionErrorKind =
  | 'spawn_failed'
  | 'init_failed'
  | 'protocol_error'
  | 'session_create_failed'
  | 'prompt_failed'
  | 'auth_failed'
  | 'logout_failed'
  | 'aborted'
  | 'closed'
  | 'agent_died'
  /** A prompt turn heard nothing from the agent for `promptIdleTimeoutMs`. */
  | 'stalled'
  | 'unsupported_capability';
