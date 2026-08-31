import type { ContentBlock, Usage } from '@wrongstack/core/types';

// ============================================
// Shared Types
// ============================================

export type CouncilVoteStatus = 'valid' | 'invalid' | 'failed' | 'cancelled';

/** One council seat's observable vote. No hidden chain-of-thought is retained. */
export interface CouncilSeatVote {
  seatId: string;
  persona: string;
  status: CouncilVoteStatus | string;
  /** The option this seat voted for, on an option-bearing question. */
  optionId?: string | undefined;
  /** Free-text stance / rationale; only present when trace content is full. */
  stance?: string | undefined;
  rationale?: string | undefined;
  providerId?: string | undefined;
  model?: string | undefined;
  veto?: boolean | undefined;
  weight?: number | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
  at: number;
}

interface MessageContent {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentBlock[];
}

export interface ToolExecution {
  id: string;
  name: string;
  input?: unknown | undefined;
  output?: string | undefined;
  durationMs?: number | undefined;
  ok: boolean;
  startedAt: number;
  completedAt?: number | undefined;
}

/** An image attached to a user chat message, rendered as a thumbnail in the
 *  bubble. `dataUrl` is dropped from localStorage persistence (quota) — after
 *  a refresh the thumbnail degrades to a name/size placeholder chip. */
export interface ChatMessageAttachment {
  id: string;
  kind: 'image';
  /** Data URL for the thumbnail. Undefined once rehydrated from persistence. */
  dataUrl?: string | undefined;
  mediaType: string;
  bytes: number;
  name?: string | undefined;
}

export interface ChatMessage {
  id: string;
  content: string;
  /** Images the user attached to this message (user role only). */
  attachments?: ChatMessageAttachment[] | undefined;
  /** A compact, presentation-only summary for a built-in Elite Bug Hunter
   * request. The full instruction is still sent to the agent, but never
   * printed into the user's transcript. */
  bugHunt?:
    | {
        scope: string;
        maxBugs: 1 | 2 | 3;
      }
    | undefined;
  role: 'user' | 'assistant' | 'system' | 'tool';
  toolName?: string | undefined;
  toolInput?: unknown | undefined;
  toolResult?: string | undefined;
  /**
   * SAGE Memory Injector block for this tool call — header line plus one line
   * per injected memory — delivered as a dedicated `tool.executed.sage` field
   * instead of being buried in `toolResult`. Rendered as a compact badge by
   * `ToolResult`; full details in the `MemoryInjectorPanel` side drawer.
   *
   * Absent on replayed messages, where the block is still inline in the
   * persisted tool_result content; `extractSageBlock` recovers it there.
   */
  sageLines?: string[] | undefined;
  /** Wall-clock ms reported by the backend in tool.executed; rendered next
   *  to the tool name so the user can spot slow tools at a glance. */
  toolDurationMs?: number | undefined;
  /** Backend's tool_use id (e.g. "toolu_..." from Anthropic). Used to map
   *  tool.executed events back to the right bubble when the model fires
   *  multiple tools in parallel — currentToolId alone only points at the
   *  most recent start and would leave earlier ones stuck on "Running...". */
  toolUseId?: string | undefined;
  isError?: boolean | undefined;
  timestamp: number;
  usage?: Usage | undefined;
  streaming?: boolean | undefined;
  parentId?: string | undefined;
  /** Live progress lines for an in-flight tool, populated from
   *  tool.progress WS events. Each line is shown in chronological order
   *  inside the tool bubble while it's still running, and cleared once the
   *  final tool.executed lands (toolResult takes over). Capped to the last
   *  ~30 lines so a chatty bash command can't grow this unbounded. */
  progressLines?: string[] | undefined;
  /** End-of-run summary attached to the last assistant message of a turn
   *  after run.result lands. Populated by the run.result handler in
   *  useWebSocket — gives the user a single-line readout of what just
   *  happened (iterations, tool calls, elapsed time, cost). */
  runSummary?: {
    iterations: number;
    tools: number;
    durationMs: number;
    costDelta: number;
  };
  /** Archived extended-thinking text captured during one agent iteration.
   *  The live thinking bubble is transient; this metadata keeps the final
   *  process log in chat history once the iteration completes. */
  thinkingLog?:
    | {
        iteration: number;
        text: string;
        startedAt: number;
        durationMs: number;
        replayed?: boolean | undefined;
      }
    | undefined;
  /**
   * Delivery status for user messages. `'sent'` (default) means the WS
   * round-trip succeeded. `'failed'` means the message could not be
   * delivered (WS disconnected, server error) — rendered with a visual
   * error indicator so the user can distinguish it from successfully
   * delivered messages.
   *
   * P3 #D4 (sprint2 audit): optimistic entries that fail delivery stay
   * in the chat list; this flag lets the UI mark them visually instead
   * of leaving them indistinguishable from sent messages.
   */
  status?: 'sent' | 'failed' | undefined;
  /**
   * Parsed next-steps suggestions extracted from the assistant message
   * at finalization time. The canonical `<nextsteps>` block is stripped
   * from `content` once and the steps are stored here so the bar can
   * render without re-parsing — and so the block never leaks back into
   * the rendered body when the message stops being "latest" (e.g. while
   * the next turn is streaming). Empty/undefined when there were none.
   *
   * `autoText` carries the first item's text when it was marked
   * `auto="true"`, for YOLO+auto countdown. Undefined otherwise.
   */
  nextSteps?:
    | { steps: Array<{ index: number; text: string; auto?: boolean | undefined }> }
    | undefined;
  /**
   * Chimera review-report card payload — present when this system message
   * renders as an actionable report card (ChimeraReportCard) instead of a
   * plain notice bubble. The card carries the one-click "send the leader to
   * work on this report" affordance; `actionedAt` flips once that prompt has
   * been submitted so the button can never double-fire.
   */
  chimeraReport?: { reportId: string; actionable: boolean; actionedAt: number | null } | undefined;
  /**
   * Council multi-model consensus & decision payload — present when this
   * message renders as a dedicated, visually styled CouncilDecisionCard with
   * voting charts and seat breakdowns instead of a plain text bubble.
   */
  councilDecision?: CouncilDecisionData | undefined;
  /**
   * Brain arbiter decision/intervention payload — present when this message
   * renders as a dedicated, visually styled BrainDecisionCard with neural
   * styling, risk level, and rationale instead of a plain text bubble.
   */
  brainDecision?: BrainDecisionData | undefined;
}

export interface CouncilDecisionData {
  requestId?: string | undefined;
  phase?: 'voting' | 'resolved' | undefined;
  startedAt?: number | undefined;
  resolvedAt?: number | undefined;
  status?: string | undefined;
  resolution?: string | undefined;
  optionId?: string | undefined;
  question?: string | undefined;
  reason?: string | undefined;
  configuredSeatCount?: number | undefined;
  validVoteCount?: number | undefined;
  distinctTargetCount?: number | undefined;
  judgeUsed?: boolean | undefined;
  judgeModel?: string | undefined;
  judgeRationale?: string | undefined;
  totalTokens?: number | undefined;
  durationMs?: number | undefined;
  warnings?: string[] | undefined;
  seats: CouncilSeatVote[];
}

export interface BrainDecisionData {
  id?: string | undefined;
  kind: 'answered' | 'denied' | 'ask_human' | 'intervention' | 'check' | 'direct' | string;
  intervened?: boolean | undefined;
  decisionType?: string | undefined;
  optionId?: string | undefined;
  question?: string | undefined;
  text?: string | undefined;
  reason?: string | undefined;
  rationale?: string | undefined;
  source?: string | undefined;
  risk?: string | undefined;
  tier?: string | undefined;
  confidence?: number | undefined;
  at?: number | undefined;
}

export interface SessionInfo {
  id: string;
  startedAt: number;
  provider: string;
  model: string;
  title?: string | undefined;
}

/** A row in the sidebar's History tab. Mirrors core's SessionSummary +
 *  isCurrent so the active session can be highlighted. Timestamps are
 *  ISO-8601 strings as stored on disk; the UI parses them lazily. */
export interface SessionHistoryEntry {
  id: string;
  title: string;
  /** Optional user-set name; takes precedence over `title` when present. */
  name?: string | undefined;
  startedAt: string;
  endedAt?: string | undefined;
  model: string;
  provider: string;
  tokenTotal: number;
  lastActivityAt?: string | undefined;
  messageCount?: number | undefined;
  lastUserMessage?: string | undefined;
  iterationCount?: number | undefined;
  toolCallCount?: number | undefined;
  toolErrorCount?: number | undefined;
  fileChangeCount?: number | undefined;
  toolBreakdown?: Record<string, number> | undefined;
  compactionCount?: number | undefined;
  outcome?: 'completed' | 'error' | 'timeout' | 'aborted' | undefined;
  isCurrent: boolean;
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
  sessionId?: string | undefined;
  agentName: string;
  content: string;
  kind: AgentTranscriptKind;
  iteration: number;
  ts: string;
  toolName?: string | undefined;
  toolOk?: boolean | undefined;
  costUsd?: number | undefined;
  status?: string | undefined;
}

/** One live (or just-finished) subagent in the fleet roster. */
export interface SubagentView {
  id: string;
  /** Session this agent belongs to — ties the agent to a specific project/session.
   *  Used to filter/cleanup agents on project switch. */
  sessionId?: string | undefined;
  /** Display name — the leader-assigned nickname (may be multi-word, e.g.
   *  "Von Neumann"). Falls back to the raw id until `spawned` names it. */
  name: string;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'stopped';
  provider?: string | undefined;
  model?: string | undefined;
  description?: string | undefined;
  taskId?: string | undefined;
  /** Latest iteration index from iteration_summary. */
  iteration: number;
  /** Cumulative tool calls (authoritative from iteration_summary, live-bumped
   *  by tool_executed between summaries). */
  toolCalls: number;
  costUsd: number;
  /** Tool the agent says it's running right now (iteration_summary). */
  currentTool?: string | undefined;
  /** Most-recent completed tool name (tool_executed). */
  lastTool?: string | undefined;
  /** Context-window load 0–100. */
  ctxPct: number;
  ctxTokens: number;
  maxContext: number;
  /** How many times this agent self-extended its budget. */
  extensions: number;
  error?: { kind: string | undefined; message: string };
  startedAt: number;
  completedAt?: number | undefined;
  /** Accumulated partial text from periodic iteration_summary snapshots.
   *  Last ~200 chars of the subagent's streaming output — gives live
   *  visibility into what the subagent is writing. */
  partialText?: string | undefined;
  /** Final output text from task_completed — the subagent's complete response. */
  finalText?: string | undefined;
  /** Running log of tool executions: name, ok/fail, duration. Most recent
   *  first, capped at ~50 entries to avoid memory bloat on long runs. */
  toolLog: Array<{ name: string; ok: boolean; durationMs: number; at: number }>;
  /** 12-bin activity sparkline (0–12, one per 2-second bucket). Each value
   *  is the count of events in that bucket, normalized to 0–12 for display.
   *  Updated on tool_executed and iteration_summary events. */
  sparklineBins: number[];
  /** Budget warning: subagent hit a soft limit and coordinator is auto-extending.
   *  Rendered as "⚡ hitting {kind} limit ({used}/{limit}) — extending". */
  budgetWarning?: { kind: string; used: number; limit: number } | undefined;
  /** Human-readable reason for terminal failure when status is failed/timeout.
   *  E.g. "provider_auth", "rate_limit", "timeout", "budget_iterations". */
  failureReason?: string | undefined;
  /** True when this is the leader agent (vs. a spawned subagent). */
  isLeader?: boolean | undefined;
  /** Per-agent token usage (from ctx_pct event). ctxPct is display-capped at 100. */
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
}

/** Discriminated payload mirroring the subagent.* events the backend forwards. */
export interface SubagentEvent {
  kind:
    | 'spawned'
    | 'task_started'
    | 'tool_executed'
    | 'iteration_summary'
    | 'budget_warning'
    | 'budget_extended'
    | 'ctx_pct'
    | 'task_completed'
    | 'removed'
    | 'session_stopped'
    | 'leader_updated';
  subagentId?: string | undefined;
  /** Session this agent belongs to — forwarded from the server on every subagent event. */
  sessionId?: string | undefined;
  name?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  description?: string | undefined;
  taskId?: string | undefined;
  toolName?: string | undefined;
  iteration?: number | undefined;
  toolCalls?: number | undefined;
  costUsd?: number | undefined;
  currentTool?: string | undefined;
  load?: number | undefined;
  rawLoad?: number | undefined;
  tokens?: number | undefined;
  maxContext?: number | undefined;
  totalExtensions?: number | undefined;
  /** Budget warning details from subagent.budget_warning. */
  budgetKind?: string | undefined;
  used?: number | undefined;
  limit?: number | undefined;
  status?: 'success' | 'failed' | 'timeout' | 'stopped' | undefined;
  iterations?: number | undefined;
  error?: { kind: string | undefined; message: string };
  /** Tool execution result (tool_executed event). */
  ok?: boolean | undefined;
  /** Tool execution duration in ms (tool_executed event). */
  durationMs?: number | undefined;
  /** Accumulated partial text (iteration_summary event). */
  partialText?: string | undefined;
  /** Final output text (task_completed event). */
  finalText?: string | undefined;
  /** Failure reason for task_completed with failed/timeout status. */
  failureReason?: string | undefined;
  /** Lifecycle removal reason, when kind is removed. */
  reason?: string | undefined;
  /** True when this event marks the agent as the leader. */
  isLeader?: boolean | undefined;
  /** Tokens in/out for fleet-wide aggregation (from ctx_pct event). */
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
}

/** A single entry in the Fleet Monitor event timeline. */
export interface FleetTimelineEvent {
  id: string;
  kind:
    | 'spawned'
    | 'task_started'
    | 'tool_executed'
    | 'iteration_summary'
    | 'budget_warning'
    | 'budget_extended'
    | 'task_completed'
    | 'ctx_pct'
    | 'leader_updated';
  agentId: string;
  agentName: string;
  timestamp: number;
  message: string;
  /** Numeric value for sorting/display (e.g. duration, cost delta). */
  value?: number | undefined;
}
