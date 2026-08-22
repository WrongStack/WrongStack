import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionEvent } from '../types/session.js';
import { isSessionTranscriptFileName, sessionScopedPath } from '../utils/session-scoped-path.js';
import { resolveSessionId, sessionIdResolutionError } from './session-id-resolver.js';
import { collectSessionIds } from './session-store/directory-session-files.js';
/**
 * Idea #1 from IDEAS.md — Stateful Session Recovery.
 *
 * `SessionRecovery` is the read-side companion to the in-flight
 * marker mechanism. When the agent loop is running, it writes an
 * `in_flight_start` event at the current point in the log. On
 * clean shutdown, a matching `in_flight_end` follows. Provider and
 * tool events may legitimately appear after the start marker, so
 * recovery finds the latest lifecycle boundary rather than assuming
 * the marker is literally the last JSONL record.
 *
 * Detection is diagnostic only. Normal session resume reconstructs the
 * conversation by replaying persisted JSONL events; it must not blindly
 * re-execute tool calls after a crash. `recover()` exposes the tail after the
 * last checkpoint so callers can explain which persisted work was in flight.
 *
 * Concurrency: pure read; no writes. Safe to call from multiple
 * processes simultaneously.
 */
export interface StaleSession {
  sessionId: string;
  /** Path to the JSONL log. */
  path: string;
  /** Last event ts (the in_flight_start timestamp). */
  lastEventTs: string;
  /** Context the agent was working on when it died. */
  context: string;
  /** Total events in the log. */
  eventCount: number;
}

export interface RecoveryPlan {
  sessionId: string;
  /** True if the session is stale (has a dangling in_flight_start). */
  stale: boolean;
  /** The last `checkpoint` event before the un-replayed work, or null. */
  lastCheckpoint: SessionEvent | null;
  /** All persisted events after the last checkpoint (diagnostic in-flight tail). */
  pendingEvents: SessionEvent[];
  /** The dangling in_flight_start event, if any. */
  inFlightStart: SessionEvent | null;
  /** Free-form context the agent was working on, if any. */
  context: string | null;
}

export interface InterruptedToolDetail {
  /** Tool_use id — lets callers synthesize a matching error tool_result. */
  id?: string | undefined;
  name: string;
  argsSummary?: string | undefined;
  ts?: string | undefined;
}

/**
 * Extracts any unresolved tool calls from a recovery plan's pending events.
 */
export function extractInterruptedTools(plan: RecoveryPlan): InterruptedToolDetail[] {
  const tools: InterruptedToolDetail[] = [];
  const openCalls = new Map<
    string,
    { id?: string | undefined; name: string; args?: unknown; ts?: string }
  >();
  // Id-less calls cannot share a map key (the coalesced name would collapse
  // N distinct interrupted calls into one); suffix them so each keeps its
  // own slot. Their stored id stays undefined — consumers must not synthesize
  // results for them, but the crash notice still counts each individually.
  let anonymousSeq = 0;

  for (const ev of plan.pendingEvents) {
    if (
      (ev.type === 'tool_use' || ev.type === 'tool_call_start') &&
      typeof (ev as { name?: string }).name === 'string'
    ) {
      const toolName = (ev as { name: string }).name;
      // Deliberate coalescing (NOT the #seq scheme used by the content-block
      // sites below): legacy id-less top-level tool_use events are keyed by
      // bare toolName so their id-less tool_results can still resolve and
      // delete them via the name-fallback deletion path below. Suffixing here
      // would strand those entries as permanently "interrupted".
      const rawId = (ev as { id?: string }).id;
      const callId = rawId ?? toolName;
      openCalls.set(callId, {
        id: rawId,
        name: toolName,
        args:
          (ev as { input?: unknown; args?: unknown }).input ??
          (ev as { input?: unknown; args?: unknown }).args,
        ts: ev.ts,
      });
    } else if (ev.type === 'tool_result' || ev.type === 'tool_call_end') {
      const callId =
        (ev as { id?: string; toolUseId?: string; name?: string }).id ??
        (ev as { id?: string; toolUseId?: string; name?: string }).toolUseId ??
        (ev as { id?: string; toolUseId?: string; name?: string }).name;
      if (callId) openCalls.delete(callId);
    } else if (
      ev.type === 'llm_response' &&
      Array.isArray((ev as { content?: unknown[] }).content)
    ) {
      for (const block of (
        ev as {
          content: Array<{
            type?: string;
            id?: string;
            name?: string;
            input?: unknown;
          }>;
        }
      ).content) {
        if (block && block.type === 'tool_use' && typeof block.name === 'string') {
          // Raw id (possibly undefined) — same contract as site 1 above.
          const rawId = block.id;
          const callId = rawId ?? `${block.name}#${++anonymousSeq}`;
          openCalls.set(callId, {
            id: rawId,
            name: block.name,
            args: block.input,
            ts: ev.ts,
          });
        }
      }
    } else if (
      ev.type === 'message_appended' &&
      (ev as { message?: { role?: string; content?: unknown } }).message
    ) {
      const msg = (ev as { message: { role?: string; content?: unknown } }).message;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as Array<{
          type?: string;
          id?: string;
          name?: string;
          input?: unknown;
          tool_use_id?: string;
        }>) {
          if (block && block.type === 'tool_use' && typeof block.name === 'string') {
            // Raw id (possibly undefined) — see site 1 note above.
            const rawId = block.id;
            const callId = rawId ?? `${block.name}#${++anonymousSeq}`;
            openCalls.set(callId, {
              id: rawId,
              name: block.name,
              args: block.input,
              ts: ev.ts,
            });
          } else if (block && block.type === 'tool_result') {
            const callId = block.tool_use_id ?? block.id;
            if (callId) openCalls.delete(callId);
          }
        }
      }
    }
  }

  for (const call of openCalls.values()) {
    let argsSummary: string | undefined;
    if (call.args && typeof call.args === 'object') {
      try {
        const str = JSON.stringify(call.args);
        argsSummary = str.length > 80 ? `${str.slice(0, 77)}...` : str;
      } catch {
        // ignore JSON serialization failure
      }
    }
    tools.push({
      id: call.id,
      name: call.name,
      argsSummary,
      ts: call.ts,
    });
  }

  return tools;
}

/**
 * Result of `SessionRecovery.recover(sessionId)`. Distinct from
 * `StaleSession`: a session is "stale" if its latest lifecycle
 * boundary is an open marker, but a "recovery plan" can also be generated for
 * clean sessions whose last checkpoint is older than the
 * conversation history (e.g. a user-initiated "rewind to last
 * good state" flow). This is a diagnostic plan, not authorization to replay
 * external side effects.
 */
export class SessionRecovery {
  private static readonly MAX_PENDING_EVENTS = 10_000;
  private static readonly MAX_PENDING_BYTES = 16 * 1024 * 1024;

  /**
   * Build a recovery plan from ALREADY-LOADED events without touching disk.
   * executeResumeSession uses this because load() has already paid for the
   * transcript read; recover()'s file scan would duplicate it.
   */
  static buildRecoveryPlan(
    events: readonly SessionEvent[],
    /** Canonical session id — threaded through so RecoveryPlan stays complete. */
    sessionId: string,
  ): RecoveryPlan {
    const pendingEvents: SessionEvent[] = [];
    const pendingSizes: number[] = [];
    let pendingBytes = 0;
    let lastCheckpoint: SessionEvent | null = null;
    let latestBoundary: LifecycleBoundary | null = null;
    for (const event of events) {
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') continue;
      if (event.type === 'checkpoint') {
        lastCheckpoint = event;
        pendingEvents.length = 0;
        pendingSizes.length = 0;
        pendingBytes = 0;
        continue;
      }
      // Capture the lifecycle marker BEFORE budget eviction can drop it — an
      // in_flight_start at the very tail is what justifies the recovery path.
      // Mirrors recover(): boundaries are ALWAYS observed, even when the
      // event itself is oversized and skipped from the pending tail.
      if (isLifecycleBoundary(event)) latestBoundary = event;
      // Same budget contract as recover(): cap the post-checkpoint tail at
      // MAX_PENDING_EVENTS / MAX_PENDING_BYTES, evicting oldest-first. A
      // single oversized event is skipped outright — otherwise the eviction
      // loop below could never satisfy its budget condition.
      const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
      if (bytes > SessionRecovery.MAX_PENDING_BYTES) continue;
      while (
        pendingEvents.length >= SessionRecovery.MAX_PENDING_EVENTS ||
        pendingBytes + bytes > SessionRecovery.MAX_PENDING_BYTES
      ) {
        pendingBytes -= pendingSizes.shift()!;
        pendingEvents.shift();
      }
      pendingEvents.push(event);
      pendingSizes.push(bytes);
      pendingBytes += bytes;
    }
    const inFlightStart =
      latestBoundary?.type === 'in_flight_start' ? latestBoundary : null;
    return {
      sessionId,
      stale: inFlightStart !== null,
      lastCheckpoint,
      pendingEvents,
      inFlightStart,
      context: inFlightStart?.context ?? null,
    };
  }
  /**
   * Scan a session log and return a `StaleSession` if and only if the newest
   * lifecycle boundary is an `in_flight_start` without a later
   * `in_flight_end`/`session_end`. Ordinary provider/tool events after the
   * marker do not make the session clean. Returns `null` when:
   *   - the log does not exist;
   *   - the log is empty;
   *   - the latest lifecycle boundary is `in_flight_end` or `session_end`;
   *   - there is no lifecycle boundary (legacy/pre-marker log).
   *
   * The reverse scanner is chunked and line-aware. It can cross arbitrarily
   * large JSONL records (for example a large tool result) without imposing a
   * fixed tail-size correctness limit. Clean logs normally return after the
   * first chunk; stale logs continue counting lines so `eventCount` remains
   * the documented total rather than a tail-only approximation.
   */
  async resolveId(query: string): Promise<string> {
    const resolution = resolveSessionId(query, await collectSessionIds(this.dir));
    if (resolution.status === 'resolved') return resolution.id;
    if (resolution.status === 'missing') return resolution.query;
    throw sessionIdResolutionError(resolution);
  }

  async detectStale(sessionId: string): Promise<StaleSession | null> {
    const canonicalId = await this.resolveId(sessionId);
    return this.detectStaleExact(canonicalId);
  }

  private async detectStaleExact(sessionId: string): Promise<StaleSession | null> {
    const fp = this.filePath(sessionId);
    let stat;
    try {
      stat = await fs.stat(fp);
    } catch {
      // Any stat failure means the session is not resumable.
      /* v8 ignore next -- defensive */
      return null;
    }
    if (stat.size === 0) return null;

    try {
      const scan = await scanLatestLifecycleBoundary(fp, stat.size);
      if (scan?.boundary.type !== 'in_flight_start') return null;
      return {
        sessionId,
        path: fp,
        lastEventTs: scan.boundary.ts,
        context: scan.boundary.context,
        eventCount: scan.eventCount,
      };
      /* v8 ignore start -- defensive: reverse scan failure after a successful stat is rare */
    } catch {
      return null;
    }
    /* v8 ignore stop */
  }

  /**
   * Generate a recovery plan for a session. The plan describes
   * the persisted tail after the last checkpoint, plus the dangling in-flight
   * marker if present. SessionStore.resume() independently reconstructs state
   * from the journal and does not re-run these events as commands.
   *
   * Returns a non-null plan for ANY session that has at least
   * one event after a checkpoint (or, for legacy sessions, at
   * least one event). Pure read; no mutation.
   */
  async recover(sessionId: string): Promise<RecoveryPlan | null> {
    const canonicalId = await this.resolveId(sessionId);
    const fp = this.filePath(canonicalId);
    const pendingEvents: SessionEvent[] = [];
    const pendingSizes: number[] = [];
    let pendingBytes = 0;
    let lastCheckpoint: SessionEvent | null = null;
    let latestBoundary: LifecycleBoundary | null = null;
    let sawEvent = false;
    const stream = createReadStream(fp, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let event: SessionEvent;
        try {
          event = JSON.parse(line) as SessionEvent;
        } catch {
          continue;
        }
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') continue;
        sawEvent = true;
        if (event.type === 'checkpoint') {
          lastCheckpoint = event;
          pendingEvents.length = 0;
          pendingSizes.length = 0;
          pendingBytes = 0;
        } else {
          const bytes = Buffer.byteLength(line, 'utf8');
          if (bytes <= SessionRecovery.MAX_PENDING_BYTES) {
            while (
              pendingEvents.length >= SessionRecovery.MAX_PENDING_EVENTS ||
              pendingBytes + bytes > SessionRecovery.MAX_PENDING_BYTES
            ) {
              pendingEvents.shift();
              pendingBytes = Math.max(0, pendingBytes - (pendingSizes.shift()!));
            }
            pendingEvents.push(event);
            pendingSizes.push(bytes);
            pendingBytes += bytes;
          }
        }
        if (isLifecycleBoundary(event)) latestBoundary = event;
      }
    } catch {
      // Stream read failure means we cannot recover this session.
      /* v8 ignore next -- defensive */
      return null;
    } finally {
      lines.close();
      stream.close();
    }
    if (!sawEvent) return null;
    // The dangling in_flight_start, if it is the newest lifecycle boundary.
    // Provider/tool events may follow the marker and are still pending work.
    const inFlightStart = latestBoundary?.type === 'in_flight_start' ? latestBoundary : null;
    const context =
      inFlightStart && inFlightStart.type === 'in_flight_start' ? inFlightStart.context : null;
    return {
      sessionId: canonicalId,
      stale: inFlightStart !== null,
      lastCheckpoint,
      pendingEvents,
      inFlightStart,
      context,
    };
  }

  /**
   * List every stale session in a directory. Returns an array
   * (possibly empty) sorted by `lastEventTs` descending — most
   * recent crash first.
   */
  async listResumable(): Promise<StaleSession[]> {
    const out: StaleSession[] = [];
    // Modern sessions live inside date-shard subdirectories
    // ("2026-06-11/<base>.jsonl"); legacy/flat sessions sit at the root.
    // Scan both — a root-only scan silently misses every modern crash.
    const collect = async (dir: string, prefix: string, depth: number): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
        /* v8 ignore start -- defensive: the sessions dir (and its shards) are readable during a scan */
      } catch {
        return;
      }
      /* v8 ignore stop */
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'shared' || entry.name === 'subagents' || entry.name === 'attachments')
          continue;
        if (entry.isDirectory()) {
          if (depth === 0) {
            await collect(path.join(dir, entry.name), entry.name, depth + 1);
          }
          continue;
        }
        if (!entry.isFile() || !isSessionTranscriptFileName(entry.name)) continue;
        const base = entry.name.slice(0, -'.jsonl'.length);
        const sessionId = prefix ? `${prefix}/${base}` : base;
        const stale = await this.detectStaleExact(sessionId);
        if (stale) out.push(stale);
      }
    };
    await collect(this.dir, '', 0);
    return out.sort((a, b) => b.lastEventTs.localeCompare(a.lastEventTs));
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private filePath(sessionId: string): string {
    // Containment-checked: date-sharded ids ("2026-06-11/<base>") are
    // legitimate; traversal is rejected. Shared with the other per-session
    // sidecar stores so the contract can't drift.
    return sessionScopedPath(this.dir, sessionId, '.jsonl');
  }

  constructor(private readonly dir: string) {}
}

type LifecycleBoundary = Extract<
  SessionEvent,
  { type: 'in_flight_start' | 'in_flight_end' | 'session_end' }
>;

function isLifecycleBoundary(event: SessionEvent): event is LifecycleBoundary {
  return (
    event.type === 'in_flight_start' ||
    event.type === 'in_flight_end' ||
    event.type === 'session_end'
  );
}

function parseLifecycleBoundary(line: Buffer): LifecycleBoundary | null {
  try {
    const parsed = JSON.parse(line.toString('utf8')) as SessionEvent;
    return isLifecycleBoundary(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasNonWhitespace(line: Buffer): boolean {
  for (const byte of line) {
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) return true;
  }
  return false;
}

/**
 * Walk JSONL records newest-first without decoding partial UTF-8 chunks. A
 * record split across chunks is retained as bytes and decoded only after its
 * opening newline is found, so large/non-ASCII tool results cannot hide the
 * lifecycle marker immediately before them.
 */
async function scanLatestLifecycleBoundary(
  filePath: string,
  size: number,
): Promise<{ boundary: LifecycleBoundary; eventCount: number } | null> {
  const CHUNK_SIZE = 64 * 1024;
  const handle = await fs.open(filePath, 'r');
  let position = size;
  let laterLineFragment = Buffer.alloc(0);
  let latestBoundary: LifecycleBoundary | null = null;
  let eventCount = 0;

  const observeLine = (line: Buffer): LifecycleBoundary | null => {
    if (!hasNonWhitespace(line)) return null;
    eventCount++;
    return parseLifecycleBoundary(line);
  };

  try {
    while (position > 0) {
      const length = Math.min(CHUNK_SIZE, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      const data = Buffer.concat([chunk.subarray(0, bytesRead), laterLineFragment]);

      let lineEnd = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue;
        const boundary = observeLine(data.subarray(i + 1, lineEnd));
        if (!latestBoundary && boundary) latestBoundary = boundary;
        lineEnd = i;
      }
      laterLineFragment = data.subarray(0, lineEnd);

      // A clean boundary needs no exact event count because no StaleSession is
      // returned. The common clean path therefore remains a one-chunk read.
      if (latestBoundary && latestBoundary.type !== 'in_flight_start') {
        return { boundary: latestBoundary, eventCount };
      }
    }

    const boundary = observeLine(laterLineFragment);
    if (!latestBoundary && boundary) latestBoundary = boundary;
    return latestBoundary ? { boundary: latestBoundary, eventCount } : null;
  } finally {
    await handle.close();
  }
}
