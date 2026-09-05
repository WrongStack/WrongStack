/**
 * HQ control-plane command definitions — typed payloads for the commands the
 * HQ dashboard can enqueue to connected machines (Phase 3+ of the HQ command
 * center). These are carried over the existing `HqQueuedCommand` wire shape
 * (`{commandId, type, payload, …}`) whose `type`/`payload` were previously
 * type-erased. This module gives them a discriminated union for type-safe
 * dispatch on the client side (Phase 4).
 *
 * Security model: `run-command` (raw shell) is gated by a per-token
 * `control.execute` capability AND an operator opt-in; the other four commands
 * route through the agent's own decision loop / mailbox and inherit their
 * existing guardrails. See `docs/plans/hq-command-center-2026-07.md`.
 *
 * @module hq/commands
 */
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

export type HqCommand =
  | HqSteerCommand
  | HqBtwCommand
  | HqQueueCommand
  | HqAbortCommand
  | HqSpawnCommand
  | HqBroadcastCommand
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
  /** Ack status when the client has responded. */
  ackStatus?: 'accepted' | 'completed' | 'failed' | 'rejected';
  ackMessage?: string;
  ackedAt?: string;
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

  /** Seed the ring from a durable store on boot (no persist callback fired). */
  seed(entries: readonly HqCommandAuditEntry[]): void {
    for (const entry of entries) {
      this.entries.push(entry);
    }
    if (this.entries.length > this.max) {
      this.entries.splice(0, this.entries.length - this.max);
    }
  }

  recent(limit = 200): HqCommandAuditEntry[] {
    return this.entries.slice(-limit);
  }
}
