/**
 * Turn fleet state into notifications worth a push.
 *
 * - {@link HqMachineWatch}: a machine THIS HQ process saw online that has
 *   been silent past a grace period ("went offline"), and its return ("back
 *   online"). Machines already offline when HQ started are not announced, so
 *   a restart never replays yesterday's outages.
 * - {@link HqHostHealthWatch}: a live machine whose project disk or memory
 *   ran low, announced once per episode; it can fire again after recovering.
 * - {@link HqPendingRequestWatch}: an approval or question still unanswered
 *   after the configured delay, so one answered at the terminal within
 *   seconds never reaches a phone.
 *
 * @module hq/notify-watchers
 */

import type { HqHostHealthProblem } from './host-health-verdict.js';
import type { HqNotification } from './notifier.js';
import type { HqEventEnvelope, HqHostHealth, HqKnownMachine } from './protocol.js';

const DEFAULT_OFFLINE_GRACE_MS = 2 * 60_000;
const MAX_PENDING = 1_000;
/** One client flooding requests must not crowd out every other client's. */
const MAX_PENDING_PER_CLIENT = 100;

export class HqMachineWatch {
  private readonly seenLive = new Set<string>();
  private readonly announced = new Set<string>();

  constructor(private readonly graceMs: number = DEFAULT_OFFLINE_GRACE_MS) {}

  observe(
    live: ReadonlySet<string>,
    offline: readonly HqKnownMachine[],
    now: number,
    label: (key: string) => string,
  ): HqNotification[] {
    const out: HqNotification[] = [];
    for (const key of live) {
      if (this.announced.delete(key)) {
        out.push({
          kind: 'machine',
          severity: 'info',
          title: `${label(key)} is back online`,
          body: 'A WrongStack client on this machine connected to HQ again.',
          dedupeKey: `machine-online:${key}:${now}`,
          path: `/fleet/machines/?machine=${encodeURIComponent(key)}`,
          machineKey: key,
        });
      }
      this.seenLive.add(key);
    }
    const known = new Set(live);
    for (const machine of offline) {
      known.add(machine.key);
      if (!this.seenLive.has(machine.key) || this.announced.has(machine.key)) continue;
      if (now - Date.parse(machine.lastSeenAt) < this.graceMs) continue;
      this.announced.add(machine.key);
      const projects = machine.projects.map((project) => project.projectName).join(', ');
      out.push({
        kind: 'machine',
        severity: 'warn',
        title: `${machine.hostname ?? label(machine.key)} went offline`,
        body: `No WrongStack client on it has reached HQ since ${machine.lastSeenAt}.${
          projects ? ` Projects there: ${projects}.` : ''
        }`,
        dedupeKey: `machine-offline:${machine.key}:${machine.lastSeenAt}`,
        path: `/fleet/machines/?machine=${encodeURIComponent(machine.key)}`,
        machineKey: machine.key,
      });
    }
    // A forgotten machine is neither live nor offline: stop tracking it.
    for (const key of this.seenLive) {
      if (!known.has(key)) {
        this.seenLive.delete(key);
        this.announced.delete(key);
      }
    }
    return out;
  }
}

const GIB = 1024 ** 3;
const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GB`;

/** One live machine's newest health sample, as the server folded it. */
export interface HqHostHealthObservation {
  key: string;
  label: string;
  health: (HqHostHealth & { reportedAt: string }) | undefined;
  /** The server's verdict on `health` (`HqMachineRecord.healthProblems`). */
  problems: readonly HqHostHealthProblem[] | undefined;
}

export class HqHostHealthWatch {
  /** `<key>|<problem>` → when the episode began. */
  private readonly open = new Map<string, number>();

  observe(machines: readonly HqHostHealthObservation[], now: number): HqNotification[] {
    const out: HqNotification[] = [];
    const current = new Set<string>();
    for (const machine of machines) {
      const health = machine.health;
      if (health === undefined) continue;
      for (const problem of machine.problems ?? []) {
        const id = `${machine.key}|${problem}`;
        current.add(id);
        if (this.open.has(id)) continue;
        this.open.set(id, now);
        out.push(this.note(machine, health, problem, now));
      }
    }
    // An episode ends when the machine reports healthy again or leaves.
    for (const id of this.open.keys()) if (!current.has(id)) this.open.delete(id);
    return out;
  }

  private note(
    machine: HqHostHealthObservation,
    health: HqHostHealth,
    problem: HqHostHealthProblem,
    now: number,
  ): HqNotification {
    const disk = problem === 'disk';
    return {
      kind: 'machine',
      severity: 'warn',
      title: disk ? `${machine.label} is low on disk space` : `${machine.label} is short of memory`,
      body: disk
        ? `${gib(health.diskFreeBytes ?? 0)} free of ${gib(health.diskTotalBytes ?? 0)} on the volume that holds the project.`
        : `${gib(health.memAvailableBytes)} available of ${gib(health.memTotalBytes)}.`,
      dedupeKey: `host-${problem}:${machine.key}:${now}`,
      path: `/fleet/machines/?machine=${encodeURIComponent(machine.key)}`,
      machineKey: machine.key,
    };
  }
}

/** Where a request came from, resolved by the server from its client table. */
export interface HqRequestOrigin {
  hostname: string;
  projectName: string;
  /** The machine the request came from, when HQ knows the client. */
  machineKey?: string | undefined;
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  clientId: string;
}

export class HqPendingRequestWatch {
  private readonly pending = new Map<string, Pending>();
  private readonly perClient = new Map<string, number>();

  constructor(
    private readonly opts: {
      delayMs: () => number;
      /** Is the client that raised it still connected (else it is moot)? */
      stillConnected: (clientId: string) => boolean;
      emit: (note: HqNotification) => void;
    },
  ) {}

  /** Feed every client event; only request/resolve pairs matter. */
  observe(event: HqEventEnvelope, origin: HqRequestOrigin): void {
    const payload = event.payload as Record<string, unknown> | null;
    if (payload === null || typeof payload !== 'object') return;
    if (event.type === 'approval.requested' && typeof payload.toolUseId === 'string') {
      const tool = typeof payload.toolName === 'string' ? payload.toolName : 'a tool';
      const risky = payload.destructive === true || payload.riskTier === 'destructive';
      this.schedule(`${event.clientId}|approval:${payload.toolUseId}`, event.clientId, {
        kind: 'approval',
        severity: risky ? 'error' : 'warn',
        title: `Approval waiting: ${tool} on ${origin.hostname}`,
        body: `${origin.projectName} — ${risky ? 'a destructive call' : 'a tool call'} is waiting for a decision.`,
        dedupeKey: `approval:${payload.toolUseId}`,
        path: '/inbox/',
        ...(origin.machineKey !== undefined ? { machineKey: origin.machineKey } : {}),
      });
    } else if (event.type === 'approval.resolved' && typeof payload.toolUseId === 'string') {
      this.cancel(`${event.clientId}|approval:${payload.toolUseId}`);
    } else if (event.type === 'user_input.requested') {
      const request = payload.request as { id?: unknown; title?: unknown } | undefined;
      if (typeof request?.id !== 'string') return;
      const title = typeof request.title === 'string' ? request.title : 'A question';
      this.schedule(`${event.clientId}|question:${request.id}`, event.clientId, {
        kind: 'question',
        severity: 'warn',
        title: `Question waiting on ${origin.hostname}`,
        body: `${origin.projectName} — ${title}`,
        dedupeKey: `question:${request.id}`,
        path: '/inbox/',
        ...(origin.machineKey !== undefined ? { machineKey: origin.machineKey } : {}),
      });
    } else if (event.type === 'user_input.resolved' && typeof payload.requestId === 'string') {
      this.cancel(`${event.clientId}|question:${payload.requestId}`);
    }
  }

  /** Stop every timer (server shutdown). */
  close(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.perClient.clear();
  }

  size(): number {
    return this.pending.size;
  }

  private schedule(key: string, clientId: string, note: HqNotification): void {
    if (this.pending.has(key)) return;
    const mine = this.perClient.get(clientId) ?? 0;
    if (this.pending.size >= MAX_PENDING || mine >= MAX_PENDING_PER_CLIENT) return;
    const timer = setTimeout(() => {
      this.release(key);
      if (this.opts.stillConnected(clientId)) this.opts.emit(note);
    }, this.opts.delayMs());
    timer.unref?.();
    this.pending.set(key, { timer, clientId });
    this.perClient.set(clientId, mine + 1);
  }

  private cancel(key: string): void {
    const entry = this.pending.get(key);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.release(key);
  }

  private release(key: string): void {
    const entry = this.pending.get(key);
    if (entry === undefined) return;
    this.pending.delete(key);
    const left = (this.perClient.get(entry.clientId) ?? 1) - 1;
    if (left <= 0) this.perClient.delete(entry.clientId);
    else this.perClient.set(entry.clientId, left);
  }
}
