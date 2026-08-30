import type { ExactServerMessageType } from '@wrongstack/webui-protocol';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface ChatMessage {
  id: string;
  role: 'user' | 'thinking' | 'assistant' | 'system';
  text: string;
  /** Canonical replay order from the session timeline; preserves same-timestamp tool/text order. */
  replayOrder?: number | undefined;
  streaming?: boolean | undefined;
  /**
   * Whether this assistant message ended its turn — the provider stopped
   * without asking for another tool. Only final messages may show a NEXT STEPS
   * panel; mid-turn prose keeps its `<nextsteps>` block stripped but silent.
   */
  final?: boolean | undefined;
  /** Structured fallback for a successful `nextsteps` tool call. */
  nextSteps?: Array<{ index: number; text: string; auto?: boolean | undefined }> | undefined;
  ts?: string | undefined;
  /** Base64-encoded images attached to user messages. */
  images?: { data: string; mime: string }[] | undefined;
}

export interface SessionInfo {
  id: string;
  provider: string;
  model: string;
  projectName: string;
  cwd: string;
  maxContext: number;
}

export interface SimpleSessionSummary {
  id: string;
  title: string;
  name?: string | undefined;
  lastUserMessage?: string | undefined;
  messageCount?: number | undefined;
  lastActivityAt?: string | undefined;
  startedAt: string;
  model: string;
  provider: string;
  isCurrent: boolean;
}

export interface ContextInfo {
  load: number;
  tokens: number;
  maxContext: number;
  /**
   * Cumulative prompt-cache stats from the session TokenCounter. Kept
   * on `ContextInfo` (rather than a separate store) because the only
   * live writer is `stats.get` and the only live reader is the topbar
   * context meter + the breakdown modal — same lifetime as the
   * context window itself. `null` until the first `stats.get` reply
   * lands so the topbar can distinguish "no cache yet" from "0 hit".
   */
  cache: {
    readTokens: number;
    writeTokens: number;
    hitRatio: number;
    /** Tokens billed at the cache-read rate on the most recent prompt. */
    coverageTokens: number;
  } | null;
}

export interface ResumeProgressInfo {
  sessionId: string;
  stage: string;
  loadedBytes: number;
  totalBytes: number;
}

export interface ModelDescriptor {
  id: string;
  name: string;
  contextWindow?: number | undefined;
}

export interface ProviderModels {
  provider: string;
  label: string;
  models: ModelDescriptor[];
}

export interface SimpleSubagent {
  id: string;
  name: string;
  status: string;
  task?: string | undefined;
  model?: string | undefined;
  /** Epoch ms of the last status/activity update — drives idle pruning. */
  updatedAt?: number | undefined;
}

export type AgentTranscriptKind =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'status'
  | 'system';

export interface AgentTranscriptEntry {
  id: string;
  subagentId: string;
  agentName: string;
  content: string;
  kind: AgentTranscriptKind;
  iteration: number;
  ts: string;
  toolName?: string | undefined;
  toolOk?: boolean | undefined;
}

export interface AgentSessionReplay {
  subagentId: string;
  agentName: string;
  status: string;
  task?: string | undefined;
  transcript: AgentTranscriptEntry[];
}

export interface AgentMode {
  id: string;
  name: string;
  description?: string | undefined;
}

export interface PendingConfirm {
  id: string;
  toolName: string;
  input: unknown;
  riskTier?: string | undefined;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  input: unknown;
  status: 'running' | 'done' | 'error';
  /** Canonical replay order from the session timeline; preserves same-timestamp tool/text order. */
  replayOrder?: number | undefined;
  output?: string | undefined;
  durationMs?: number | undefined;
  ok?: boolean | undefined;
  /** ISO timestamp set when the tool call starts — drives timeline ordering. */
  ts?: string | undefined;
  /**
   * Live SAGE Memory Injector block, header line first. Carried separately
   * from `output` so the renderer can give it its own MEMORY heading instead
   * of concatenating the `--- SAGE: … ---` suffix into the OUTPUT block.
   * Replayed history still embeds the block inline in `output`; the entry
   * renderer splits it via `splitSageBlock()` as a fallback.
   */
  sage?: string[] | undefined;
}

/** File edit metadata extracted from tool call output (edit/write/patch). */
export interface FileEditMeta {
  path: string;
  /** Number of replacements (edit tool). */
  replacements?: number | undefined;
  /** Unified diff string. */
  diff?: string | undefined;
  /** Bytes written (write tool). */
  bytesWritten?: number | undefined;
  /** Whether the file was created (write tool). */
  created?: boolean | undefined;
  /** Timestamp when the file edit occurred. */
  ts?: string | undefined;
}

/** Unified timeline entry — either a chat message or an interleaved tool call. */
export type TimelineEntry =
  | { kind: 'message'; ts: string; message: ChatMessage }
  | { kind: 'tool_call'; ts: string; toolCall: ToolCallInfo };

export interface ServerMessage {
  type: ExactServerMessageType;
  payload: Record<string, unknown>;
}
