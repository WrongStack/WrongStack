/**
 * SessionTelemetryBridge — streams a surface's own live session state and full
 * chat transcript to HQ over the `/ws/client` plane, so the command center can
 * render every machine → terminal → agent → full-history across all connected
 * machines (not only the one HQ runs on).
 *
 * Two streams, both best-effort and self-contained:
 *  1. `session.snapshot` — the terminal's live state + agents, sourced from the
 *     in-process `session.agents_updated` bus event (no registry file reads).
 *  2. `session.transcript` — incremental conversation turns, tailed cheaply
 *     from this process's own session JSONL by byte offset.
 *
 * @module hq/session-bridge
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { EventBus, TrackedAgentSnapshot } from '../kernel/events.js';
import { sessionScopedPath } from '../utils/session-scoped-path.js';
import { resolveWstackPaths } from '../utils/wstack-paths.js';
import type {
  HqSessionAgentLiveStatus,
  HqSessionAgentSummary,
  HqSessionLiveStatus,
  HqSessionSnapshotPayload,
  HqTranscriptEntry,
} from './protocol.js';
import type { HqPublisher } from './publisher.js';
import { mapSessionEventToEntries } from './transcript-mapper.js';

export interface SessionTelemetryBridgeOptions {
  publisher: HqPublisher;
  /** Local bus carrying `session.agents_updated`. When omitted, snapshots
   * still publish (with empty/last-known agents) and the transcript still
   * streams from disk. */
  events?: EventBus | undefined;
  sessionId: string;
  projectRoot: string;
  projectName?: string | undefined;
  /** Override the global root used to resolve the session JSONL path. */
  globalRoot?: string | undefined;
  /** Last-known agents to publish immediately before the next bus update. */
  initialAgents?: readonly TrackedAgentSnapshot[] | undefined;
  gitBranch?: string | undefined;
  startedAt?: string | undefined;
  /** Snapshot republish interval (also refreshes lastActivity). Default 2500ms. */
  snapshotIntervalMs?: number | undefined;
  /** Transcript tail poll interval. Default 1200ms. */
  transcriptIntervalMs?: number | undefined;
  now?: (() => string) | undefined;
}

const VALID_AGENT_STATUS = new Set<HqSessionAgentLiveStatus>([
  'idle',
  'running',
  'streaming',
  'waiting_user',
  'error',
]);

function toAgentSummary(a: TrackedAgentSnapshot): HqSessionAgentSummary {
  const status = (
    VALID_AGENT_STATUS.has(a.status as HqSessionAgentLiveStatus) ? a.status : 'idle'
  ) as HqSessionAgentLiveStatus;
  return {
    id: a.id,
    name: a.name,
    status,
    iterations: a.iterations,
    toolCalls: a.toolCalls,
    lastActivityAt: a.lastActivityAt,
    ...(a.startedAt !== undefined ? { startedAt: a.startedAt } : {}),
    ...(a.currentTool !== undefined ? { currentTool: a.currentTool } : {}),
    ...(a.costUsd !== undefined ? { costUsd: a.costUsd } : {}),
    ...(a.tokensIn !== undefined ? { tokensIn: a.tokensIn } : {}),
    ...(a.tokensOut !== undefined ? { tokensOut: a.tokensOut } : {}),
    ...(a.ctxPct !== undefined ? { ctxPct: a.ctxPct } : {}),
    ...(a.model !== undefined ? { model: a.model } : {}),
    ...(a.partialText !== undefined ? { partialText: a.partialText } : {}),
  };
}

function deriveSessionStatus(agents: readonly HqSessionAgentSummary[]): HqSessionLiveStatus {
  return agents.some(
    (a) => a.status === 'running' || a.status === 'streaming' || a.status === 'waiting_user',
  )
    ? 'active'
    : 'idle';
}

/**
 * Start streaming this surface's session telemetry to HQ. Returns a disposer
 * that stops both streams and publishes a final `session.ended`.
 */
export function startSessionTelemetryBridge(opts: SessionTelemetryBridgeOptions): () => void {
  const now = opts.now ?? (() => new Date().toISOString());
  const publisher = opts.publisher;
  const identity = publisher.identity;
  const project = publisher.project;
  const startedAt = opts.startedAt ?? now();

  const wpaths = resolveWstackPaths({
    projectRoot: opts.projectRoot,
    ...(opts.globalRoot !== undefined ? { globalRoot: opts.globalRoot } : {}),
  });
  const sessionFile = sessionScopedPath(wpaths.projectSessions, opts.sessionId, '.jsonl');

  let agents: HqSessionAgentSummary[] = (opts.initialAgents ?? []).map(toAgentSummary);
  let lastActivityAt = agents.reduce(
    (latest, agent) => agent.lastActivityAt > latest ? agent.lastActivityAt : latest,
    startedAt,
  );
  let lastSnapshotHash = '';
  let disposed = false;

  function buildSnapshot(): HqSessionSnapshotPayload {
    return {
      sessionId: opts.sessionId,
      clientKind: identity.kind,
      machineId: identity.machineId,
      projectId: project.projectId,
      projectName: opts.projectName ?? project.projectName,
      projectRoot: opts.projectRoot,
      status: deriveSessionStatus(agents),
      startedAt,
      lastActivityAt,
      agentCount: agents.length,
      agents,
      ...(identity.hostname !== undefined ? { hostname: identity.hostname } : {}),
      ...(identity.pid !== undefined ? { pid: identity.pid } : {}),
      ...(opts.gitBranch !== undefined ? { gitBranch: opts.gitBranch } : {}),
    };
  }

  function publishSnapshot(force = false): void {
    if (disposed) return;
    const snap = buildSnapshot();
    // Hash on everything except lastActivityAt so identical state isn't
    // republished by the heartbeat tick, but real changes always go out.
    const hash = JSON.stringify({ ...snap, lastActivityAt: '' });
    if (!force && hash === lastSnapshotHash) return;
    lastSnapshotHash = hash;
    try {
      publisher.publishSessionSnapshot(snap);
    } catch {
      /* best-effort */
    }
  }

  const offAgents = opts.events?.on('session.agents_updated', (payload) => {
    agents = payload.agents.map(toAgentSummary);
    lastActivityAt = now();
    publishSnapshot();
  });

  // Announce the terminal immediately so its node appears even before any
  // agent activity.
  publishSnapshot(true);

  // ── Transcript tail ───────────────────────────────────────────────────────
  let offset = 0;
  let partial = '';
  let seqEmitted = 0;
  let tailing = false;
  let watcher: fs.FSWatcher | null = null;
  let watchPending = false;

  // Once the session file exists, watch it so new turns are streamed within
  // milliseconds of being written — the interval poll is only a safety net.
  function setupWatcher(): void {
    if (disposed || watcher) return;
    try {
      const nextWatcher = fs.watch(sessionFile, () => {
        if (watchPending || disposed) return;
        watchPending = true;
        setTimeout(() => {
          watchPending = false;
          void tail();
        }, 25);
      });
      // fs.watch surfaces transient failures (EPERM/ENOENT on rename/delete,
      // common on Windows) as async 'error' events — swallow them so they
      // never become uncaught exceptions. The interval poll keeps us live.
      nextWatcher.on('error', () => {
        try {
          nextWatcher.close();
        } catch {
          /* ignore */
        }
        if (watcher === nextWatcher) watcher = null;
      });
      watcher = nextWatcher;
    } catch {
      watcher = null;
    }
  }

  async function tail(): Promise<void> {
    if (disposed || tailing) return;
    tailing = true;
    try {
      const stat = await fsp.stat(sessionFile).catch(() => null);
      if (disposed) return;
      if (!stat) return;
      setupWatcher();
      if (stat.size <= offset) return;
      const fd = await fsp.open(sessionFile, 'r');
      try {
        if (disposed) return;
        const len = stat.size - offset;
        const buf = Buffer.allocUnsafe(len);
        await fd.read(buf, 0, len, offset);
        offset = stat.size;
        partial += buf.toString('utf8');
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';
        const entries: HqTranscriptEntry[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }
          for (const entry of mapSessionEventToEntries(obj)) entries.push(entry);
        }
        if (entries.length > 0) {
          try {
            publisher.publishTranscriptAppend({
              sessionId: opts.sessionId,
              fromSeq: seqEmitted,
              entries,
            });
          } catch {
            /* best-effort */
          }
          seqEmitted += entries.length;
          lastActivityAt = now();
        }
      } finally {
        await fd.close();
      }
    } catch {
      /* best-effort */
    } finally {
      tailing = false;
    }
  }

  const snapshotTimer = setInterval(() => publishSnapshot(true), opts.snapshotIntervalMs ?? 2500);
  const tailTimer = setInterval(() => void tail(), opts.transcriptIntervalMs ?? 500);
  snapshotTimer.unref?.();
  tailTimer.unref?.();
  void tail();

  return () => {
    if (disposed) return;
    disposed = true;
    offAgents?.();
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
      watcher = null;
    }
    clearInterval(snapshotTimer);
    clearInterval(tailTimer);
    try {
      publisher.publishSessionEnded({ sessionId: opts.sessionId, endedAt: now() });
    } catch {
      /* best-effort */
    }
  };
}
