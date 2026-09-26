/**
 * HQ control-plane command definitions — typed payloads for the commands the
 * HQ dashboard can enqueue to connected machines (Phase 3+ of the HQ command
 * center). These are carried over the existing `HqQueuedCommand` wire shape
 * (`{commandId, type, payload, …}`) whose `type`/`payload` were previously
 * type-erased. This module gives them a discriminated union for type-safe
 * dispatch on the client side (Phase 4).
 *
 * Security model: two commands carry their own capability because they do
 * something the rest cannot. `run-command` (raw shell) is gated by a per-token
 * `control.execute` AND an operator opt-in. `approve` answers a permission
 * prompt on the target machine — `always`/`deny` write persistent trust policy
 * there and `yes` can release a destructive call — so it is gated by
 * `control.approve` on both the browser credential and the target client.
 * Every other command routes through the agent's own decision loop / mailbox
 * and inherits their existing guardrails.
 * See `docs/plans/hq-command-center-2026-07.md`.
 *
 * @module hq/commands
 */

import type { UserInputResponse } from '../types/user-input.js';
import type { HqQueuedCommand } from './protocol/fleet.js';

// ── Command types ───────────────────────────────────────────────────────────

/** HQ_COMMAND_TYPES — the full set of recognized command `type` strings. */
export const HQ_COMMAND_TYPES = [
  'steer',
  'btw',
  'queue',
  'abort',
  'spawn',
  'broadcast',
  'kanban-transition',
  'kanban-assign',
  'kanban-dispatch',
  'approve',
  'answer-input',
  'run-command',
] as const;

export type HqCommandType = (typeof HQ_COMMAND_TYPES)[number];

/** Inject a steer text into a target agent's conversation. */
export interface HqSteerCommand {
  type: 'steer';
  /** Target agent address: a unique id (`leader@<tag>`), an alias (`leader`), or `*` for all. */
  to: string;
  subject: string;
  body: string;
  priority?: 'low' | 'normal' | 'high';
  /**
   * The session this command is for.
   *
   * A command is addressed to a CLIENT, and one client process can hold
   * several sessions at once (the WebUI gives every open tab its own). Without
   * this the command lands on whichever session that host treats as its
   * leader, so an operator who picked tab 3 in HQ steered tab 1. Absent means
   * "the session this client speaks for", which is what every pre-session
   * dashboard sends.
   */
  sessionId?: string;
}

/**
 * Post a non-urgent FYI (`btw`) into a target agent's mailbox. Unlike a steer,
 * a btw is absorbed as context — it does not demand the agent change course.
 * Same wire shape as steer; only the emitted mailbox `type` differs.
 */
export interface HqBtwCommand {
  type: 'btw';
  /** Target agent address: a unique id (`leader@<tag>`), an alias (`leader`), or `*` for all. */
  to: string;
  subject: string;
  body: string;
  priority?: 'low' | 'normal' | 'high';
  /**
   * The session this command is for.
   *
   * A command is addressed to a CLIENT, and one client process can hold
   * several sessions at once (the WebUI gives every open tab its own). Without
   * this the command lands on whichever session that host treats as its
   * leader, so an operator who picked tab 3 in HQ steered tab 1. Absent means
   * "the session this client speaks for", which is what every pre-session
   * dashboard sends.
   */
  sessionId?: string;
}

/**
 * Queue a prompt/note (`queue`) for a target agent. Delivered as a plain
 * `note` mailbox message the agent picks up before its next step — used when
 * the prompt should wait its turn rather than steer the current operation.
 */
export interface HqQueueCommand {
  type: 'queue';
  /** Target agent address: a unique id (`leader@<tag>`), an alias (`leader`), or `*` for all. */
  to: string;
  subject: string;
  body: string;
  priority?: 'low' | 'normal' | 'high';
  /**
   * The session this command is for.
   *
   * A command is addressed to a CLIENT, and one client process can hold
   * several sessions at once (the WebUI gives every open tab its own). Without
   * this the command lands on whichever session that host treats as its
   * leader, so an operator who picked tab 3 in HQ steered tab 1. Absent means
   * "the session this client speaks for", which is what every pre-session
   * dashboard sends.
   */
  sessionId?: string;
}

/** Abort a running agent run or fleet. */
export interface HqAbortCommand {
  type: 'abort';
  /** `'leader'` aborts the session leader; a subagentId aborts one agent; `'fleet'` stops all. */
  target: 'leader' | 'fleet' | string;
  /**
   * The session this command is for.
   *
   * A command is addressed to a CLIENT, and one client process can hold
   * several sessions at once (the WebUI gives every open tab its own). Without
   * this the command lands on whichever session that host treats as its
   * leader, so an operator who picked tab 3 in HQ steered tab 1. Absent means
   * "the session this client speaks for", which is what every pre-session
   * dashboard sends.
   */
  sessionId?: string;
}

/** Spawn a subagent of the given role. */
export interface HqSpawnCommand {
  type: 'spawn';
  role: string;
  /** Optional task description for dispatch routing. */
  task?: string;
  maxIterations?: number;
  /**
   * The session this command is for.
   *
   * A command is addressed to a CLIENT, and one client process can hold
   * several sessions at once (the WebUI gives every open tab its own). Without
   * this the command lands on whichever session that host treats as its
   * leader, so an operator who picked tab 3 in HQ steered tab 1. Absent means
   * "the session this client speaks for", which is what every pre-session
   * dashboard sends.
   */
  sessionId?: string;
}

/** Broadcast a mailbox message to all agents on the target's project. */
export interface HqBroadcastCommand {
  type: 'broadcast';
  subject: string;
  body: string;
  priority?: 'low' | 'normal' | 'high';
}

/**
 * Answer a permission prompt that is currently on screen on the target client.
 * GATED by `control.approve` on BOTH the browser credential and the target
 * client's token.
 *
 * HQ is a MIRROR of the prompt, not its owner: the same prompt is live in the
 * TUI/WebUI/SimpleUI dialog that raised it, and whichever surface answers
 * first wins. A command that arrives after the prompt was settled locally is
 * rejected with "no longer pending" rather than silently dropped, so the
 * operator learns the decision was already made instead of assuming theirs
 * applied.
 *
 * The decision set matches the local surfaces exactly, including the two that
 * write persistent policy: `always` persists a trust rule and `deny` persists
 * a permanent denial, both keyed on the prompt's suggested pattern.
 */
export interface HqApproveCommand {
  type: 'approve';
  /** The tool call the prompt belongs to — the id carried in `approval.requested`. */
  toolUseId: string;
  decision: 'yes' | 'no' | 'always' | 'always-exact' | 'always-command' | 'always-tool' | 'deny';
  sessionId?: string;
}
export interface HqAnswerInputCommand {
  type: 'answer-input';
  requestId: string;
  response: UserInputResponse;
  sessionId?: string;
}

/** Run a shell command on the target machine. GATED by `control.execute`. */
export interface HqRunCommandCommand {
  type: 'run-command';
  command: string;
  /** Optional working directory (defaults to the agent's project root). */
  cwd?: string;
  /**
   * The session this command is for.
   *
   * A command is addressed to a CLIENT, and one client process can hold
   * several sessions at once (the WebUI gives every open tab its own). Without
   * this the command lands on whichever session that host treats as its
   * leader, so an operator who picked tab 3 in HQ steered tab 1. Absent means
   * "the session this client speaks for", which is what every pre-session
   * dashboard sends.
   */
  sessionId?: string;
}

/** Transition one managed Kanban task through the project-scoped IPC owner. */
export interface HqKanbanTransitionCommand {
  type: 'kanban-transition';
  boardId: string;
  taskId: string;
  to: 'backlog' | 'todo' | 'running' | 'review' | 'done';
  comment: string;
  sessionId?: string;
}

/** Assign a Kanban card to a visible agent without dispatching or stealing an active lease. */
export interface HqKanbanAssignCommand {
  type: 'kanban-assign';
  boardId: string;
  taskId: string;
  agentId: string;
  assignee: string;
  comment: string;
  sessionId?: string;
}

/** Claim and dispatch one ready Kanban card through the client's Director. */
export interface HqKanbanDispatchCommand {
  type: 'kanban-dispatch';
  boardId: string;
  taskId: string;
  comment: string;
  sessionId?: string;
}

export type HqCommand =
  | HqSteerCommand
  | HqBtwCommand
  | HqQueueCommand
  | HqAbortCommand
  | HqSpawnCommand
  | HqBroadcastCommand
  | HqKanbanTransitionCommand
  | HqKanbanAssignCommand
  | HqKanbanDispatchCommand
  | HqApproveCommand
  | HqAnswerInputCommand
  | HqRunCommandCommand;

// ── Validation ──────────────────────────────────────────────────────────────

const HQ_COMMAND_TYPE_SET = new Set<string>(HQ_COMMAND_TYPES);

/**
 * Validate that an inbound `HqQueuedCommand` has a recognized `type` and a
 * minimally well-formed payload. Returns the narrowed command on success, or
 * `null` when the command should be rejected.
 *
 * This is a shape check, not a security gate — capability enforcement happens
 * at enqueue time (browser token must have `control.enqueue`) and at execute
 * time (`run-command` requires `control.execute`).
 */
/**
 * Carry an optional session address through validation.
 *
 * The validator rebuilds each command from named fields, so anything it does
 * not copy is silently dropped — which is the right default, and the reason
 * this has to be explicit.
 */
function withSessionId<T extends { sessionId?: string }>(
  result: T,
  payload: Record<string, unknown>,
): T {
  const sessionId = payload['sessionId'];
  if (typeof sessionId === 'string' && sessionId.length > 0) result.sessionId = sessionId;
  return result;
}

export function validateHqCommand(queued: HqQueuedCommand): HqCommand | null {
  if (!HQ_COMMAND_TYPE_SET.has(queued.type)) return null;
  const p = queued.payload as Record<string, unknown>;
  if (p === null || typeof p !== 'object') return null;
  switch (queued.type as HqCommandType) {
    case 'steer': {
      if (
        typeof p['to'] !== 'string' ||
        typeof p['subject'] !== 'string' ||
        typeof p['body'] !== 'string'
      ) {
        return null;
      }
      const result: HqSteerCommand = {
        type: 'steer',
        to: p['to'],
        subject: p['subject'],
        body: p['body'],
      };
      if (p['priority'] === 'low' || p['priority'] === 'normal' || p['priority'] === 'high') {
        result.priority = p['priority'];
      }
      return withSessionId(result, p);
    }
    case 'btw': {
      if (
        typeof p['to'] !== 'string' ||
        typeof p['subject'] !== 'string' ||
        typeof p['body'] !== 'string'
      ) {
        return null;
      }
      const result: HqBtwCommand = {
        type: 'btw',
        to: p['to'],
        subject: p['subject'],
        body: p['body'],
      };
      if (p['priority'] === 'low' || p['priority'] === 'normal' || p['priority'] === 'high') {
        result.priority = p['priority'];
      }
      return withSessionId(result, p);
    }
    case 'queue': {
      if (
        typeof p['to'] !== 'string' ||
        typeof p['subject'] !== 'string' ||
        typeof p['body'] !== 'string'
      ) {
        return null;
      }
      const result: HqQueueCommand = {
        type: 'queue',
        to: p['to'],
        subject: p['subject'],
        body: p['body'],
      };
      if (p['priority'] === 'low' || p['priority'] === 'normal' || p['priority'] === 'high') {
        result.priority = p['priority'];
      }
      return withSessionId(result, p);
    }
    case 'abort':
      if (typeof p['target'] !== 'string') return null;
      return withSessionId<HqAbortCommand>({ type: 'abort', target: p['target'] }, p);
    case 'spawn': {
      if (typeof p['role'] !== 'string') return null;
      const result: HqSpawnCommand = { type: 'spawn', role: p['role'] };
      if (typeof p['task'] === 'string') result.task = p['task'];
      if (typeof p['maxIterations'] === 'number') result.maxIterations = p['maxIterations'];
      return withSessionId(result, p);
    }
    case 'broadcast': {
      if (typeof p['subject'] !== 'string' || typeof p['body'] !== 'string') return null;
      const result: HqBroadcastCommand = {
        type: 'broadcast',
        subject: p['subject'],
        body: p['body'],
      };
      if (p['priority'] === 'low' || p['priority'] === 'normal' || p['priority'] === 'high') {
        result.priority = p['priority'];
      }
      return result;
    }
    case 'kanban-transition': {
      if (
        typeof p['boardId'] !== 'string' ||
        p['boardId'].length === 0 ||
        typeof p['taskId'] !== 'string' ||
        p['taskId'].length === 0 ||
        !['backlog', 'todo', 'running', 'review', 'done'].includes(String(p['to'])) ||
        typeof p['comment'] !== 'string' ||
        p['comment'].trim().length === 0
      ) {
        return null;
      }
      return withSessionId<HqKanbanTransitionCommand>(
        {
          type: 'kanban-transition',
          boardId: p['boardId'],
          taskId: p['taskId'],
          to: p['to'] as HqKanbanTransitionCommand['to'],
          comment: p['comment'],
        },
        p,
      );
    }
    case 'kanban-assign': {
      if (
        typeof p['boardId'] !== 'string' ||
        p['boardId'].length === 0 ||
        typeof p['taskId'] !== 'string' ||
        p['taskId'].length === 0 ||
        typeof p['agentId'] !== 'string' ||
        p['agentId'].trim().length === 0 ||
        typeof p['assignee'] !== 'string' ||
        p['assignee'].trim().length === 0 ||
        typeof p['comment'] !== 'string' ||
        p['comment'].trim().length === 0
      ) {
        return null;
      }
      return withSessionId<HqKanbanAssignCommand>(
        {
          type: 'kanban-assign',
          boardId: p['boardId'],
          taskId: p['taskId'],
          agentId: p['agentId'],
          assignee: p['assignee'],
          comment: p['comment'],
        },
        p,
      );
    }
    case 'kanban-dispatch': {
      if (
        typeof p['boardId'] !== 'string' ||
        p['boardId'].length === 0 ||
        typeof p['taskId'] !== 'string' ||
        p['taskId'].length === 0 ||
        typeof p['comment'] !== 'string' ||
        p['comment'].trim().length === 0
      ) {
        return null;
      }
      return withSessionId<HqKanbanDispatchCommand>(
        {
          type: 'kanban-dispatch',
          boardId: p['boardId'],
          taskId: p['taskId'],
          comment: p['comment'],
        },
        p,
      );
    }
    case 'approve': {
      if (typeof p['toolUseId'] !== 'string' || p['toolUseId'].length === 0) return null;
      const decision = p['decision'];
      // Closed set on purpose: `abort` is a lifecycle outcome the run produces
      // for itself, never something an operator sends.
      if (
        decision !== 'yes' &&
        decision !== 'no' &&
        decision !== 'always' &&
        decision !== 'always-exact' &&
        decision !== 'always-command' &&
        decision !== 'always-tool' &&
        decision !== 'deny'
      ) {
        return null;
      }
      return withSessionId<HqApproveCommand>(
        { type: 'approve', toolUseId: p['toolUseId'], decision },
        p,
      );
    }
    case 'answer-input': {
      if (typeof p['requestId'] !== 'string' || p['requestId'].length === 0) return null;
      const response = p['response'];
      if (
        typeof response !== 'object' ||
        response === null ||
        Array.isArray(response) ||
        !Array.isArray((response as Record<string, unknown>)['answers'])
      )
        return null;
      return withSessionId<HqAnswerInputCommand>(
        {
          type: 'answer-input',
          requestId: p['requestId'],
          response: response as UserInputResponse,
        },
        p,
      );
    }
    case 'run-command': {
      if (typeof p['command'] !== 'string') return null;
      const result: HqRunCommandCommand = { type: 'run-command', command: p['command'] };
      if (typeof p['cwd'] === 'string') result.cwd = p['cwd'];
      return withSessionId(result, p);
    }
    default:
      return null;
  }
}

// ── Audit log ───────────────────────────────────────────────────────────────

export interface HqCommandAuditEntry {
  commandId: string;
  type: HqCommandType;
  clientId: string;
  /** Who enqueued the command (browser token id, or 'anonymous' in open mode). */
  enqueuedBy: string;
  enqueuedAt: string;
  status: 'queued' | 'delivered' | 'acked';
  /**
   * Epoch ms when the server pushed the command batch onto the target's socket
   * (the `queued` -> `delivered` transition).
   *
   * Distinct from `enqueuedAt`, which is when the operator's HTTP POST was
   * accepted: the gap between the two is server-side queue time, and the gap
   * from here to `acknowledgedAt` is wire + client turn-around. Keeping both
   * is what lets the latency summary separate "HQ was slow to flush" from
   * "the machine was slow to answer".
   */
  dispatchedAt?: number;
  /** Epoch ms when the client's `client.command_ack` was accepted by the server. */
  acknowledgedAt?: number;
  /** Ack status when the client has responded. */
  ackStatus?: 'accepted' | 'completed' | 'failed' | 'rejected';
  ackMessage?: string;
  ackedAt?: string;
}

/**
 * Percentile roll-up of the `dispatched -> acknowledged` latency across the
 * acked commands in a window. Percentiles are computed over the sample the
 * audit ring holds (capped at 1000 entries), so this is an order-of-magnitude
 * signal, not an exact SLO measurement.
 */
export interface HqCommandLatencySummary {
  /** How many acked commands carried BOTH timestamps and contributed a sample. */
  sampleCount: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  maxMs?: number;
}

/**
 * Nearest-rank percentile over an ascending array. Returns `undefined` for an
 * empty array so callers render "no data" rather than a misleading 0 ms.
 */
function percentile(sorted: readonly number[], fraction: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index];
}

/**
 * Summarize `dispatched -> acknowledged` command latency.
 *
 * Only entries that carry BOTH timestamps are sampled: a command still in
 * flight, one whose client disconnected before delivery, or one seeded from a
 * pre-latency audit log would otherwise skew the percentiles toward zero.
 * Negative deltas (clock skew between the stamping sites) are discarded rather
 * than clamped, because a clamped 0 would masquerade as a healthy sample.
 */
export function summarizeCommandLatency(
  entries: readonly HqCommandAuditEntry[],
  limit = 200,
): HqCommandLatencySummary {
  const window = entries.slice(-limit);
  const samples: number[] = [];
  for (const entry of window) {
    const dispatched = entry.dispatchedAt;
    const acknowledged = entry.acknowledgedAt;
    if (typeof dispatched !== 'number' || typeof acknowledged !== 'number') continue;
    const delta = acknowledged - dispatched;
    if (delta < 0) continue;
    samples.push(delta);
  }
  if (samples.length === 0) return { sampleCount: 0 };
  samples.sort((a, b) => a - b);
  const summary: HqCommandLatencySummary = { sampleCount: samples.length };
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const p99 = percentile(samples, 0.99);
  const max = samples[samples.length - 1];
  if (p50 !== undefined) summary.p50Ms = p50;
  if (p95 !== undefined) summary.p95Ms = p95;
  if (p99 !== undefined) summary.p99Ms = p99;
  if (max !== undefined) summary.maxMs = max;
  return summary;
}

/**
 * In-memory command audit ring. Capped for cheap reads. When an `onPersist`
 * callback is wired, every record/update also sinks a snapshot of the entry to
 * the caller's durable store (e.g. HQ's `commands.jsonl`) so history survives
 * restarts. The ring remains the read path for `/api/commands`.
 */
export class HqCommandAuditLog {
  private readonly entries: HqCommandAuditEntry[] = [];
  private readonly max: number;
  private readonly onPersist?: ((entry: HqCommandAuditEntry) => void) | undefined;

  constructor(max = 1000, onPersist?: ((entry: HqCommandAuditEntry) => void) | undefined) {
    this.max = max;
    this.onPersist = onPersist;
  }

  record(entry: HqCommandAuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.max) {
      this.entries.splice(0, this.entries.length - this.max);
    }
    this.onPersist?.(entry);
  }

  update(commandId: string, patch: Partial<HqCommandAuditEntry>): void {
    const entry = this.entries.find((e) => e.commandId === commandId);
    if (entry) {
      Object.assign(entry, patch);
      this.onPersist?.(entry);
    }
  }

  get(commandId: string): HqCommandAuditEntry | undefined {
    return this.entries.find((entry) => entry.commandId === commandId);
  }

  /** Update only when the command belongs to the authenticated client. */
  updateForClient(
    commandId: string,
    clientId: string,
    patch: Partial<HqCommandAuditEntry>,
  ): boolean {
    const entry = this.entries.find(
      (candidate) => candidate.commandId === commandId && candidate.clientId === clientId,
    );
    if (!entry) return false;
    Object.assign(entry, patch);
    this.onPersist?.(entry);
    return true;
  }

  /**
   * Seed the ring from a durable store on boot (no persist callback fired).
   *
   * The store is an append log: every transition (`queued` → `delivered` →
   * `acked`) persists the whole entry again, so one command is several rows.
   * Pushing them verbatim put each command in the ring up to three times, and
   * `get()` — which returns the FIRST match — answered with the stale
   * `queued` copy. Rows are folded by `commandId`, last write wins, keeping
   * the position of the command's first appearance.
   *
   * A command that was still `queued` or `delivered` when the previous HQ
   * process died can never settle: its queue lived on a socket of that
   * process. Left as-is it shows as pending forever, so it is resolved as
   * failed here, with a message that says what is actually known.
   */
  seed(entries: readonly HqCommandAuditEntry[]): void {
    const folded = new Map<string, HqCommandAuditEntry>();
    for (const entry of entries) {
      if (typeof entry?.commandId !== 'string') continue;
      const previous = folded.get(entry.commandId);
      folded.set(
        entry.commandId,
        previous === undefined ? { ...entry } : { ...previous, ...entry },
      );
    }
    for (const entry of this.entries) folded.delete(entry.commandId);
    const seeded: HqCommandAuditEntry[] = [];
    for (const entry of folded.values()) {
      if (entry.status !== 'acked') {
        seeded.push({
          ...entry,
          status: 'acked',
          ackStatus: 'failed',
          ackMessage:
            entry.status === 'queued'
              ? 'never delivered: HQ restarted before the client polled'
              : 'HQ restarted before the client acknowledged; outcome unknown',
        });
      } else {
        seeded.push(entry);
      }
    }
    // Seeding happens after boot, so live entries recorded in the meantime are
    // newer than anything on disk and stay at the tail.
    this.entries.unshift(...seeded);
    if (this.entries.length > this.max) {
      this.entries.splice(0, this.entries.length - this.max);
    }
  }

  recent(limit = 200): HqCommandAuditEntry[] {
    return this.entries.slice(-limit);
  }
}
