/**
 * status-broadcast — mailbox broadcasts on meaningful subagent transitions.
 *
 * The third leg of peer awareness (with the fleet-pulse digest and the
 * fleet_status tool): when a fleet subagent joins, finishes a task, or (when
 * explicitly enabled) hits budget pressure, a low-priority `type:'status'`
 * broadcast lands in the project mailbox so every OTHER agent — including
 * agents in other processes on the same project — sees it on its next iteration.
 *
 * It also keeps the mailbox registry heartbeat rich: task start/stop
 * transitions push `currentTask`/`status` into the registry, which is what
 * makes the fleet-pulse digest and `fleet_status` show WHAT each fleet
 * worker is doing cross-process (the plain interval heartbeat only proves
 * liveness).
 *
 * Spam control:
 *   - per-subagent min interval (terminal statuses coalesce: the newest
 *     replaces the pending one rather than being dropped)
 *   - global per-minute cap (excess dropped + counted; the next allowed
 *     broadcast reports how many were dropped)
 *   - one-shot events (spawned, budget_warning per kind) dedup themselves
 *
 * @module fleet/status-broadcast
 */

import type { Mailbox } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { FleetConfig } from '@wrongstack/core/types';

interface FleetStatusBroadcasterOptions {
  /** Host EventBus carrying the re-emitted `subagent.*` lifecycle events. */
  events: EventBus;
  /** Lazily construct the project mailbox (created once, on first use). */
  mailboxFactory: () => Mailbox;
  /** Session tag provider for the `fleet@<tag>` sender identity. */
  sessionTag: () => string;
  /** Nickname lookup for a subagent id (falls back to the raw id). */
  subagentName?: ((subagentId: string) => string | undefined) | undefined;
  config?: FleetConfig['statusBroadcasts'] | undefined;
}

const DEFAULT_MIN_INTERVAL_MS = 15_000;
const DEFAULT_GLOBAL_PER_MINUTE = 20;
const BODY_MAX = 200;

function isSilentInfrastructureAgent(name: string): boolean {
  // Chimera has its own durable report mail plus chimera.report_available.
  // Re-broadcasting its ephemeral reviewer lifecycle only adds duplicate
  // "joined the fleet" / "task success" noise to every project session.
  return name.trim().toLowerCase() === 'chimera-review';
}

interface PendingBroadcast {
  subject: string;
  body: string;
  priority: 'low' | 'normal';
}

export function createFleetStatusBroadcaster(opts: FleetStatusBroadcasterOptions): {
  start(): void;
  stop(): void;
} {
  const cfg = opts.config;
  const minIntervalMs = cfg?.minIntervalMsPerAgent ?? DEFAULT_MIN_INTERVAL_MS;
  const perMinuteCap = cfg?.globalPerMinuteCap ?? DEFAULT_GLOBAL_PER_MINUTE;
  // Budget thresholds are local operational telemetry, and timeout thresholds
  // can be proactive (85% of the deadline) rather than exhaustion. Broadcasting
  // them project-wide by default floods every peer with recoverable internals.
  const broadcastBudgetWarnings = cfg?.budgetWarnings === true;
  const disabled = cfg?.enabled === false;

  let mailbox: Mailbox | null = null;
  const mb = (): Mailbox => {
    if (!mailbox) mailbox = opts.mailboxFactory();
    return mailbox;
  };
  const nameOf = (id: string): string => opts.subagentName?.(id) ?? id;
  const from = (): string => `fleet@${opts.sessionTag()}`;

  // ── throttling state ────────────────────────────────────────────────
  const lastSentAt = new Map<string, number>(); // subagentId → ts
  const coalesced = new Map<
    string,
    { pending: PendingBroadcast; timer: ReturnType<typeof setTimeout> }
  >();
  const sentTimestamps: number[] = []; // sliding 60s window
  let droppedSinceLastSend = 0;
  const announcedSpawn = new Set<string>();
  const announcedBudget = new Set<string>(); // `${subagentId}|${kind}`
  const silentInfrastructureAgents = new Set<string>();
  const disposers: Array<() => void> = [];
  let stopped = false;

  function underGlobalCap(now: number): boolean {
    while (sentTimestamps.length > 0 && now - (sentTimestamps[0] ?? 0) > 60_000) {
      sentTimestamps.shift();
    }
    return sentTimestamps.length < perMinuteCap;
  }

  function sendNow(subagentId: string, p: PendingBroadcast): void {
    const now = Date.now();
    if (!underGlobalCap(now)) {
      droppedSinceLastSend++;
      return;
    }
    sentTimestamps.push(now);
    lastSentAt.set(subagentId, now);
    let body = p.body;
    if (droppedSinceLastSend > 0) {
      body = `${body} [${droppedSinceLastSend} earlier status broadcast(s) dropped by rate cap]`;
      droppedSinceLastSend = 0;
    }
    void mb()
      .send({
        from: from(),
        to: '*',
        type: 'status',
        subject: p.subject,
        body: body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}…` : body,
        priority: p.priority,
      })
      .catch(() => {
        /* best-effort — a broken mailbox must never affect the fleet */
      });
  }

  /**
   * Rate-limited send about one subagent. Within the per-agent window the
   * newest broadcast COALESCES (replaces any pending one and fires when
   * the window reopens) instead of being dropped — terminal statuses must
   * eventually reach peers.
   */
  function broadcast(subagentId: string, p: PendingBroadcast): void {
    if (stopped) return;
    const now = Date.now();
    const last = lastSentAt.get(subagentId) ?? 0;
    const waitMs = last + minIntervalMs - now;
    if (waitMs <= 0) {
      sendNow(subagentId, p);
      return;
    }
    const existing = coalesced.get(subagentId);
    if (existing) {
      existing.pending = p; // newest wins
      return;
    }
    const timer = setTimeout(() => {
      const entry = coalesced.get(subagentId);
      coalesced.delete(subagentId);
      if (!stopped && entry) sendNow(subagentId, entry.pending);
    }, waitMs);
    // Don't hold the process open for a pending status mail.
    timer.unref?.();
    coalesced.set(subagentId, { pending: p, timer });
  }

  function heartbeat(input: {
    agentId: string;
    status?: 'idle' | 'running' | undefined;
    currentTask?: string | undefined;
  }): void {
    void mb()
      .heartbeat(input)
      .catch(() => {});
  }

  return {
    start(): void {
      if (disabled || stopped) return;
      disposers.push(
        opts.events.on('subagent.spawned', (e) => {
          if (announcedSpawn.has(e.subagentId)) return;
          announcedSpawn.add(e.subagentId);
          const name = e.name ?? nameOf(e.subagentId);
          if (isSilentInfrastructureAgent(name)) {
            silentInfrastructureAgents.add(e.subagentId);
            return;
          }
          broadcast(e.subagentId, {
            subject: `[${name}] joined the fleet`,
            body: `${name} spawned${e.model ? ` on ${e.model}` : ''}${
              e.description ? ` — ${e.description.slice(0, 80)}` : ''
            }`,
            priority: 'low',
          });
        }),
        opts.events.on('subagent.task_started', (e) => {
          // Registry enrichment only — a start is visible via the pulse;
          // broadcasting every start would double mailbox traffic.
          heartbeat({
            agentId: e.subagentId,
            status: 'running',
            currentTask: e.description?.slice(0, 80),
          });
        }),
        opts.events.on('subagent.task_completed', (e) => {
          heartbeat({ agentId: e.subagentId, status: 'idle' });
          const name = nameOf(e.subagentId);
          if (silentInfrastructureAgents.has(e.subagentId) || isSilentInfrastructureAgent(name)) {
            return;
          }
          const ok = e.status === 'success';
          const secs = Math.round(e.durationMs / 1000);
          broadcast(e.subagentId, {
            subject: `[${name}] task ${e.status}`,
            body: `${name} finished a task: ${e.status} — ${e.iterations} iter, ${e.toolCalls} tools, ${secs}s${
              !ok && e.error ? ` (${e.error.kind})` : ''
            }`,
            priority: ok ? 'low' : 'normal',
          });
        }),
        opts.events.on('subagent.budget_warning', (e) => {
          if (!broadcastBudgetWarnings) return;
          if (
            silentInfrastructureAgents.has(e.subagentId) ||
            isSilentInfrastructureAgent(nameOf(e.subagentId))
          ) {
            return;
          }
          const key = `${e.subagentId}|${e.kind}`;
          if (announcedBudget.has(key)) return;
          announcedBudget.add(key);
          broadcast(e.subagentId, {
            subject: `[${nameOf(e.subagentId)}] budget pressure`,
            body: `${nameOf(e.subagentId)} reached its ${e.kind} extension threshold (${e.used}/${e.limit})`,
            priority: 'low',
          });
        }),
        // A retired subagent's id will never be seen again, so its one-shot dedup
        // guards and throttle timestamp are dead weight. Prune them so a long-lived
        // fleet that spawns thousands of subagents does not leak one entry each.
        //
        // Deregister from the mailbox agent registry so the retirement is visible
        // cross-process immediately. Without this, the registry entry lingers with
        // status 'idle' (the last heartbeat from the task_completed handler) until
        // the 60s lazy prune fires — leaking dead agents in fleet_status and the
        // fleet pulse for up to a minute. deregisterAgent is used instead of
        // heartbeat({ status: 'offline' }) because (a) RegisteredAgent.status
        // does not include 'offline' (only the read-side MailboxAgentStatus does),
        // and (b) the heartbeat path is throttled to 1/5s so it silently drops
        // when fired right after the task_completed idle heartbeat.
        opts.events.on('subagent.removed', (e) => {
          void mb()
            .deregisterAgent(e.subagentId)
            .catch(() => {
              /* best-effort — a broken mailbox must never affect the fleet */
            });
          announcedSpawn.delete(e.subagentId);
          silentInfrastructureAgents.delete(e.subagentId);
          lastSentAt.delete(e.subagentId);
          for (const key of announcedBudget) {
            if (key.startsWith(`${e.subagentId}|`)) announcedBudget.delete(key);
          }
        }),
      );
    },
    stop(): void {
      stopped = true;
      for (const d of disposers.splice(0)) d();
      for (const { timer } of coalesced.values()) clearTimeout(timer);
      coalesced.clear();
    },
  };
}
