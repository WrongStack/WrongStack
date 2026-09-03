import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionEvent } from '../types/session.js';
import {
  isColdSessionTranscriptFileName,
  isSessionTranscriptFileName,
  sessionScopedPath,
  stripSessionTranscriptExtension,
} from '../utils/session-scoped-path.js';
import { resolveSessionId, sessionIdResolutionError } from './session-id-resolver.js';
import { collectSessionIds } from './session-store/directory-session-files.js';
import { createTranscriptLineReader, isGzipTranscriptPath } from './session-store/transcript-io.js';
import { locateTranscript, locateTranscriptSync } from './session-store/transcript-location.js';
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

/**
 * A session whose journal has no trailing `session_end`.
 *
 * Broader than {@link StaleSession} on purpose. `StaleSession` answers "did a
 * process die *mid-iteration*", which needs a dangling `in_flight_start`. But a
 * host killed while the agent was idle — waiting for the next prompt — closes
 * its last turn with `in_flight_end` and then simply stops writing. Such a
 * session is every bit as unfinished, and matching only on `in_flight_start`
 * made exactly the common case (close the terminal, kill the daemon, reboot)
 * invisible to recovery.
 *
 * Detection is a tail scan for the newest lifecycle boundary:
 *   - `session_end`            -> closed, not reported
 *   - `in_flight_start`        -> unclosed AND stale (died mid-iteration)
 *   - `in_flight_end` / none   -> unclosed, not stale (died between turns)
 */
export interface UnclosedSession {
  sessionId: string;
  /** Path to the JSONL log. */
  path: string;
  /** Newest lifecycle boundary, or null for a journal that has none. */
  lastBoundary: 'in_flight_start' | 'in_flight_end' | null;
  /** Boundary timestamp when there is one, else the file's mtime as ISO. */
  lastEventTs: string;
  /** True when the newest boundary is a dangling `in_flight_start`. */
  stale: boolean;
  /** File mtime in ms — the ordering key, since a boundary-less log has no ts. */
  modifiedAt: number;
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
    const inFlightStart = latestBoundary?.type === 'in_flight_start' ? latestBoundary : null;
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
    const fp = (await locateTranscript(this.dir, sessionId))?.filePath ?? this.filePath(sessionId);
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
    const located = await locateTranscript(this.dir, canonicalId);
    const fp = located?.filePath ?? this.filePath(canonicalId);
    const pendingEvents: SessionEvent[] = [];
    const pendingSizes: number[] = [];
    let pendingBytes = 0;
    let lastCheckpoint: SessionEvent | null = null;
    let latestBoundary: LifecycleBoundary | null = null;
    let sawEvent = false;
    const reader = createTranscriptLineReader(fp);
    try {
      for await (const line of reader.lines) {
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
              pendingBytes = Math.max(0, pendingBytes - pendingSizes.shift()!);
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
      reader.close();
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
    for (const { sessionId } of await this.collectTranscripts()) {
      const stale = await this.detectStaleExact(sessionId);
      if (stale) out.push(stale);
    }
    return out.sort((a, b) => b.lastEventTs.localeCompare(a.lastEventTs));
  }

  /**
   * List every session whose journal has no trailing `session_end`, newest
   * file first. This is the read side of "recovery" as a user means it: the
   * conversations a crash, a `kill`, or a closed laptop lid left hanging.
   *
   * Ordering is by file mtime, not by boundary timestamp: a journal with no
   * lifecycle boundary at all (a session that never completed a turn) has no
   * timestamp to sort on, and mtime is the one key every candidate has.
   *
   * @param options.limit Stop after this many unclosed sessions are found.
   *   Candidates are examined newest-mtime-first, so the cap keeps the common
   *   "give me the last one" call to a couple of tail reads instead of a scan
   *   of every transcript the project ever wrote.
   */
  async listUnclosed(options: { limit?: number } = {}): Promise<UnclosedSession[]> {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    if (limit <= 0) return [];
    const candidates = await this.collectTranscripts();
    // Newest file first — the cap below is only meaningful against this order.
    candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
    const out: UnclosedSession[] = [];
    for (const candidate of candidates) {
      if (out.length >= limit) break;
      const unclosed = await this.detectUnclosedExact(candidate);
      if (unclosed) out.push(unclosed);
    }
    return out;
  }

  private async detectUnclosedExact(
    candidate: TranscriptCandidate,
  ): Promise<UnclosedSession | null> {
    if (candidate.size === 0) return null;
    let boundary: LifecycleBoundary | null;
    try {
      boundary = await scanLatestLifecycleBoundary(candidate.path, candidate.size, {
        countEvents: false,
      }).then((scan) => scan?.boundary ?? null);
      /* v8 ignore start -- defensive: reverse scan failure after a successful stat is rare */
    } catch {
      return null;
    }
    /* v8 ignore stop */
    if (boundary?.type === 'session_end') return null;
    return {
      sessionId: candidate.sessionId,
      path: candidate.path,
      lastBoundary: boundary ? boundary.type : null,
      lastEventTs: boundary ? boundary.ts : new Date(candidate.modifiedAt).toISOString(),
      stale: boundary?.type === 'in_flight_start',
      modifiedAt: candidate.modifiedAt,
    };
  }

  /**
   * Every session transcript under `dir`, with the stat both scanners need.
   *
   * Modern sessions live inside date-shard subdirectories
   * ("2026-06-11/<base>.jsonl"); legacy/flat sessions sit at the root. Scan
   * both — a root-only scan silently misses every modern crash.
   */
  private async collectTranscripts(): Promise<TranscriptCandidate[]> {
    const out = new Map<string, TranscriptCandidate>();
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
        const base = stripSessionTranscriptExtension(entry.name);
        const sessionId = prefix ? `${prefix}/${base}` : base;
        const fp = path.join(dir, entry.name);
        let stat: Awaited<ReturnType<typeof fs.stat>>;
        try {
          stat = await fs.stat(fp);
          /* v8 ignore start -- defensive: the file was just listed by readdir */
        } catch {
          continue;
        }
        /* v8 ignore stop */
        const next = { sessionId, path: fp, size: stat.size, modifiedAt: stat.mtimeMs };
        const existing = out.get(sessionId);
        if (!existing || !isColdSessionTranscriptFileName(fp)) out.set(sessionId, next);
      }
    };
    await collect(this.dir, '', 0);
    return [...out.values()];
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private filePath(sessionId: string): string {
    // Containment-checked: date-sharded ids ("2026-06-11/<base>") are
    // legitimate; traversal is rejected. Shared with the other per-session
    // sidecar stores so the contract can't drift.
    return (
      locateTranscriptSync(this.dir, sessionId)?.filePath ??
      sessionScopedPath(this.dir, sessionId, '.jsonl')
    );
  }

  constructor(private readonly dir: string) {}
}

interface TranscriptCandidate {
  sessionId: string;
  path: string;
  size: number;
  modifiedAt: number;
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

async function scanLatestLifecycleBoundaryForward(
  filePath: string,
  countEvents: boolean,
): Promise<{ boundary: LifecycleBoundary; eventCount: number } | null> {
  const reader = createTranscriptLineReader(filePath);
  let latestBoundary: LifecycleBoundary | null = null;
  let eventCount = 0;
  try {
    for await (const line of reader.lines) {
      if (!line.trim()) continue;
      eventCount++;
      const boundary = parseLifecycleBoundary(Buffer.from(line));
      if (boundary) latestBoundary = boundary;
    }
  } finally {
    reader.close();
  }
  if (!latestBoundary) return null;
  return { boundary: latestBoundary, eventCount: countEvents ? eventCount : 0 };
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
  options: { countEvents?: boolean } = {},
): Promise<{ boundary: LifecycleBoundary; eventCount: number } | null> {
  // `listResumable` documents `eventCount` as the log's TOTAL, which is why a
  // dangling `in_flight_start` keeps reading to byte 0. `listUnclosed` only
  // needs to know WHICH boundary is newest, so it opts out and stops at the
  // first one found — otherwise every unclosed multi-hundred-MB transcript
  // would be read end to end just to answer a yes/no question.
  const countEvents = options.countEvents !== false;
  if (isGzipTranscriptPath(filePath)) {
    return scanLatestLifecycleBoundaryForward(filePath, countEvents);
  }
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
      if (latestBoundary && (!countEvents || latestBoundary.type !== 'in_flight_start')) {
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
