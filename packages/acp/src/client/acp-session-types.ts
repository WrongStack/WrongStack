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
  timeoutMs?: number | undefined;
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
}

export interface ACPSessionRunResult {
  text: string;
  stopReason: StopReason;
  hasText: boolean;
  usage?: { used: number; size: number; cost?: UsageCost | undefined } | undefined;
  plan?: PlanEntry[] | undefined;
  toolCalls: ACPCapturedToolCall[];
  diffs: ACPCapturedDiff[];
  thoughts: string;
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
  | 'unsupported_capability';
