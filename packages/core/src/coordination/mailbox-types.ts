/**
 * Mailbox — persistent inter-agent messaging system with cross-session support.
 *
 * Agents can leave notes for specific agents or broadcast to all. Each agent
 * periodically checks the mailbox or retrieves messages via tool calls.
 *
 * ## Cross-session communication
 *
 * The mailbox is stored at **project level** (`~/.wrongstack/projects/<slug>/_mailbox.sqlite`, owned by one detached
 * project server and reached over IPC),
 * so agents in different terminal sessions / WebUI tabs working on the same
 * canonical project can communicate live, even when they run in different
 * processes, clients, branches, or linked Git worktrees.
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

import { MAILBOX_TYPE_PROPERTIES, type MailboxMessageType } from './mailbox-type-properties.js';

export {
  MAILBOX_TYPE_PROPERTIES,
  type MailboxMessageType,
  type MailboxTypeCategory,
} from './mailbox-type-properties.js';

// ── Message type discriminator ───────────────────────────────────────────

/**
 * The ten mail types each carry a distinct **semantic category**, a **sender
 * contract** (when the sender must use it), and a **recipient contract** (how
 * the runtime dispatches it and what the recipient agent must do).
 *
 * ───── Type semantics — decision matrix for senders ──────────────────────
 *
 * ## Categories
 *
 * | Category     | Types                                 | Purpose                        |
 * |--------------|---------------------------------------|--------------------------------|
 * | Actionable   | `ask`, `assign`, `steer`, `review`    | Require a substantive response |
 * | Informational| `note`, `btw`, `result`, `status`     | Consume for context, no action |
 * | Routing      | `broadcast`                           | Multi-recipient envelope       |
 * | Control      | `control`                             | Out-of-band signal (no render) |
 *
 * ## Per-type contract
 *
 * ### Actionable types
 *
 * | Type     | When to send                                        | Recipient must                                     |
 * |----------|-----------------------------------------------------|----------------------------------------------------|
 * | `ask`    | Blocking question — you need an answer to proceed   | Answer as soon as possible; the sender is waiting. |
 * | `assign` | Delegating a task                                   | Accept or decline; act on it when current op allows. |
 * | `steer`  | Mid-task direction change — the recipient is        | Pause current approach, adjust per instruction,    |
 * |          | already working on something and you need them      | then resume. Rendered first in the mailbox block.  |
 * |          | to change course NOW                                |                                                    |
 * | `review` | Requesting a code/doc/PR review (passive)           | Inspect when convenient; no immediate reply needed.|
 *
 * ### Informational types
 *
 * | Type     | When to send                                        | Recipient must                                     |
 * |----------|-----------------------------------------------------|----------------------------------------------------|
 * | `note`   | General-purpose FYI — a message that isn't any      | Read for context; no reply needed. The untyped     |
 * |          | of the more specific types                          | default for directed messages.                     |
 * | `btw`    | Low-priority aside — "by the way"                   | Absorb the information and stay on current task;   |
 * |          |                                                     | no reply needed. Injected via BTW block (separate  |
 * |          |                                                     | from the main mailbox fold) to minimise disruption.|
 * | `result` | Subagent/task completion notice — share the         | Factor into next decision; treat as evidence, not  |
 * |          | outcome of finished work                            | a new task.                                        |
 * | `status` | Agent or system status update (heartbeat, spawn,    | Use to avoid redundant work; never act on it as   |
 * |          | task progress, error). Machine-generated.           | a task or question.                                |
 * | `broadcast` | Multi-recipient envelope — the same message for   | Read if addressed to you (direct, alias, session,  |
 * |          | every agent on the project. Auto-selected when      | or `*`). The `*` recipient means "everyone".       |
 * |          | `to` is `"*"` or `"@session"` in `mail_send`.      |                                                    |
 *
 * ### Control type
 *
 * | Type     | When to send                                        | Recipient must                                     |
 * |----------|-----------------------------------------------------|----------------------------------------------------|
 * | `control`| Out-of-band signal (interrupt, halt, redirect).     | NEVER folded into conversation content. The agent  |
 * |          | Machine-generated by the runtime, not by agents.    | loop intercepts it separately. `control:interrupt` |
 * |          |                                                     | causes a cooperative halt at the next iteration    |
 * |          |                                                     | boundary.                                          |
 *
 * ───── Dispatch behavior (runtime contract) ──────────────────────────────
 *
 * The mailbox system enforces these dispatch rules:
 *
 * 1. **Send-side**: `mail_send` auto-defaults the type: `broadcast` when
 *    `to` is `"*"` or `"@session:..."`, otherwise `note`.
 * 2. **Send-side validation**: `assign` always requires a specific `to`
 *    (not `"*"`). `control` is reserved for runtime use — agents passing it
 *    via the tool surface will be rejected.
 * 3. **Render-order guarantee**: `steer` messages are ALWAYS rendered first
 *    in `buildMailboxBlock()`, before any other type, to ensure mid-task
 *    direction changes are seen before other action items.
 * 4. **Control isolation**: `control`-type messages are filtered by
 *    `injectPendingMailboxMessages()` and NEVER enter the folded
 *    conversation block — they are out-of-band signals only.
 * 5. **Background routing**: in `background` delivery mode, only the
 *    actionable message types (`steer`, `ask`, `assign`, `result`,
 *    `review`) are escalated; `note`, `btw`, `status`, and `broadcast`
 *    are suppressed to minimise disruption during tool work.
 * 6. **Awareness polling**: `btw` messages intercepted by background
 *    polling are queued via `setBtwNote()` for injection at a safe loop
 *    boundary, not folded inline.
 * 7. **Agent registry**: `getAgentStatuses()` reads the dedicated `agents`
 *    table, not mailbox message content. That table is populated by
 *    `registerAgent` / `heartbeat` — never by `status`-type messages, which
 *    are ordinary mail and carry no presence meaning. There is no fallback
 *    that derives presence from message content: the registry is either the
 *    owner's table or nothing. (It was `_mailbox.registry.json` before the
 *    SQLite cutover; both that file and the derive-from-messages fallback are
 *    gone.)
 * 8. **Request-scoped context**: delivered raw mailbox blocks are removed
 *    after one successful provider evaluation. Durable assistant/tool/task
 *    consequences remain; routine mail does not occupy later requests.
 *
 * When a type is missing from any dispatch table, the fallback is:
 * - Render with `📨 <TYPE>` label (generic emoji prefix)
 * - Route inline (not background)
 * - No special instruction added
 */

/**
 * Which class of agent may consume a mailbox message.
 *
 * `leaders` is a delivery boundary, not merely a UI hint: agent-loop and
 * inbox readers must exclude these messages for subagents. The optional
 * persisted field keeps older JSONL records backwards-compatible (`all`).
 */
export type MailboxAudience = 'all' | 'leaders';

/** Return the stable base portion of a session-qualified mailbox identity. */
export function mailboxIdentityBase(agentId: string): string {
  return agentId.split(/[@#]/, 1)[0]!.trim().toLowerCase();
}

/** Whether a mailbox identity belongs to the session's main/leader agent. */
export function isMailboxLeader(agentId: string, role?: string): boolean {
  return mailboxIdentityBase(agentId) === 'leader' || role?.trim().toLowerCase() === 'leader';
}

/**
 * Whether a sender identity belongs to a named agent family.
 *
 * Matches the family id exactly, or as the `<family>-<suffix>` prefix that a
 * spawned worker carries. Both forms occur in practice for the same logical
 * sender: a pipeline agent may post under its plain id (`dep-watcher`, which
 * `makeDependencyWatcherConfig` sends as), or a subagent may post under the
 * name it was spawned with — `host-subagent-factory` sets `ctx.agentId` from
 * the spawn name, so the tech-stack worker spawned as
 * `tech-stack-package.json` writes mail from `tech-stack-package.json@<tag>`.
 * A consumer gating on the plain family id with `===` would silently reject
 * its own pipeline.
 *
 * Same shape as the existing `chimera` / `chimera-*` check in
 * `applyMailboxSendPolicy` and `host-subagent-factory`.
 *
 * Session/process qualifiers are stripped first, so `<family>@<tag>` and
 * `<family>#<pid>` match too.
 */
export function isMailboxSenderInFamily(senderId: string, family: string): boolean {
  const base = mailboxIdentityBase(senderId);
  const normalizedFamily = family.trim().toLowerCase();
  if (normalizedFamily.length === 0) return false;
  return base === normalizedFamily || base.startsWith(`${normalizedFamily}-`);
}

/** Whether a message may be consumed by the supplied agent identity. */
export function isMailboxMessageVisibleTo(
  message: Pick<MailboxMessage, 'audience'>,
  agentId: string,
  role?: string,
): boolean {
  return message.audience !== 'leaders' || isMailboxLeader(agentId, role);
}

/**
 * True when the message carries any session-affinity token at all.
 *
 * Uses `!== undefined` (NOT `!= null`) because the SQLite read path
 * (`sqlite-mailbox-rows.ts`) does an unvalidated `JSON.parse(row.data)
 * as MailboxMessage` cast, which can surface a malformed persisted row
 * carrying `sessionAffinity: null`. Treating `null` as "absent" (accept)
 * would let malformed affinity-bearing messages bypass the filter.
 * Instead, `null` falls through to the token-bearing code path where
 * the shape guard (in each caller) catches non-object values and
 * fails closed.
 *
 * Callers that access `message.sessionAffinity!` after this check
 * must guard against non-object shapes (null, arrays, primitives).
 */
function isAffectedBySessionAffinity(message: Pick<MailboxMessage, 'sessionAffinity'>): boolean {
  return message.sessionAffinity !== undefined;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function maybeSyncResolveChimeraReportSessionId(
  result: string | undefined | PromiseLike<string | undefined>,
): string | undefined {
  if (!isPromiseLike(result)) return result;
  try {
    result.then(undefined, () => undefined);
  } catch {
    // Malformed thenables must not propagate out of the sync mailbox filter.
  }
  return undefined;
}

/**
 * Shape of the optional secondary lookup the leader filter performs when a
 * message arrives without an affinity token (legacy sender / older build).
 *
 * `resolveChimeraReportSessionId(reportId)` returns the persisted
 * `ReviewReport.sessionId` for that report id, or `undefined` when the
 * report is unknown. May be sync or async — the filter awaits the result.
 */
export interface MailboxSessionAffinityContext {
  /**
   * Look up the originating session id of a chimera report by its report id.
   * Return `undefined` for unknown reports. Sync or async.
   */
  resolveChimeraReportSessionId?:
    | ((reportId: string) => string | undefined | Promise<string | undefined>)
    | undefined;
  /**
   * Legacy / one-shot opt-in. The flag has TWO consultation points inside
   * {@link acceptMailboxMessageForSession}:
   *
   *   1. When the recipient does not pass a `currentSessionId` (rule 2),
   *      a token-bearing message is accepted iff this is `true`.
   *   2. When a token-bearing message lacks a resolvable `sessionId` AND
   *      the persisted-report resolver returns no match (rule 5), the
   *      message is accepted iff this is `true`.
   *
   * Token-LESS messages are NOT gated by this flag — they are accepted
   * unconditionally by rule 1 as the discriminator for legitimate
   * subagent `result` / `review` traffic that does not stamp an affinity
   * token (task-auctioneer, cascade handlers, legacy senders).
   *
   * This flag does NOT override an explicit mismatch: a message that
   * carries `sessionAffinity.sessionId !== currentSessionId` is dropped
   * regardless of this flag, because the sender explicitly claimed a
   * different session — honoring it would re-open the leak.
   *
   * Default `false`.
   */
  allowUnscoped?: boolean | undefined;
}

/**
 * Decide whether a mailbox message belongs to the recipient's current session
 * and should therefore be delivered to the leader's inbox.
 *
 * The actual code path is:
 *
 * 1. {@link isAffectedBySessionAffinity} check. If the message has no
 *    affinity token, the filter does NOT apply and the message is accepted.
 *    This is the **discriminator** that protects legitimate subagent
 *    `result` / `review` traffic (task-auctioneer, cascade handlers) from
 *    collateral drops — they do not stamp an affinity token, so they fall
 *    through here. When a token is present, every token is enforced regardless
 *    of its optional `kind`; malformed or unrecognized kinds must not bypass
 *    a mismatched `sessionAffinity.sessionId`.
 * 2. No-session-id branch. If the recipient did not pass a `currentSessionId`,
 *    accept only when `ctx.allowUnscoped === true`. Default: **fail-closed**
 *    (drop) — the safe behavior, not a silent fail-open.
 * 3. Explicit `sessionAffinity.sessionId` match. If the sender stamped a
 *    session id and it does not match the recipient's current session id,
 *    drop immediately. The sender claimed a different session; honoring it
 *    would re-open the cross-session leak. This drop happens even when
 *    `allowUnscoped` is set — a wrong session is misconfiguration, not a
 *    legacy case.
 * 4. Persisted-report fallback. If the token lacks a `sessionId` but carries
 *    a `reportId`, await `ctx.resolveChimeraReportSessionId(reportId)` and
 *    accept if the persisted `ReviewReport.sessionId` matches. Accepts
 *    sync or async resolvers.
 * 5. `allowUnscoped` opt-in. If the previous steps did not accept and
 *    `ctx.allowUnscoped === true`, accept (legacy / one-shot tool
 *    compatibility).
 * 6. Otherwise drop (`false`).
 *
 * PR #314 guard contract: presence checks intentionally use strict
 * `!== undefined` comparisons for both the affinity token and its optional
 * fields. Do not simplify them to nullish checks: malformed persisted `null`
 * values must remain on the token-bearing path and fail closed in the shape
 * guard rather than being treated as absent.
 *
 * Trust note: the filter accepts the sender-asserted `sessionAffinity.sessionId`
 * without store cross-check (rule 3). The persisted-report fallback (rule 4)
 * is the only server-side check. A sender that fabricates both an affinity
 * token and a persisted report could impersonate another session — guard
 * chimera's send path so only the actual originating session can stamp the
 * token, and do not relax rule 3.
 *
 * The helper is side-effect-free except for awaiting the optional resolver.
 * It lives next to {@link isMailboxMessageVisibleTo} so mailbox consumers
 * can compose both filters without taking a dependency on the persistence
 * layer.
 */
export async function acceptMailboxMessageForSession(
  message: Pick<MailboxMessage, 'type' | 'sessionAffinity'>,
  currentSessionId: string | undefined,
  ctx?: MailboxSessionAffinityContext,
): Promise<boolean> {
  if (!isAffectedBySessionAffinity(message)) return true;
  // After the affected-by check passes, an affinity token is guaranteed
  // present. Narrow the type for the rest of the rule.
  const affinity = message.sessionAffinity!;
  // Guard against malformed persisted shapes (null, array, primitive)
  // that bypass the codec on the SQLite read path. Always fail closed
  // — even if allowUnscoped is true, a malformed token is evidence of
  // data corruption, not a legacy unscoped message.
  if (affinity === null || typeof affinity !== 'object' || Array.isArray(affinity)) {
    return false;
  }
  // Also fail closed on wrong-typed fields. The `parseSessionAffinity`
  // codec in `mailbox-message-codec.ts` rejects e.g. `{ sessionId: 42 }`
  // and `{ reportId: 42 }` at the shape-validation layer — but the
  // SQLite read path (`sqlite-mailbox-rows.ts:178`) does an unvalidated
  // `JSON.parse(row.data) as MailboxMessage` cast, so a malformed
  // persisted token can reach the filter directly. Without this guard,
  // a `{ sessionId: 42 }` token would skip both the explicit-mismatch
  // branch and the persisted-report fallback, and fall through to the
  // `allowUnscoped === true` accept path — re-opening the exact
  // cross-session leak the filter exists to close.
  if (
    (affinity.sessionId !== undefined && typeof affinity.sessionId !== 'string') ||
    (affinity.reportId !== undefined && typeof affinity.reportId !== 'string')
  ) {
    return false;
  }
  if (!currentSessionId) {
    // No session id known — fall back to the legacy opt-in flag rather than
    // a silent fail-open, so the safe behavior is the default.
    return ctx?.allowUnscoped === true;
  }
  // An explicit mismatching sessionId ALWAYS drops — even if `allowUnscoped`
  // is true. A sender that stamps the wrong session is misconfigured, not
  // a legacy case.
  if (typeof affinity.sessionId === 'string' && affinity.sessionId.length > 0) {
    if (affinity.sessionId !== currentSessionId) return false;
    return true;
  }
  // Token present (per step 1) but no explicit sessionId — fall back to the
  // persisted review-report store.
  //
  // The resolver may be async and may reject (e.g. the JSONL store may be
  // mid-compaction, locked, or the report id may belong to a different
  // project). Rejection MUST NOT propagate out of the inbox poll — that
  // would abort every leader iteration.
  //
  // If the resolver returns a non-matching sessionId, that is a
  // NON-OVERRIDABLE mismatch — the report belongs to a different session.
  // allowUnscoped must NOT override it (same contract as explicit
  // affinity.sessionId mismatch above).
  //
  // If the resolver returns undefined (unknown report) or throws, the
  // identity is genuinely unresolved. allowUnscoped MAY override that
  // (legacy compatibility) because no mismatch was established.
  if (affinity.reportId && ctx?.resolveChimeraReportSessionId) {
    try {
      const resolved = await ctx.resolveChimeraReportSessionId(affinity.reportId);
      if (resolved === currentSessionId) return true;
      if (resolved !== undefined) return false; // resolved-mismatch: non-overridable
    } catch {
      // Resolver failure: fall through to allowUnscoped (genuinely unresolved).
    }
  }
  if (ctx?.allowUnscoped === true) return true;
  return false;
}

/**
 * Synchronous wrapper for callers that cannot await the resolver
 * (e.g. legacy event handlers). If `ctx.resolveChimeraReportSessionId` is
 * async, it is called without awaiting and the result is ignored — the
 * rule degrades to "match affinity.sessionId, otherwise drop unless
 * allowUnscoped".
 *
 * Prefer {@link acceptMailboxMessageForSession} whenever the caller can
 * await.
 */
export function acceptMailboxMessageForSessionSync(
  message: Pick<MailboxMessage, 'type' | 'sessionAffinity'>,
  currentSessionId: string | undefined,
  ctx?: MailboxSessionAffinityContext,
): boolean {
  if (!isAffectedBySessionAffinity(message)) return true;
  const affinity = message.sessionAffinity!;
  // Guard against malformed persisted shapes (null, array, primitive).
  // Always fail closed — see async helper for rationale.
  if (affinity === null || typeof affinity !== 'object' || Array.isArray(affinity)) {
    return false;
  }
  if (!currentSessionId) {
    return ctx?.allowUnscoped === true;
  }
  if (typeof affinity.sessionId === 'string' && affinity.sessionId.length > 0) {
    if (affinity.sessionId !== currentSessionId) return false;
    return true;
  }
  // Best-effort sync lookup: invoke without awaiting. If the resolver
  // returns a Promise (async resolver), it cannot be awaited in a sync
  // call site — but the rejection MUST be contained so an unhandled
  // rejection does not crash the inbox poll. We attach a rejection handler
  // and treat the result as `undefined` (the sync helper cannot use it).
  // The async helper covers the full contract for callers that can await.
  if (affinity.reportId && ctx?.resolveChimeraReportSessionId) {
    try {
      const rawResult = ctx.resolveChimeraReportSessionId(affinity.reportId) as
        | string
        | undefined
        | Promise<string | undefined>;
      const syncResult = maybeSyncResolveChimeraReportSessionId(rawResult);
      if (syncResult === currentSessionId) return true;
      if (syncResult !== undefined) return false; // resolved-mismatch: non-overridable
    } catch {
      // Synchronous resolver failures treated as unresolved — fall through to allowUnscoped.
    }
  }
  if (ctx?.allowUnscoped === true) return true;
  return false;
}

/** Category + expectsReply are provided by MAILBOX_TYPE_PROPERTIES directly. */

/**
 * Validate that a given (type, to) pair is internally consistent.
 * Throws when the combination breaks a fundamental rule.
 */
export function validateSendType(type: MailboxMessageType, to: string): void {
  if (type === 'control') {
    throw new TypeError('Type "control" is reserved for runtime use and cannot be set by agents');
  }
  const isMultiRecipient = to === '*' || to.startsWith('@session:');
  if (type === 'assign' && isMultiRecipient) {
    throw new TypeError(
      `Type "assign" requires a specific recipient — multi-recipient target "${to}" is ambiguous`,
    );
  }
  if (type === 'steer' && isMultiRecipient) {
    throw new TypeError(
      `Type "steer" requires a specific recipient — multi-recipient target "${to}" is ambiguous`,
    );
  }
}

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
  /** Delivery audience. Omitted legacy values mean `all`. */
  audience?: MailboxAudience | undefined;
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
  /**
   * ISO8601 — when the message was soft-deleted. When present, the
   * default `Mailbox.query()` filter excludes the message from the
   * normal inbox view; {@link Mailbox.restore} clears the
   * field to undo the delete. Hard deletes (removing the line from
   * the JSONL) are reserved for the CLI and never happen via the
   * server route handlers.
   */
  deletedAt?: string | undefined;
  /** When the soft-delete happened, the agentId that issued it. */
  deletedBy?: string | undefined;
  /** If this is a reply, the id of the parent message. */
  replyTo?: string | undefined;
  /** For assign-type messages — task context for agent discovery. */
  taskContext?: MailboxTaskContext | undefined;
  /** Session id of the sender. Enables cross-session communication. */
  senderSessionId?: string | undefined;
  /**
   * Session-affinity token persisted on the message. When set, the
   * recipient's leader filter uses it to drop the message if the
   * recipient's current session id does not match. See
   * {@link MailboxSessionAffinity} for the contract.
   */
  sessionAffinity?: MailboxSessionAffinity | undefined;
  /**
   * ISO8601 — when the message expires. Set at send time from `ttlMs`
   * (default: 24h via AUTO_COMPACT_DEFAULT_TTL_MS). The auto-compaction
   * sweep removes messages whose `expiresAt` is in the past. When
   * undefined, the compaction sweep uses the default TTL from the
   * caller's options.
   */
  expiresAt?: string | undefined;
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
  /**
   * Restrict the result to these message ids.
   *
   * Exists so a caller that already knows which messages it cares about can
   * ask about exactly those instead of pulling a set and scanning it. The
   * HTTP bridge's per-actor visibility checks did the latter — answering
   * "is this one message mine?" by materializing every message addressed to
   * the actor, which on a busy project meant a full table read (plus the
   * whole receipt table, plus a retention projection per row) for every
   * single `ack`.
   *
   * An empty array matches nothing. Untrusted request codecs deliberately do
   * NOT accept this field — `validateQuery` whitelists, so it stays a
   * server-side narrowing rather than something a caller can widen.
   */
  ids?: readonly string[] | undefined;
  /** Filter by recipient agent id. */
  to?: string | undefined;
  /** Filter by sender agent id. */
  from?: string | undefined;
  /** Only messages unread by this agent. */
  unreadBy?: string | undefined;
  /** Trusted caller role used with `unreadBy` for audience filtering. */
  readerRole?: string | undefined;
  /** Only incomplete messages. */
  incompleteOnly?: boolean | undefined;
  /**
   * Internal trusted-read option: retain folded per-actor receipt state so a
   * boundary can derive an actor-safe projection. Untrusted query codecs must
   * never accept this field from request payloads.
   */
  includeReceiptState?: boolean | undefined;
  /** Filter by message type. */
  type?: MailboxMessageType | undefined;
  /** Filter by priority (>= this level). */
  minPriority?: 'low' | 'normal' | 'high' | undefined;
  /** Maximum number of messages to return. */
  limit?: number | undefined;
  /** ISO8601 — only messages after this timestamp. */
  since?: string | undefined;
  /** Filter by the sender's session id (`MailboxMessage.senderSessionId`). */
  sessionId?: string | undefined;
  /**
   * Include soft-deleted messages (where `deletedAt` is set). When
   * `false` (the default), soft-deleted messages are filtered out so
   * the normal inbox view stays clean. The "trash" view passes
   * `true` to surface them.
   */
  includeDeleted?: boolean | undefined;
  /**
   * Filter by replyTo parent message id (UUID). When set, only messages
   * whose `replyTo` exactly matches this value are returned. An empty
   * string matches nothing — empty strings are technically allowed by
   * `send()` (it passes through `MailboxSendInput.replyTo` directly with
   * no normalization), but are never produced by chimera/execution callers.
   * The query filter is exact-match.
   * Useful for polling the response to a specific `ask` message.
   */
  replyTo?: string | undefined;
}

// ── Mailbox operations ───────────────────────────────────────────────────

/** Canonical prefix for mail addressed to every agent in one session. */
export const SESSION_RECIPIENT_PREFIX = '@session:';

/** Build the canonical recipient address for a session-scoped broadcast. */
export function sessionRecipient(sessionId: string): string {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new TypeError('sessionId is required for the "@session" recipient');
  }
  return `${SESSION_RECIPIENT_PREFIX}${normalizedSessionId}`;
}

/**
 * Normalize a recipient address.
 *
 * - `"all"` (any casing) is canonicalized to `'*'`.
 * - `"@session"` (any casing) is canonicalized to
 *   `"@session:<sessionId>"`; callers must provide the sender's session id.
 * - Already-canonical `"@session:<sessionId>"` addresses are preserved.
 */
export function normalizeRecipient(to: string, sessionId?: string): string {
  const trimmed = to.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === 'all') return '*';
  if (normalized === '@session') return sessionRecipient(sessionId ?? '');
  return trimmed;
}

export interface MailboxSendInput {
  /** Sender agent id. */
  from: string;
  /** Recipient agent id, '*' / "all" for project broadcast, or "@session" for the sender's session. */
  to: string;
  /** Message category. */
  type: MailboxMessageType;
  /** Restrict consumption to main/leader agents. Default: `all`. */
  audience?: MailboxAudience | undefined;
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
  /** Sender session id. Required when `to` is the `"@session"` alias. */
  senderSessionId?: string | undefined;
  /**
   * Session-affinity token. When set, the recipient's mailbox filter uses it
   * to drop the message if the recipient's current session id does not match.
   *
   * Why two fields instead of one: a chimera report is generated by a reviewer
   * subagent that runs inside the originating session (so `senderSessionId`
   * is correct), but a mailbox envelope may also be relayed by an outer
   * pipeline (auto-review cascade, broadcast wrapper) where the recipient
   * needs to know which session the report *belongs to*, not who *physically
   * called send()*. `sessionId` carries the originating session;
   * `reportId` carries the chimera report id so the leader's filter
   * can also look the report up in the persisted review-report store.
   *
   * A session-affinity token is **required** for any `chimera.*` review
   * delivery wrapper — this is the trust boundary that prevents a leader
   * from acting on reports emitted by another session, even when those
   * reports land in its mailbox.
   */
  sessionAffinity?: MailboxSessionAffinity | undefined;
  /**
   * Time-to-live in milliseconds. When set, the message's `expiresAt` is
   * computed as `now + ttlMs` at send time. The auto-compaction sweep
   * removes expired messages. Default: none (use compaction sweep default).
   */
  ttlMs?: number | undefined;
}

/**
 * Session-affinity token carried on a mailbox message.
 *
 * The token is the *only* signal a recipient's leader filter uses to decide
 * whether a chimera report belongs to the recipient's own session. Without
 * it, any leader that polls the project-wide mailbox would see — and feel
 * compelled to act on — chimera reports emitted by every other session in
 * the project.
 */
export type MailboxSessionAffinity =
  | MailboxScopedSessionAffinity
  | MailboxLegacyReportSessionAffinity;

export interface MailboxScopedSessionAffinity {
  /**
   * The originating session id. The recipient's leader filter compares this
   * against its own current session id and drops the message on mismatch.
   */
  sessionId: string;
  /**
   * Originating chimera report id (UUID). Used as a secondary lookup only
   * when the message is a legacy report token without `sessionId`.
   */
  reportId?: string | undefined;
  /** Free-form tag for filtering / metrics, e.g. `'chimera.review'`. */
  kind?: string | undefined;
}

export interface MailboxLegacyReportSessionAffinity {
  /**
   * Legacy report-only tokens deliberately omit `sessionId`; any present
   * session id is authoritative and must be checked before report lookup.
   */
  sessionId?: undefined;
  /** Originating chimera report id (UUID) used for persisted-session lookup. */
  reportId: string;
  /** Free-form tag for filtering / metrics, e.g. `'chimera.review'`. */
  kind?: string | undefined;
}

/**
 * Append-only ack record stored in the JSONL alongside messages.
 *
 * Instead of rewriting the entire mailbox file to mark a message as read or
 * completed, we append a small ack record. At read time, ack records are
 * folded into their target messages. The `__ack` discriminator distinguishes
 * ack records from regular messages.
 *
 * Compaction (autoCompact / purgeStale) folds these into the messages and
 * removes the ack lines from the file, keeping the file bounded.
 */
export interface AckRecord {
  /** Discriminator — always `true` to distinguish from MailboxMessage. */
  __ack: true;
  /** The message this ack applies to. */
  messageId: string;
  /** Agent acknowledging the message. */
  readerId: string;
  /** ISO8601 timestamp of the ack. */
  timestamp: string;
  /** Was the message read? */
  read: boolean;
  /** Was the message marked completed? */
  completed?: boolean | undefined;
  /** Who completed it (when completed === true). */
  completedBy?: string | undefined;
  /** Optional outcome summary. */
  outcome?: string | undefined;
  /**
   * Soft-delete or restore the target message.
   * - `true`: set `deletedAt`/`deletedBy` on the message
   * - `false`: clear `deletedAt`/`deletedBy` on the message
   * - `undefined`: not a delete/restore operation (backward-compat default)
   *
   * When `deleted` is `true`, `deletedBy` records who performed the delete.
   */
  deleted?: boolean | undefined;
  /** Who deleted the message (set when `deleted === true`). */
  deletedBy?: string | undefined;
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
  pid?: number | undefined;
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
  pid?: number | undefined;
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

// ── Auto-compact options & result ─────────────────────────────────────────

export interface AutoCompactOptions {
  /**
   * Remove messages read by ALL currently-online agents that are older
   * than this many milliseconds since the last read receipt was stamped.
   * Default: 10 minutes (AUTO_COMPACT_READ_MAX_AGE_MS).
   */
  readMaxAgeMs?: number | undefined;
  /**
   * Default TTL for messages without an explicit `expiresAt`. Messages
   * whose `timestamp` is older than `now - defaultTtlMs` are removed.
   * Default: 24 hours (AUTO_COMPACT_DEFAULT_TTL_MS).
   */
  defaultTtlMs?: number | undefined;
  /**
   * Per-message-type TTL overrides, consulted before `defaultTtlMs` for
   * messages with no explicit `expiresAt`. Keyed by `MailboxMessageType`.
   * Default: {@link AUTO_COMPACT_TYPE_TTL_MS} (transient `status` chatter
   * expires in 30 minutes instead of 24 hours).
   */
  typeTtlMs?: Readonly<Record<string, number>> | undefined;
  /**
   * Also run `purgeStale` logic in the same pass — purge completed
   * messages older than this many ms. Default: 1 day.
   */
  completedMaxAgeMs?: number | undefined;
  /**
   * Also run `purgeStale` logic in the same pass — purge incomplete
   * messages older than this many ms. Default: 7 days.
   */
  incompleteMaxAgeMs?: number | undefined;
  /**
   * Interval for the background auto-compact timer.
   * Default: 5 minutes (AUTO_COMPACT_INTERVAL_MS).
   */
  intervalMs?: number | undefined;
  /**
   * Also run `purgeStale` logic in the same pass (completed > 1 day,
   * incomplete > 7 days). Default: true.
   */
  includePurgeStale?: boolean | undefined;
}

export interface AutoCompactResult {
  /** Messages removed because they were read by all online agents. */
  readByAllRemoved: number;
  /** Messages removed because their TTL expired (explicit or default). */
  expiredRemoved: number;
  /** Messages removed by the purgeStale pass (if enabled). */
  stalePurged: number;
  /** Total messages removed. */
  totalRemoved: number;
  /** Messages remaining in the mailbox after compaction. */
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

  /**
   * Soft-delete a message. Sets `deletedAt` to the current timestamp
   * and records the acting agent in `deletedBy`. Reversible via
   * {@link restore}. The default `query()` filter hides the message
   * once `deletedAt` is set; pass `includeDeleted: true` to see the
   * trash.
   */
  softDelete(mailId: string, by: string): Promise<MailboxMessage | null>;

  /**
   * Undo a {@link softDelete}. Clears `deletedAt` and `deletedBy` on
   * the message. No-op (returns the message as-is) if the message is
   * not soft-deleted.
   */
  restore(mailId: string): Promise<MailboxMessage | null>;

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
  /** Remove an agent from the registry entirely. Called on session shutdown. */
  deregisterAgent(agentId: string): Promise<void>;

  /**
   * Update agent heartbeat and optional status fields.
   * Called periodically (every tool call / iteration).
   */
  heartbeat(input: AgentHeartbeatInput): Promise<void>;

  /**
   * Count unread messages for a specific agent.
   * Used for "new mail" notifications without pulling full message bodies.
   */
  unreadCount(forAgentId: string, sessionId?: string): Promise<number>;

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

  /**
   * Auto-compact: remove messages that are no longer needed.
   *
   * Two cleanup passes run in a single file rewrite:
   *  1. **Read-by-all**: Messages read by every currently-online agent,
   *     older than `readMaxAgeMs` (default 10 min).
   *  2. **Expired**: Messages whose `expiresAt` is in the past, or whose
   *     `timestamp` is older than `defaultTtlMs` (default 24h) when no
   *     explicit `expiresAt` is set.
   *
   * Also runs `purgeStale` logic (completed > 1 day, incomplete > 7 days)
   * in the same pass to avoid a second rewrite.
   */
  autoCompact(opts?: AutoCompactOptions): Promise<AutoCompactResult>;

  /**
   * Start a background timer that periodically calls `autoCompact`.
   * Returns a dispose function that stops the timer. Idempotent —
   * calling start twice replaces the prior timer.
   */
  startAutoCompactTimer(opts?: AutoCompactOptions): () => void;

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

  /** Remove a client immediately on clean shutdown. */
  deregisterClient(clientId: string): Promise<void>;

  /**
   * Get snapshot of online/offline clients and their last activity.
   */
  getClientStatuses(): Promise<ClientStatus[]>;

  /**
   * Explicitly purge stale clients from the registry.
   * Removes client entries whose lastSeenAt is older than CLIENT_STALE_MS.
   * Returns the number of entries purged.
   */
  purgeClients(): Promise<number>;
}

export {
  expandMailboxCapabilities,
  hasMailboxCapability,
  MAILBOX_CAPABILITY_IMPLICATIONS,
  type MailboxActorContext,
  type MailboxAuthMode,
  type MailboxCapability,
  type MailboxPrincipalKind,
} from './mailbox-auth-types.js';

// ── Recipient-scoped receipt state ───────────────────────────────────

/**
 * Per-recipient delivery/action state for a single message.
 *
 * Keyed by actor ID. Each entry tracks when the actor read, completed,
 * or otherwise interacted with the message — independently of other actors.
 */
export interface MailboxRecipientState {
  /** Actor ID this state belongs to. */
  actorId: string;
  /** ISO8601 — when this actor first read the message. */
  readAt?: string | undefined;
  /** ISO8601 — when this actor completed the message. */
  completedAt?: string | undefined;
  /** Who recorded the completion (usually same as actorId). */
  completedBy?: string | undefined;
  /** Optional outcome summary recorded by this actor. */
  outcome?: string | undefined;
}

/**
 * V2 JSONL receipt record. Appended alongside messages and v1 ack records.
 *
 * Has an explicit `__mailboxReceipt: 2` discriminator so:
 * 1. The v2 reader folds these into per-actor `MailboxRecipientState`.
 * 2. A v1 reader ignores the unknown JSON line (no `__ack` field).
 *
 * Fold algebra (applied during materialization):
 *   - Keyed by `(messageId, actorId)`.
 *   - `read`: first-write-wins (earliest read timestamp is preserved).
 *   - `completed`: monotonic upward (once `true`, cannot revert unless an
 *     explicit reopen record with `completed: false` is appended).
 *   - `outcome`: last-write-wins.
 *   - Duplicate records (same messageId, actorId, timestamp): idempotent no-ops.
 */
export interface MailboxReceiptRecordV2 {
  /** Discriminator — always `2` to distinguish from messages and v1 acks. */
  __mailboxReceipt: 2;
  /** Target message this receipt applies to. */
  messageId: string;
  /** Actor this receipt belongs to. */
  actorId: string;
  /** ISO8601 — when the receipt event occurred. */
  timestamp: string;
  /** Was the message read by this actor? */
  read?: boolean | undefined;
  /** Was the message completed by this actor? */
  completed?: boolean | undefined;
  /** Optional outcome summary. */
  outcome?: string | undefined;
}

/**
 * Check if a parsed JSONL value is a v2 receipt record.
 * Validates the discriminator AND required structural fields.
 */
export function isMailboxReceiptRecordV2(value: unknown): value is MailboxReceiptRecordV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v['__mailboxReceipt'] !== 2) return false;
  if (typeof v['messageId'] !== 'string' || v['messageId'].length === 0) return false;
  if (typeof v['actorId'] !== 'string' || v['actorId'].length === 0) return false;
  if (typeof v['timestamp'] !== 'string' || v['timestamp'].length === 0) return false;
  // Validate optional fields when present — prevents malformed JSONL records
  // from entering typed receipt-folding code (e.g. completed:"false" truthy string).
  if ('read' in v && typeof v['read'] !== 'boolean') return false;
  if ('completed' in v && typeof v['completed'] !== 'boolean') return false;
  if ('outcome' in v && v['outcome'] !== undefined && typeof v['outcome'] !== 'string')
    return false;
  return true;
}

// ── Message projections ──────────────────────────────────────────────

/**
 * Materialized message with per-actor recipient state.
 *
 * This is the internal representation after folding all v1 acks and v2
 * receipt records. It carries both the legacy fields (for backward
 * compatibility) and the new actor-specific state map.
 *
 * `legacyGlobalCompletion` is set ONLY for historical v1 fan-out messages
 * that were globally completed. It is never set for new v2 writes.
 */
export interface MailboxMessageProjection extends MailboxMessage {
  /** Per-actor delivery/action state, keyed by actorId. */
  recipientState: Readonly<Record<string, MailboxRecipientState>>;
  /**
   * True ONLY for historical v1 fan-out messages that were globally completed
   * (completed before the v2 migration). These remain globally suppressed to
   * prevent upgrade re-delivery. New v2 writes NEVER set this.
   */
  legacyGlobalCompletion?: boolean | undefined;
}

/**
 * Self-facing message — what a specific actor sees.
 *
 * This does NOT extend `MailboxMessage` because self-facing responses must NOT
 * contain aggregate receipt metadata (`readBy`, `completedBy`, `completedAt`,
 * `outcome`) that would leak other actors' activity. Only actor-specific
 * derived fields are added on top of the non-sensitive message fields.
 */
export interface ActorMailboxMessage
  extends Omit<MailboxMessage, 'readBy' | 'completed' | 'completedBy' | 'completedAt' | 'outcome'> {
  /** Has this actor read the message? */
  readByMe: boolean;
  /** Has this actor completed the message? */
  completedByMe: boolean;
  /** Does this message require action from this actor? */
  actionRequiredForMe: boolean;
  /** This actor's outcome, if any. */
  myOutcome?: string | undefined;
  /**
   * True for historical v1 fan-out messages that were globally completed.
   * Lets the UI distinguish "completed by me" from "completed globally
   * before migration."
   */
  legacyGlobalCompletion?: boolean | undefined;
}

/**
 * Derive `actionRequiredForMe` from the canonical type properties and actor state.
 *
 * Defined as:
 *   `MAILBOX_TYPE_PROPERTIES[type].requiresAction && visible && !completedByMe && !deleted && !legacyGlobalCompletion`
 *
 * For historical legacy-global messages, `actionRequiredForMe` is always false
 * because the message is suppressed and should not re-enter any actor's flow.
 */
export function isActionRequiredForActor(
  message: Pick<MailboxMessage, 'type' | 'deletedAt' | 'completed'>,
  projection: Pick<ActorMailboxMessage, 'completedByMe' | 'legacyGlobalCompletion'>,
): boolean {
  if (projection.legacyGlobalCompletion) return false;
  if (message.deletedAt !== undefined) return false;
  if (projection.completedByMe) return false;
  return MAILBOX_TYPE_PROPERTIES[message.type]?.requiresAction === true;
}
