/**
 * Sessions that ended — what ran, where, for how long, at what cost.
 *
 * The live snapshot only knows open sessions: one that finished vanished from
 * HQ within seconds, so "what did LAB-02 do overnight?" had no answer short of
 * reading the raw event log. The history watches each snapshot, and when a
 * session it saw leaves the live set, appends its final figures to
 * `<dataDir>/session-history.jsonl` (rotated) and keeps the newest in memory.
 *
 * A session leaves because its terminal said so (`session.ended`) or because
 * HQ lost it (the client disconnected or stopped reporting) — the entry says
 * which, since the second can mean a crash.
 *
 * @module hq/persistence/session-history
 */
import type { HqSessionSnapshotPayload, HqSnapshot } from '../protocol.js';
import { hqMachineKey } from './machine-roster.js';
import { HqSimpleLog } from './simple-log.js';

/** One finished session. */
export interface HqSessionHistoryEntry {
  sessionId: string;
  projectId: string;
  projectName: string;
  /** Hostname-first machine key, as the snapshot groups machines. */
  machineKey: string;
  hostname?: string;
  clientKind: string;
  clientVersion?: string;
  gitBranch?: string;
  startedAt: string;
  /** Last activity HQ saw. */
  lastActivityAt: string;
  /** When HQ noticed it was gone. */
  endedAt: string;
  /** `ended`: the terminal reported it; `lost`: it stopped reporting. */
  outcome: 'ended' | 'lost';
  /** Status in the last snapshot before it left. */
  lastStatus: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  /** Agents that took part, the leader included. */
  agents: number;
  /** Models those agents ran on. */
  models: string[];
}

export interface HqSessionHistoryQuery {
  projectId?: string | undefined;
  machineKey?: string | undefined;
  limit?: number | undefined;
}

const MEMORY_LIMIT = 2_000;
const MAX_TRACKED = 5_000;
/** How long a `session.ended` notice is remembered while the snapshot catches up. */
const ENDED_NOTICE_MS = 5 * 60_000;

function sum(values: readonly (number | undefined)[]): number {
  return values.reduce<number>(
    (total, value) => total + (Number.isFinite(value) ? (value as number) : 0),
    0,
  );
}

function entryOf(
  session: HqSessionSnapshotPayload,
  outcome: HqSessionHistoryEntry['outcome'],
  endedAt: string,
): HqSessionHistoryEntry {
  const models = [
    ...new Set(
      session.agents.map((agent) => agent.model).filter((model): model is string => !!model),
    ),
  ];
  return {
    sessionId: session.sessionId,
    projectId: session.projectId,
    projectName: session.projectName || session.projectId,
    machineKey: hqMachineKey(session.hostname, session.machineId),
    ...(session.hostname ? { hostname: session.hostname } : {}),
    clientKind: session.clientKind,
    ...(session.clientVersion ? { clientVersion: session.clientVersion } : {}),
    ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    endedAt,
    outcome,
    lastStatus: session.status,
    costUsd: sum(session.agents.map((agent) => agent.costUsd)),
    tokensIn: sum(session.agents.map((agent) => agent.tokensIn)),
    tokensOut: sum(session.agents.map((agent) => agent.tokensOut)),
    toolCalls: sum(session.agents.map((agent) => agent.toolCalls)),
    agents: session.agents.length,
    models: models.slice(0, 10),
  };
}

function isEntry(value: unknown): value is HqSessionHistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.sessionId === 'string' &&
    typeof entry.projectId === 'string' &&
    typeof entry.machineKey === 'string' &&
    typeof entry.endedAt === 'string' &&
    (entry.outcome === 'ended' || entry.outcome === 'lost')
  );
}

export class HqSessionHistory {
  private readonly log: HqSimpleLog<HqSessionHistoryEntry>;
  /** Newest last. */
  private readonly recentEntries: HqSessionHistoryEntry[] = [];
  /** Sessions in the last snapshot, with their latest figures. */
  private live = new Map<string, HqSessionSnapshotPayload>();
  /** sessionId → when its terminal reported the end. */
  private readonly endedNotices = new Map<string, number>();

  constructor(opts: { dataDir: string }) {
    this.log = new HqSimpleLog<HqSessionHistoryEntry>({
      dataDir: opts.dataDir,
      filename: 'session-history.jsonl',
      maxLines: 10_000,
      rotateKeep: 5_000,
      readLimit: MEMORY_LIMIT,
    });
  }

  /** Seed the in-memory window from disk. */
  async load(): Promise<void> {
    const prior = (await this.log.readAll().catch(() => [])).filter(isEntry);
    // Entries recorded before the load finished are newer: keep them last.
    this.recentEntries.unshift(...prior.slice(-MEMORY_LIMIT));
    this.trim();
  }

  /** A terminal reported `session.ended`. */
  noteEnded(sessionId: string, now: number = Date.now()): void {
    this.endedNotices.set(sessionId, now);
    if (this.endedNotices.size > MAX_TRACKED) {
      const oldest = this.endedNotices.keys().next().value;
      if (oldest !== undefined) this.endedNotices.delete(oldest);
    }
  }

  /** Fold a snapshot in; sessions that left the live set become history. */
  observe(snapshot: HqSnapshot, now: number = Date.now()): void {
    const next = new Map<string, HqSessionSnapshotPayload>();
    for (const session of snapshot.liveSessions ?? []) {
      if (next.size >= MAX_TRACKED) break;
      next.set(session.sessionId, session);
    }
    const endedAt = new Date(now).toISOString();
    for (const [sessionId, session] of this.live) {
      if (next.has(sessionId)) continue;
      const noticed = this.endedNotices.get(sessionId);
      this.endedNotices.delete(sessionId);
      const entry = entryOf(
        session,
        noticed !== undefined && now - noticed < ENDED_NOTICE_MS ? 'ended' : 'lost',
        endedAt,
      );
      this.recentEntries.push(entry);
      this.log.append(entry);
    }
    this.trim();
    this.live = next;
    for (const [sessionId, at] of this.endedNotices) {
      if (now - at >= ENDED_NOTICE_MS) this.endedNotices.delete(sessionId);
    }
  }

  /** Newest first, optionally narrowed to a project or a machine. */
  recent(query: HqSessionHistoryQuery = {}): HqSessionHistoryEntry[] {
    const limit = Math.min(MEMORY_LIMIT, Math.max(1, Math.floor(query.limit ?? 200)));
    const out: HqSessionHistoryEntry[] = [];
    for (let i = this.recentEntries.length - 1; i >= 0 && out.length < limit; i--) {
      const entry = this.recentEntries[i]!;
      if (query.projectId !== undefined && entry.projectId !== query.projectId) continue;
      if (query.machineKey !== undefined && entry.machineKey !== query.machineKey) continue;
      out.push(entry);
    }
    return out;
  }

  async drain(): Promise<void> {
    await this.log.drain();
  }

  private trim(): void {
    if (this.recentEntries.length > MEMORY_LIMIT) {
      this.recentEntries.splice(0, this.recentEntries.length - MEMORY_LIMIT);
    }
  }
}
