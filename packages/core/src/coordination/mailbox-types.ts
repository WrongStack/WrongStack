/**
 * Mailbox — persistent inter-agent messaging system with cross-session support.
 *
 * Agents can leave notes for specific agents or broadcast to all. Each agent
 * periodically checks the mailbox or retrieves messages via tool calls.
 *
 * ## Cross-session communication
 *
 * The mailbox is stored at **project level** (`~/.wrongstack/projects/<slug>/_mailbox.jsonl`),
 * so agents in different terminal sessions / WebUI tabs working on the same
 * project can communicate live.
 *
 * ## Agent registration
 *
 * Every agent that uses the mailbox registers itself with a heartbeat.
 * Other agents can discover online agents via `getOnlineAgents()`.
 * Stale agents (no heartbeat > 60s) are pruned automatically.
 *
 * ## Read receipts
 *
 * Each message tracks per-recipient read status via a `readBy` map:
 * `{ "agentId": "ISO8601" }`. When agent X reads a message, its entry
 * is added. The WebUI shows who read what and when.
 *
 * @module mailbox-types
 */

// ── Message type discriminator ───────────────────────────────────────────

export type MailboxMessageType =
  | 'note'       // informational message
  | 'ask'        // question / request for advice
  | 'assign'     // task assignment
  | 'steer'      // steering instruction (change behavior mid-task)
  | 'btw'        // "by the way" — non-urgent info
  | 'broadcast'  // sent to all agents
  | 'status'     // agent status update
  | 'result'     // task result / completion notice
  | 'review'     // review request (code/doc/PR) — passive ask, no reply required
  | 'control';   // out-of-band control signal (e.g. interrupt) — handled by
                 // the agent loop, NOT folded into the conversation as content

// ── Read receipt ─────────────────────────────────────────────────────────

/**
 * Per-recipient read status. `readBy` maps agentId → ISO8601 timestamp of
 * when that agent first read the message. An empty map means unread by all.
 */
export interface ReadReceipts {
  [agentId: string]: string; // ISO8601 timestamp
}

// ── Core message ─────────────────────────────────────────────────────────

export interface MailboxMessage {
  /** Unique message id (UUID). */
  id: string;
  /** Sender agent id. */
  from: string;
  /** Recipient agent id, or '*' for broadcast. */
  to: string;
  /** Message category. */
  type: MailboxMessageType;
  /** Short subject line — one sentence. */
  subject: string;
  /** Full message content. */
  body: string;
  /** Priority — high priority messages surface first. */
  priority: 'low' | 'normal' | 'high';
  /**
   * Per-recipient read receipts. agentId → ISO8601 when they first read it.
   * Replaces the old single `read: boolean` + `readAt` fields.
   */
  readBy: ReadReceipts;
  /** Has any recipient acted on / completed this? */
  completed: boolean;
  /** Who completed it (agentId). */
  completedBy?: string | undefined;
  /** Optional summary of what happened after handling. */
  outcome?: string | undefined;
  /** ISO8601 — when the message was sent. */
  timestamp: string;
  /** ISO8601 — when the message was marked complete. */
  completedAt?: string | undefined;
  /** If this is a reply, the id of the parent message. */
  replyTo?: string | undefined;
  /** For assign-type messages — task context for agent discovery. */
  taskContext?: MailboxTaskContext | undefined;
  /** Session id of the sender. Enables cross-session communication. */
  senderSessionId?: string | undefined;
}

// ── Task context for agent discovery ─────────────────────────────────────

export interface MailboxTaskContext {
  /** The role that should handle this task (e.g. "tech-stack", "audit-log"). */
  agentRole?: string | undefined;
  /** Human-readable agent name (e.g. "Tesla (Executor)"). */
  agentName?: string | undefined;
  /** Task id if already assigned via coordinator. */
  taskId?: string | undefined;
  /** Current task status. */
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | undefined;
}

// ── Agent registration ──────────────────────────────────────────────────

export interface RegisteredAgent {
  /** Unique agent id. */
  agentId: string;
  /** Session id this agent belongs to. */
  sessionId: string;
  /** Human-readable name. */
  name: string;
  /** Role (e.g. "leader", "tech-stack", "bug-hunter"). */
  role?: string | undefined;
  /** Current status. */
  status: 'idle' | 'running' | 'streaming' | 'waiting_user' | 'error';
  /** Current tool being executed, if any. */
  currentTool?: string | undefined;
  /** Current task description. */
  currentTask?: string | undefined;
  /** Iteration count so far. */
  iterations: number;
  /** Tool calls so far. */
  toolCalls: number;
  /** ISO8601 — registered at. */
  registeredAt: string;
  /** ISO8601 — last heartbeat (updated on every mailbox op). */
  lastSeenAt: string;
  /** Which process registered this agent (PID). */
  pid: number;
  /** Where the agent is running (e.g. "cli", "webui"). */
  source?: 'cli' | 'webui' | 'mcp' | 'acp' | 'http' | undefined;
}

// ── Agent status entry (for discovery) ───────────────────────────────────

export interface MailboxAgentStatus {
  /** Agent id. */
  agentId: string;
  /** Human-readable name. */
  name: string;
  /** Role. */
  role?: string | undefined;
  /** Session id. */
  sessionId: string;
  /** Current status. */
  status: 'idle' | 'running' | 'streaming' | 'waiting_user' | 'error' | 'offline';
  /** Current tool being executed, if any. */
  currentTool?: string | undefined;
  /** Current task description. */
  currentTask?: string | undefined;
  /** Iteration count so far. */
  iterations: number;
  /** Tool calls so far. */
  toolCalls: number;
  /** ISO8601 — last activity timestamp. */
  lastActivityAt: string;
  /** ISO8601 — last heartbeat. */
  lastSeenAt: string;
  /** Whether this agent is currently online (heartbeat within threshold). */
  online: boolean;
  /** Which process. */
  pid: number;
  /** Source. */
  source?: 'cli' | 'webui' | 'mcp' | 'acp' | 'http' | undefined;
}

// ── Mailbox query ────────────────────────────────────────────────────────

export interface MailboxQuery {
  /** Filter by recipient agent id. */
  to?: string | undefined;
  /** Filter by sender agent id. */
  from?: string | undefined;
  /** Only messages unread by this agent. */
  unreadBy?: string | undefined;
  /** Only incomplete messages. */
  incompleteOnly?: boolean | undefined;
  /** Filter by message type. */
  type?: MailboxMessageType | undefined;
  /** Filter by priority (>= this level). */
  minPriority?: 'low' | 'normal' | 'high' | undefined;
  /** Maximum number of messages to return. */
  limit?: number | undefined;
  /** ISO8601 — only messages after this timestamp. */
  since?: string | undefined;
}

// ── Mailbox operations ───────────────────────────────────────────────────

/**
 * Normalize a recipient address. `"all"` (any casing) is an accepted
 * spelling of the broadcast address and is canonicalized to `'*'` at send
 * time — both agents and humans reach for "all" naturally, and a literal
 * "all" recipient would otherwise be deliverable to nobody. The word is
 * therefore RESERVED: no agent may register under the base id "all".
 */
export function normalizeRecipient(to: string): string {
  return to.trim().toLowerCase() === 'all' ? '*' : to.trim();
}

export interface MailboxSendInput {
  /** Sender agent id. */
  from: string;
  /** Recipient agent id, '*' for broadcast (alias: "all"). */
  to: string;
  /** Message category. */
  type: MailboxMessageType;
  /** Short subject line. */
  subject: string;
  /** Full message content. */
  body: string;
  /** Priority. Default: 'normal'. */
  priority?: 'low' | 'normal' | 'high' | undefined;
  /** If replying, the id of the parent message. */
  replyTo?: string | undefined;
  /** Task context for assign-type messages. */
  taskContext?: MailboxTaskContext | undefined;
}

export interface MailboxAckInput {
  /** Message id to acknowledge. */
  messageId: string;
  /** Agent id of who is reading/acking. */
  readerId: string;
  /** Mark as read by this agent? Defaults to true if not specified. */
  read?: boolean | undefined;
  /** Mark as completed? */
  completed?: boolean | undefined;
  /** Optional outcome summary. */
  outcome?: string | undefined;
}

/**
 * Batch acknowledgment input — applies a batch of acks under a single file
 * lock + single file rewrite. Each entry has the same shape as
 * {@link MailboxAckInput} minus the per-batch defaults documented on
 * `ackMany`. Use this when an agent is acking several fresh messages at
 * once (the common case in the mailbox loop) — it collapses N full-file
 * rewrites into one.
 */
export interface MailboxAckBatchInput {
  /** Ack entries to apply. */
  acks: MailboxAckInput[];
}

// ── Agent registration input ────────────────────────────────────────────

export interface AgentRegistrationInput {
  agentId: string;
  sessionId: string;
  name: string;
  role?: string | undefined;
  pid: number;
  source?: 'cli' | 'webui' | 'mcp' | 'acp' | 'http' | undefined;
}

// ── Client (REPL/TUI/WebUI) registration ─────────────────────────────────

export type ClientSource = 'repl' | 'tui' | 'webui' | 'http';

export interface RegisteredClient {
  /** Unique client id. */
  clientId: string;
  /** Session/project context id. */
  sessionId: string;
  /** Human-readable name (e.g. "TUI [main]", "WebUI [chrome]"). */
  name: string;
  /** Client type. */
  source: ClientSource;
  /** ISO8601 — registered at. */
  registeredAt: string;
  /** ISO8601 — last heartbeat. */
  lastSeenAt: string;
  /** Which process. */
  pid: number;
}

export interface ClientStatus {
  /** Client id. */
  clientId: string;
  /** Human-readable name. */
  name: string;
  /** Client type. */
  source: ClientSource;
  /** Session id. */
  sessionId: string;
  /** ISO8601 — last activity timestamp. */
  lastSeenAt: string;
  /** Whether this client is currently online (heartbeat within threshold). */
  online: boolean;
  /** Which process. */
  pid: number;
}

export interface ClientRegistrationInput {
  clientId: string;
  sessionId: string;
  name: string;
  source: ClientSource;
  pid: number;
}

export interface ClientHeartbeatInput {
  clientId: string;
  /** Active session id for this client. When present, updates the registry entry. */
  sessionId?: string | undefined;
}

// ── Agent heartbeat input ────────────────────────────────────────────────

export interface AgentHeartbeatInput {
  agentId: string;
  status?: RegisteredAgent['status'] | undefined;
  currentTool?: string | undefined;
  currentTask?: string | undefined;
  iterations?: number | undefined;
  toolCalls?: number | undefined;
}

// ── Purge options & result ───────────────────────────────────────────────

export interface PurgeOptions {
  /**
   * Purge completed messages older than this many milliseconds.
   * Default: 1 day (86_400_000 ms)
   */
  completedMaxAgeMs?: number | undefined;
  /**
   * Purge incomplete messages older than this many milliseconds.
   * Default: 7 days (604_800_000 ms)
   */
  incompleteMaxAgeMs?: number | undefined;
}

export interface PurgeResult {
  /** Messages removed because they were completed and too old. */
  completedPurged: number;
  /** Messages removed because they were incomplete and too old. */
  incompletePurged: number;
  /** Total messages removed. */
  totalPurged: number;
  /** Messages remaining in the mailbox after purge. */
  remaining: number;
}

// ── Mailbox interface ────────────────────────────────────────────────────

export interface Mailbox {
  /** Send a message. Returns the created message. */
  send(input: MailboxSendInput): Promise<MailboxMessage>;

  /** Query messages matching criteria. */
  query(query: MailboxQuery): Promise<MailboxMessage[]>;

  /** Acknowledge a message (read/complete). Returns updated message. */
  ack(input: MailboxAckInput): Promise<MailboxMessage | null>;

  /**
   * Acknowledge many messages in one shot. Acquires the file lock once and
   * rewrites the message file once, regardless of how many acks are in the
   * batch. Returns the messages that were actually updated (messages whose
   * ids are not in the file are skipped silently).
   *
   * This is the preferred path when an agent has multiple fresh messages
   * to receipt at once — the per-message {@link ack} path does a full
   * read-modify-rewrite of the mailbox file for every call.
   */
  ackMany(input: MailboxAckBatchInput): Promise<MailboxMessage[]>;

  /** Get a snapshot of online/offline agents and their current tasks. */
  getAgentStatuses(): Promise<MailboxAgentStatus[]>;

  /**
   * Get only online agents (heartbeat within 60s).
   * Useful for "who can I talk to right now?" queries.
   */
  getOnlineAgents(): Promise<MailboxAgentStatus[]>;

  /**
   * Register an agent. Called once per agent on first mailbox use.
   * Subsequent calls are idempotent — they update lastSeenAt.
   */
  registerAgent(input: AgentRegistrationInput): Promise<void>;

  /**
   * Update agent heartbeat and optional status fields.
   * Called periodically (every tool call / iteration).
   */
  heartbeat(input: AgentHeartbeatInput): Promise<void>;

  /**
   * Count unread messages for a specific agent.
   * Used for "new mail" notifications without pulling full message bodies.
   */
  unreadCount(forAgentId: string): Promise<number>;

  /** Close and flush any pending writes. */
  close(): Promise<void>;

  /**
   * Delete all messages from the mailbox file.
   * Agents and read receipts are preserved; only messages are cleared.
   */
  clearAll(): Promise<void>;

  /**
   * Purge orphaned and stale messages from the mailbox.
   *
   * Stale messages are:
   *  - Completed messages older than `completedMaxAgeMs` (default: 1 day)
   *  - Incomplete messages older than `incompleteMaxAgeMs` (default: 7 days)
   *
   * This does NOT touch agent registrations or client registry.
   */
  purgeStale(opts?: PurgeOptions): Promise<PurgeResult>;

  // ── Client (REPL/TUI/WebUI) registry ──────────────────────────────────

  /**
   * Register a client (REPL/TUI/WebUI). Called once per client on startup.
   * Subsequent calls are idempotent — they update lastSeenAt.
   */
  registerClient(input: ClientRegistrationInput): Promise<void>;

  /**
   * Update client heartbeat. Called periodically (every 15s for clients).
   */
  clientHeartbeat(input: ClientHeartbeatInput): Promise<void>;

  /**
   * Get snapshot of online/offline clients and their last activity.
   */
  getClientStatuses(): Promise<ClientStatus[]>;
}
