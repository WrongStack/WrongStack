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
import type { SessionEvent, SessionWriter } from '../types/session.js';
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
  /**
   * Transcript tail poll interval. Default 500ms. Passing this explicitly
   * pins the poll to a fixed cadence; with the default, the poll relaxes to
   * {@link transcriptFallbackIntervalMs} while the per-file watcher is live
   * (the watcher streams changes within milliseconds — the poll is only a
   * safety net, and a 500ms stat loop per bridged session adds up).
   */
  transcriptIntervalMs?: number | undefined;
  /** Poll interval while the transcript fs.watch is healthy. Default 5000ms. */
  transcriptFallbackIntervalMs?: number | undefined;
  now?: (() => string) | undefined;
  /**
   * Optional session writer. When provided, the bridge subscribes to
   * the writer's `onAppend` callback to receive events directly, avoiding
   * a disk read-back of the session JSONL file. When absent, the bridge
   * falls back to polling the file via `tail()`.
   */
  writer?: SessionWriter | undefined;
}

const VALID_AGENT_STATUS = new Set<HqSessionAgentLiveStatus>([
  'idle',
  'running',
  'streaming',
  'waiting_user',
  'error',
]);
const MAX_TRANSCRIPT_BATCH_ENTRIES = 32;
const MAX_TRANSCRIPT_BATCH_BYTES = 512 * 1024;

/**
 * Mirror of `HQ_STALE_SNAPSHOT_MS` in `cli/src/hq-server/snapshot.ts`. Core
 * sits below cli in the dependency graph, so it cannot import the constant —
 * keep the two in lockstep when the eviction window moves.
 */
const HQ_STALE_SNAPSHOT_WINDOW_MS = 5 * 60_000;

/**
 * HQ evicts session snapshots not refreshed within `HQ_STALE_SNAPSHOT_MS`
 * (5 minutes, `cli/src/hq-server/snapshot.ts`). The heartbeat tick normally
 * goes through the dedup hash in `publishSnapshot`, but forces a republish at
 * this cadence so a fully idle session keeps refreshing `receivedAt` and is
 * never evicted. Derived as 80% of the eviction window — a full minute of
 * margin against missed ticks, scheduler stalls, or transient publisher
 * failures.
 */
const KEEPALIVE_REPUBLISH_MS = Math.floor(HQ_STALE_SNAPSHOT_WINDOW_MS * 0.8);

// Keep fallback JSONL reads bounded: a delayed tail must not allocate a buffer
// proportional to the entire unread transcript delta.
const TRANSCRIPT_TAIL_READ_BYTES = 64 * 1024;
// A malformed or pathological JSONL record must not defeat the block bound by
// growing the carried partial record indefinitely.
const MAX_TRANSCRIPT_TAIL_LINE_BYTES = 1024 * 1024;

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
 * Downgrade "busy" statuses whose last activity is older than the HQ stale
 * window to `idle`. A live publisher keeps republishing its last-known agent
 * list (keepalive tick, `initialAgents` after a session resume) — if the
 * terminal `agents_updated` event for a finished/crashed agent was never
 * observed, its status would otherwise stay `running` forever and the HQ
 * topology would render a ghost agent as active (F3/fleet_status read live
 * coordinator state, so they correctly show nothing). No activity for a full
 * stale window is by definition not running.
 */
function downgradeStaleAgentStatuses(
  agents: readonly HqSessionAgentSummary[],
  nowMs: number,
): HqSessionAgentSummary[] {
  const cutoff = nowMs - HQ_STALE_SNAPSHOT_WINDOW_MS;
  return agents.map((agent) => {
    // Only execution states can become ghosts. `waiting_user` is idle-ish
    // BY DESIGN (a human prompt is expected) and `error` must stay visible,
    // so neither is eligible for expiry.
    if (agent.status !== 'running' && agent.status !== 'streaming') return agent;
    const lastActivityAt = Date.parse(agent.lastActivityAt);
    if (!Number.isFinite(lastActivityAt) || lastActivityAt >= cutoff) return agent;
    return { ...agent, status: 'idle' as const };
  });
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
    (latest, agent) => (agent.lastActivityAt > latest ? agent.lastActivityAt : latest),
    startedAt,
  );
  let lastSnapshotHash = '';
  let lastPublishedAtMs = Date.now();
  let disposed = false;

  function buildSnapshot(): HqSessionSnapshotPayload {
    // Snapshot-build time is the single choke point both the keepalive tick
    // and bus updates flow through — downgrading here means a stale `running`
    // corrects itself on the next publish without waiting for a bus event.
    const effectiveAgents = downgradeStaleAgentStatuses(agents, Date.parse(now()));
    return {
      sessionId: opts.sessionId,
      clientKind: identity.kind,
      machineId: identity.machineId,
      projectId: project.projectId,
      projectName: opts.projectName ?? project.projectName,
      projectRoot: opts.projectRoot,
      status: deriveSessionStatus(effectiveAgents),
      startedAt,
      lastActivityAt,
      agentCount: effectiveAgents.length,
      agents: effectiveAgents,
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
      // Refreshed on successful publish only — a failed publish keeps the
      // keep-alive deadline armed so the next tick retries.
      lastPublishedAtMs = Date.now();
    } catch {
      /* best-effort */
    }
  }

  function publishTranscriptEntries(entries: HqTranscriptEntry[]): void {
    let batch: HqTranscriptEntry[] = [];
    let batchFromSeq = seqEmitted;

    const publishBatch = (): void => {
      if (batch.length === 0) return;
      try {
        publisher.publishTranscriptAppend({
          sessionId: opts.sessionId,
          fromSeq: batchFromSeq,
          entries: batch,
        });
      } catch {
        /* best-effort */
      }
      seqEmitted += batch.length;
      batch = [];
      batchFromSeq = seqEmitted;
    };

    for (const entry of entries) {
      const candidate = [...batch, entry];
      const candidatePayload = {
        sessionId: opts.sessionId,
        fromSeq: batchFromSeq,
        entries: candidate,
      };
      const tooManyEntries = candidate.length > MAX_TRANSCRIPT_BATCH_ENTRIES;
      const tooLarge =
        batch.length > 0 &&
        Buffer.byteLength(JSON.stringify(candidatePayload), 'utf8') > MAX_TRANSCRIPT_BATCH_BYTES;
      if (tooManyEntries || tooLarge) publishBatch();
      batch.push(entry);
    }

    publishBatch();
  }

  const offAgents = opts.events?.on('session.agents_updated', (payload) => {
    // Several trackers can share one event bus — the WebUI runs one per open
    // tab — so an update that NAMES another session is not this bridge's.
    // An unstamped update is still accepted: a host with a single tracker has
    // no session to name, and dropping those would blank its agent list.
    if (
      typeof payload.sessionId === 'string' &&
      payload.sessionId.length > 0 &&
      payload.sessionId !== opts.sessionId
    ) {
      return;
    }
    agents = payload.agents.map(toAgentSummary);
    lastActivityAt = now();
    publishSnapshot();
  });

  // Announce the terminal immediately so its node appears even before any
  // agent activity.
  publishSnapshot(true);

  // Re-announce on every reconnect. HQ holds this session in a map on the
  // SOCKET, so a reconnect hands the server a fresh client with no sessions —
  // and `publishSnapshot` dedups on content, so an idle terminal would not
  // republish until the keep-alive fired minutes later. In the meantime the
  // terminal and all of its agents are simply absent from HQ's snapshot: the
  // fleet map drops the node and pops it back when the keep-alive lands.
  const offReconnect = publisher.onConnected(() => {
    publishSnapshot(true);
  });

  // Captured so the disposer can restore it instead of permanently clearing.
  let prevOnAppend: ((event: SessionEvent) => void) | undefined;

  // ── Direct event subscription (avoids disk read-back) ──────────────────────
  //
  // When a session writer is available, subscribe to its onAppend callbacks to
  // receive events directly as they're written, instead of polling the JSONL
  // file from disk. The tail fallback is suppressed when the writer path is
  // active — the synchronous callback delivers every event before it enters
  // the write buffer, so tail() would duplicate them.
  // Subscribe directly only when the writer implements setOnAppend —
  // otherwise the optional-chained call silently no-ops and the tail
  // fallback below would also be suppressed (it's gated on the same
  // condition), producing zero transcript streaming.
  if (opts.writer?.setOnAppend) {
    // Capture any pre-existing callback (e.g. from SessionStoreOptions) so
    // the disposer can restore it instead of permanently clearing.
    prevOnAppend = opts.writer.onAppend;

    // Subscribe to onAppend which fires for both single append() calls and
    // individual events inside appendBatch(). The batch-specific callback
    // is NOT used here — subscribing to both would cause duplicate publishing
    // since appendBatch() now also triggers onAppend per-event.
    opts.writer.setOnAppend((event: SessionEvent) => {
      if (disposed) return;
      // Also invoke the previous callback if one exists — preserves the
      // call chain for any other subscriber wired at the store level.
      try {
        prevOnAppend?.(event);
      } catch {
        /* best-effort */
      }
      try {
        const entries = mapSessionEventToEntries(event as unknown as Record<string, unknown>);
        if (entries.length > 0) {
          publishTranscriptEntries(entries);
          lastActivityAt = now();
        }
      } catch {
        /* best-effort — never let the callback break the write path */
      }
    });
  }

  // seqEmitted is used by publishTranscriptEntries — must be hoisted above
  // the tail guard so the callback path can use it.
  let seqEmitted = 0;

  // Declared outside the tail guard so the disposer can reference them even
  // when the tail path is skipped (writer subscription active).
  let watcher: fs.FSWatcher | null = null;
  let tailTimer: ReturnType<typeof setTimeout> | null = null;
  const snapshotTimer = setInterval(() => {
    // Normal ticks go through the dedup hash; force only the keep-alive
    // republish so an idle session keeps refreshing HQ's `receivedAt` and
    // survives the stale-snapshot eviction.
    publishSnapshot(Date.now() - lastPublishedAtMs >= KEEPALIVE_REPUBLISH_MS);
  }, opts.snapshotIntervalMs ?? 2500);
  snapshotTimer.unref?.();

  // ── Transcript tail (only when no direct writer subscription) ──────────────
  //
  // Without a writer, fall back to polling the JSONL file via stat + read.
  // With a writer, tail() is suppressed to avoid duplicate publishing.
  if (!opts.writer?.setOnAppend) {
    let offset = 0;
    // Retain raw bytes rather than decoded text so a multi-byte UTF-8
    // character split at a block boundary is decoded only once complete.
    let partial = Buffer.alloc(0);
    let discardingOversizedLine = false;
    let tailing = false;
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
          // Drain the size observed by stat() in fixed-size blocks. `partial`
          // carries an incomplete UTF-8/JSONL line into the next block.
          while (!disposed && offset < stat.size) {
            const len = Math.min(TRANSCRIPT_TAIL_READ_BYTES, stat.size - offset);
            const buf = Buffer.allocUnsafe(len);
            const { bytesRead } = await fd.read(buf, 0, len, offset);
            if (bytesRead === 0) break;

            offset += bytesRead;
            let chunk = buf.subarray(0, bytesRead);
            if (discardingOversizedLine) {
              const newline = chunk.indexOf(0x0a);
              if (newline < 0) continue;
              chunk = chunk.subarray(newline + 1);
              discardingOversizedLine = false;
            }
            const complete = Buffer.concat([partial, chunk]);
            const lastNewline = complete.lastIndexOf(0x0a);
            if (lastNewline < 0) {
              if (complete.length > MAX_TRANSCRIPT_TAIL_LINE_BYTES) {
                partial = Buffer.alloc(0);
                discardingOversizedLine = true;
              } else {
                partial = complete;
              }
              continue;
            }

            // Decode complete JSONL records one at a time. This ensures every
            // oversized record is skipped, including one completed in this
            // block and one that follows a valid record in the same block.
            const completed = complete.subarray(0, lastNewline + 1);
            partial = complete.subarray(lastNewline + 1);
            if (partial.length > MAX_TRANSCRIPT_TAIL_LINE_BYTES) {
              partial = Buffer.alloc(0);
              discardingOversizedLine = true;
            }
            const entries: HqTranscriptEntry[] = [];
            let lineStart = 0;
            while (lineStart < completed.length) {
              const lineEnd = completed.indexOf(0x0a, lineStart);
              const line = completed.subarray(lineStart, lineEnd);
              lineStart = lineEnd + 1;
              if (line.length > MAX_TRANSCRIPT_TAIL_LINE_BYTES) continue;

              const trimmed = line.toString('utf8').trim();
              if (!trimmed) continue;
              try {
                const obj = JSON.parse(trimmed) as Record<string, unknown>;
                for (const entry of mapSessionEventToEntries(obj)) entries.push(entry);
              } catch {
                // Skip malformed JSONL records; later lines remain processable.
              }
            }
            if (entries.length > 0) {
              publishTranscriptEntries(entries);
              lastActivityAt = now();
            }
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

    const fastTailMs = opts.transcriptIntervalMs ?? 500;
    const relaxedTailMs =
      opts.transcriptFallbackIntervalMs ??
      (opts.transcriptIntervalMs !== undefined ? opts.transcriptIntervalMs : 5_000);
    function scheduleTail(): void {
      if (disposed) return;
      tailTimer = setTimeout(
        () => {
          void tail().finally(scheduleTail);
        },
        watcher ? relaxedTailMs : fastTailMs,
      );
      tailTimer.unref?.();
    }
    void tail().finally(scheduleTail);
  }

  return () => {
    if (disposed) return;
    disposed = true;
    // Unsubscribe the direct event callback, restoring any that was
    // captured from the writer before the bridge subscribed.
    if (opts.writer?.setOnAppend) {
      try {
        opts.writer.setOnAppend(prevOnAppend);
      } catch {
        /* best-effort */
      }
    }
    offAgents?.();
    offReconnect();
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
      watcher = null;
    }
    clearInterval(snapshotTimer);
    if (tailTimer) {
      clearTimeout(tailTimer);
      tailTimer = null;
    }
    try {
      publisher.publishSessionEnded({ sessionId: opts.sessionId, endedAt: now() });
    } catch {
      /* best-effort */
    }
  };
}
