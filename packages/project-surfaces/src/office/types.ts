/**
 * The data the office surfaces render: live sessions from the project session registry,
 * fleet agents, mailbox traffic and the activity feed. The WebUI stores and the desktop feed
 * hold these same shapes.
 */

export type MailboxMessageScope = 'project' | 'session' | 'agent';

/** Categories the cinematic renderer understands. */
export type VizEventKind =
  | 'provider:call' // LLM provider call started
  | 'provider:delta' // Streaming text delta
  | 'provider:response' // Provider response received
  | 'agent:spawned' // Agent (leader or subagent) spawned
  | 'agent:tool' // Agent executed a tool
  | 'agent:status' // Agent status change (running → completed/failed)
  | 'agent:ctx' // Agent context pressure update
  | 'agent:text' // Agent streaming/partial text
  | 'tool:started' // Tool execution started
  | 'tool:executed' // Tool execution completed
  | 'tool:progress' // Tool progress update
  | 'mailbox:send' // Mailbox message sent
  | 'mailbox:deliver' // Mailbox message delivered/read
  | 'collab:event' // Collaboration observer/control event
  | 'memory:event' // SAGE retrieval/verification/hygiene event
  | 'brain:council_vote' // One Brain council seat cast its vote
  | 'session:start' // Session started/resumed
  | 'session:end' // Session ended
  | 'iteration:start' // Iteration started
  | 'iteration:end' // Iteration completed
  | 'eternal:iteration' // Eternal-autonomy journal tick
  | 'error' // Error occurred
  | 'context:compacted' // Context compaction
  | 'context:repaired' // Context repair
  | 'budget:warning' // Agent budget warning
  | 'budget:extended' // Agent budget extended
  | 'cost:update' // Cost/token update
  | 'fleet:snapshot'; // Cross-process fleet snapshot (sessions + agents)

export interface VizEvent {
  id: string;
  kind: VizEventKind;
  timestamp: number;
  /** Source node id (e.g. provider id, agent id, tool name) */
  source: string;
  /** Target node id (optional — e.g. provider for tool calls) */
  target?: string | undefined;
  /** Display label */
  label: string;
  /** Numeric magnitude (tokens, cost, duration) for size/color mapping */
  magnitude?: number | undefined;
  /** Extra structured payload for the renderer */
  data?: Record<string, unknown> | undefined;
  /** The raw WS payload for drill-down in detail panels */
  raw?: unknown | undefined;
  /** Grouping key for the flow (e.g. 'iteration:3', 'agent:leader') */
  flowGroup?: string | undefined;
  /** Color hint for the renderer */
  color?: string | undefined;
}

export interface ClientCounts {
  tui: number;
  webui: number;
  repl: number;
}

/** One agent inside a live cross-process session (from sessions.status_update). */
export interface LiveAgent {
  id: string;
  name: string;
  status: string;
  currentTool?: string | undefined;
  currentTask?: string | undefined;
  taskId?: string | undefined;
  iterations?: number | undefined;
  toolCalls?: number | undefined;
  costUsd?: number | undefined;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  ctxPct?: number | undefined;
  model?: string | undefined;
  partialText?: string | undefined;
  recentTools?: LiveToolActivity[] | undefined;
  recentMail?: LiveMailActivity[] | undefined;
  todos?: LiveTodoItem[] | undefined;
  latestPrompt?: string | undefined;
  latestPromptAt?: number | undefined;
  activity?: LiveAgentActivity | undefined;
  lastActivityAt?: string | undefined;
}

export interface LiveTodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string | undefined;
}

/** Compact completed tool receipt mirrored through the project session registry. */
export interface LiveToolActivity {
  id: string;
  name: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  ok: boolean;
  input?: unknown | undefined;
  output?: string | undefined;
  inputLines?: number | undefined;
  oldLines?: number | undefined;
  newLines?: number | undefined;
  addedLines?: number | undefined;
  removedLines?: number | undefined;
  outputLines?: number | undefined;
  outputBytes?: number | undefined;
  outputTokens?: number | undefined;
}

/** Compact mail receipt mirrored through the project session registry. */
export interface LiveMailActivity {
  id: string;
  direction: 'incoming' | 'outgoing';
  from: string;
  to: string;
  type: string;
  subject: string;
  at: number;
}

export interface LiveAgentActivity {
  filesTouched: string[];
  reads: number;
  writes: number;
  edits: number;
  terminalCalls: number;
  webCalls: number;
  searches: number;
  otherCalls: number;
  mailReceived: number;
  mailSent: number;
  linesRead: number;
  linesWritten: number;
  linesAdded: number;
  linesRemoved: number;
}

/** One live session across any surface, as broadcast by the server's
 *  SessionRegistry poll (`sessions.status_update`). This is the cross-process
 *  source of truth the Fleet HQ office map renders from. */
export interface LiveSession {
  sessionId: string;
  pid?: number | undefined;
  /** Surface that owns the session: 'tui' | 'webui' | 'cli'. */
  clientType?: string | undefined;
  projectName?: string | undefined;
  projectSlug?: string | undefined;
  gitBranch?: string | undefined;
  status?: string | undefined;
  /** UTC ISO when the session was registered — used for uptime. */
  startedAt?: string | undefined;
  /** Last registry heartbeat proving the terminal process is still live. */
  lastHeartbeatAt?: string | undefined;
  /** Absolute working directory of the session. */
  workingDir?: string | undefined;
  agentCount?: number | undefined;
  agents: LiveAgent[];
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

export interface MailboxMessage {
  id: string;
  from: string;
  to: string;
  /** Server-derived delivery scope. Re-classified client-side as a fallback. */
  scope?: MailboxMessageScope | undefined;
  /** Session id from `to` when `scope === 'session'`. */
  recipientSessionId?: string | undefined;
  type: string;
  /** Agent delivery audience; `leaders` is not consumed by subagents. */
  audience?: 'all' | 'leaders' | undefined;
  subject: string;
  body: string;
  priority: string;
  readBy: Record<string, string>;
  /** Count of agents who have marked this message as read. */
  readByCount: number;
  completed: boolean;
  completedBy?: string | undefined;
  completedAt?: string | undefined;
  outcome?: string | undefined;
  timestamp: string;
  senderSessionId?: string | undefined;
  /** ID of the message this is a reply to, if any. */
  replyTo?: string | undefined;
  /** Free-form task context attached to the message by the sender. */
  taskContext?: string | undefined;
}

export interface MailboxAgent {
  agentId: string;
  name: string;
  role?: string | undefined;
  sessionId: string;
  status: string;
  currentTool?: string | undefined;
  currentTask?: string | undefined;
  lastSeenAt: string;
  online: boolean;
  source?: string | undefined;
  /** Process ID of the agent subprocess, if tracked. */
  pid?: number | undefined;
  /** Number of iterations the agent has run. */
  iterations?: number | undefined;
  /** Number of tool calls the agent has made in the current iteration. */
  toolCalls?: number | undefined;
}
