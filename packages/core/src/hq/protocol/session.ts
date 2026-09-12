import type { HqClientKind, HqClientRecord } from './client.js';
import type { HqMachineRecord } from './core.js';
import type { HqFleetSummary } from './fleet.js';
import type { HqMailboxSummary } from './mailbox.js';
import type { HqMcpServerHealth } from './mcp.js';
import type { HqProjectRecord } from './project.js';

export type HqSessionStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed';

export interface HqSessionStartedPayload {
  sessionId: string;
  provider?: string;
  model?: string;
  startedAt: string;
}

export interface HqSessionStatusPayload {
  status: HqSessionStatus;
  phase?: string;
  message?: string;
}

export interface HqSubagentSummary {
  subagentId: string;
  role?: string;
  status: 'pending' | 'running' | 'idle' | 'completed' | 'failed' | 'stopped';
  task?: string;
  currentTool?: string;
  runtimeMs?: number;
  costUsd?: number;
  lastActivityAt?: string;
  /**
   * The provider/model this worker actually runs on, `provider/model` when the
   * provider is known. `FleetTelemetryBridge` has always put it on the wire —
   * the field was missing from this contract, so a consumer could not read it
   * type-safely. It is the answer to "did my per-session model routing take
   * effect", which is otherwise invisible from HQ.
   */
  model?: string;
}

/** Payload for `agent.message` events — a subagent's conversational output. */
export interface HqAgentMessagePayload {
  subagentId: string;
  agentName: string;
  content: string;
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'status' | 'system';
  iteration: number;
  ts: string;
  toolName?: string;
  costUsd?: number;
}

/** Payload for `agent.status` events — a subagent's lifecycle transition. */
export interface HqAgentStatusPayload {
  subagentId: string;
  agentName: string;
  status:
    | 'spawned'
    | 'running'
    | 'completed'
    | 'failed'
    | 'timeout'
    | 'stopped'
    | 'budget_exhausted';
  ts: string;
  summary?: string;
  task?: string;
}

// ── Session telemetry (live terminals + full chat transcript) ──────────────
//
// Every surface (tui / repl / webui / cli) streams its own live session state
// and conversation transcript to HQ so the command center can render a true
// machine → project → terminal → agent → full-history tree across every
// connected machine — not just the one HQ happens to run on.

export type HqSessionLiveStatus = 'active' | 'idle' | 'closing' | 'stale';

export type HqSessionAgentLiveStatus = 'idle' | 'running' | 'streaming' | 'waiting_user' | 'error';

/** A single live agent inside a session snapshot (mirrors SessionRegistry's AgentEntry). */
export interface HqSessionAgentSummary {
  id: string;
  name: string;
  /** UTC ISO timestamp when this agent/run started, when known. */
  startedAt?: string;
  status: HqSessionAgentLiveStatus;
  currentTool?: string;
  iterations: number;
  toolCalls: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  ctxPct?: number;
  model?: string;
  /** Throttled tail of the response currently streaming, when known. */
  partialText?: string;
  lastActivityAt: string;
}

/** Payload for `session.snapshot` — one connected terminal's live state. */
export interface HqSessionSnapshotPayload {
  sessionId: string;
  /** HQ publisher that owns this live session. Added by the HQ server when
   *  folding client telemetry, so browser controls can target the exact
   *  process instead of guessing from machine/project metadata. */
  clientId?: string;
  clientKind: HqClientKind;
  machineId: string;
  hostname?: string;
  pid?: number;
  projectId: string;
  projectName: string;
  projectRoot: string;
  gitBranch?: string;
  status: HqSessionLiveStatus;
  startedAt: string;
  lastActivityAt: string;
  agentCount: number;
  agents: readonly HqSessionAgentSummary[];
}

export type HqTranscriptRole = 'user' | 'assistant' | 'thinking' | 'tool' | 'system' | 'error';

/** One rendered conversation turn. Canonical shape shared by client streaming
 * and server-side JSONL replay so both planes agree. */
export interface HqTranscriptEntry {
  ts: string;
  role: HqTranscriptRole;
  text: string;
  tool?: string;
  /** Stringified tool input/arguments, for tool calls (shown alongside the result). */
  toolInput?: string;
  durationMs?: number;
  isError?: boolean;
  toolUseId?: string;
  /** Which agent/subagent produced this turn, when attribution is known. */
  agentId?: string;
}

/** Payload for `session.transcript` — an incremental batch of new turns. */
export interface HqTranscriptAppendPayload {
  sessionId: string;
  /** Monotonic sequence index of the FIRST entry in this batch within the session. */
  fromSeq: number;
  entries: readonly HqTranscriptEntry[];
}

/** Payload for `session.ended` — a terminal closed. */
export interface HqSessionEndedPayload {
  sessionId: string;
  endedAt: string;
}

export interface HqSessionSummary {
  sessionId: string;
  projectId: string;
  clientId: string;
  status: HqSessionStatus;
  provider?: string;
  model?: string;
  startedAt?: string;
  lastActivityAt: string;
  costUsd?: number;
}

export interface HqSnapshot {
  generatedAt: string;
  clients: readonly HqClientRecord[];
  projects: readonly HqProjectRecord[];
  sessions: readonly HqSessionSummary[];
  fleets: readonly HqFleetSummary[];
  mailboxes: readonly HqMailboxSummary[];
  /** Physical machines aggregated from connected clients (optional, additive). */
  machines?: readonly HqMachineRecord[];
  /** Live terminal sessions with their agents — the spine of the fleet tree. */
  liveSessions?: readonly HqSessionSnapshotPayload[];
  /** Latest operational health for each MCP server reported by any connected client. */
  mcpServers?: readonly HqMcpServerHealth[];
  totals: {
    activeProjects: number;
    activeClients: number;
    activeSessions: number;
    activeSubagents: number;
    unreadMailboxMessages: number;
    incompleteMailboxMessages: number;
    totalCostUsd: number;
    /** Distinct physical machines currently connected. */
    activeMachines?: number;
    /** Total live agents across all sessions. */
    activeAgents?: number;
    /**
     * Aggregate auth-token expiry stats, populated by the HQ server from
     * its in-memory auth state. Only counts are exposed — never token
     * strings. Absent on older snapshots (additive, default undefined).
     */
    tokenStats?: {
      browserTotal: number;
      clientTotal: number;
      /** Tokens whose expiresAt has already passed (filtered out of live auth). */
      expired: number;
      /** Tokens whose expiresAt is within the imminent window (default 24h). */
      expiringSoon: number;
    };
  };
}
