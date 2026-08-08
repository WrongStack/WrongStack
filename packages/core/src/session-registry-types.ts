/**
 * Cross-process session + agent registry record shapes.
 *
 * Split out of `session-registry.ts` so the registry module is just behaviour.
 * Re-exported verbatim from there, which stays the import site for every
 * consumer inside and outside this package.
 *
 * @module session-registry-types
 */

/** Live status of a single agent within a session. */
export type AgentLiveStatus =
  | 'idle'
  | 'running'
  | 'streaming'
  | 'waiting_user' // brain.ask_human, confirm prompt
  | 'error';

/** A bounded, display-safe tool receipt shared with cross-process observers. */
export interface AgentRecentTool {
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

export interface AgentRecentMail {
  id: string;
  direction: 'incoming' | 'outgoing';
  from: string;
  to: string;
  type: string;
  subject: string;
  at: number;
}

/** A compact todo mirrored with the leader so every Office can show its live worklist. */
export interface AgentTodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string | undefined;
}

/** Session-long aggregate used by project Office dashboards. */
export interface AgentActivityTotals {
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

export interface AgentEntry {
  /** Unique agent id (ULID or UUID). */
  id: string;
  /** Human-readable label (e.g. "leader", "bug-hunter #1"). */
  name: string;
  /** UTC ISO timestamp when this agent/run started, when known. */
  startedAt?: string | undefined;
  status: AgentLiveStatus;
  /** Current tool name if running, undefined otherwise. */
  currentTool?: string | undefined;
  /** Human-readable task currently assigned to this agent. */
  currentTask?: string | undefined;
  /** Stable coordinator task id when this is a delegated/subagent task. */
  taskId?: string | undefined;
  /** Iteration count so far. */
  iterations: number;
  /** Tool calls so far. */
  toolCalls: number;
  /** Cumulative cost in USD for this agent, when known. */
  costUsd?: number | undefined;
  /** Cumulative input tokens, when known. */
  tokensIn?: number | undefined;
  /** Cumulative output tokens, when known. */
  tokensOut?: number | undefined;
  /** Context window fill 0–100 (may exceed 100 when over limit), when known. */
  ctxPct?: number | undefined;
  /** Model id this agent is running on, when known. */
  model?: string | undefined;
  /**
   * Tail of the assistant text currently being streamed (capped, throttled).
   * Lets a cross-process watcher see the response form in near-real-time
   * instead of waiting for the completed turn to land in the session log.
   */
  partialText?: string | undefined;
  /** Recent completed tools, newest first. Bounded by AgentStatusTracker. */
  recentTools?: AgentRecentTool[] | undefined;
  recentMail?: AgentRecentMail[] | undefined;
  /** Session worklist. Populated on the leader entry only. */
  todos?: AgentTodoItem[] | undefined;
  /** Most recent operator prompt. Populated on the leader entry only. */
  latestPrompt?: string | undefined;
  latestPromptAt?: number | undefined;
  /** Cumulative activity for this live session, reset when the session ends. */
  activity?: AgentActivityTotals | undefined;
  /** UTC ISO timestamp of last activity. */
  lastActivityAt: string;
}

export type SessionLiveStatus =
  | 'active' // process running, agents may be idle or busy
  | 'idle' // process running, no agent activity
  | 'closing' // session_end written, process shutting down
  | 'stale' // process no longer alive (pruned on next read)
  | 'lost'; // heartbeat timeout — process may still be alive but unreachable

export interface SessionWebUIEndpointHint {
  role: 'standalone' | 'parent-shell' | 'session-child';
  surface: 'webui' | 'simpleui' | string;
  host: string;
  httpPort: number;
  url: string;
  /** Redundant owner PID used to cross-check against WebUI instance records. */
  pid: number;
  parentPid?: number | undefined;
  parentShellId?: string | undefined;
  runtimeId?: string | undefined;
  attachable?: boolean | undefined;
  protocolVersion?: number | undefined;
  capabilities?: string[] | undefined;
}

export interface SessionRegistryEntry {
  sessionId: string;
  projectSlug: string;
  projectRoot: string;
  projectName: string;
  workingDir: string;
  /**
   * Which surface owns this session — `'tui'` / `'webui'` / `'cli'` (one-shot or
   * REPL). Lets cross-process consumers (e.g. the WebUI Fleet HQ office map) label
   * each live session by client kind. Optional for back-compat with older entries.
   */
  clientType?: 'tui' | 'webui' | 'cli' | 'repl' | string | undefined;
  /** Current git branch, if the project is a git repo. Detected at registration. */
  gitBranch?: string | undefined;
  status: SessionLiveStatus;
  pid: number;
  /** UTC ISO */
  startedAt: string;
  /** UTC ISO — updated on every heartbeat */
  lastHeartbeatAt: string;
  /** Count of tracked agents */
  agentCount: number;
  agents: AgentEntry[];
  /** Optional WebUI endpoint hint. Session ownership remains keyed by `sessionId` + `pid`. */
  webuiEndpoint?: SessionWebUIEndpointHint | undefined;
}
