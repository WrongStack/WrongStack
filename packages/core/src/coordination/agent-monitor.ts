/**
 * AgentMonitorService — central hub for subagent monitoring and virtual chat history.
 *
 * Listens to FleetBus events for all subagents, maintains per-subagent virtual
 * chat transcripts (in-memory ring buffer + JSONL on disk), emits timeline events
 * for the TUI/WebUI, and streams to HQ when connected.
 *
 * Subagents get their own "conversation history" even though they share the
 * parent agent's context. This enables:
 *   - `/agents stream on` — inline agent conversation timeline in the main chat
 *   - HQ dashboard — real-time per-agent transcript viewing
 *   - File-based audit trail — each subagent's full JSONL transcript on disk
 */
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { EventBus } from '../kernel/events.js';
import { SECRET_FILE_MODE } from '../security/file-permissions.js';
import { expectDefined } from '../utils/expect-defined.js';
import type { FleetBus } from './fleet-bus.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface AgentTimelineEntry {
  /** Unique entry id (ULID or timestamp-based). */
  id: string;
  /** Subagent id this entry belongs to. */
  subagentId: string;
  /** Human-readable agent name/role. */
  agentName: string;
  /** ISO 8601 timestamp. */
  ts: string;
  /** Content type. */
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'status' | 'system';
  /** The message content (text, tool summary, error message, status text). */
  content: string;
  /** Iteration index within the subagent's run. */
  iteration: number;
  /** For tool entries: tool name. */
  toolName?: string | undefined;
  /** For tool entries: whether the tool succeeded. */
  toolOk?: boolean | undefined;
  /** Running cost estimate. */
  costUsd?: number | undefined;
}

export interface AgentVirtualSession {
  subagentId: string;
  agentName: string;
  createdAt: string;
  status: string;
  task?: string | undefined;
  /** Ordered transcript entries (newest last). */
  transcript: AgentTimelineEntry[];
}

export interface AgentMonitorOptions {
  /** Parent/host session id for emitted agent timeline/status events. */
  sessionId?: string | undefined;
  /** The FleetBus to listen on for subagent events. Optional — set via `setFleetBus()` before `start()`. */
  fleetBus?: FleetBus | undefined;
  /** Local EventBus for emitting agent.timeline.* and agent.status_changed events. */
  events: EventBus;
  /** Directory where per-subagent JSONL transcripts will be written. */
  transcriptsDir: string;
  /** Maximum in-memory entries per subagent (ring buffer). Default 500. */
  maxEntriesPerAgent?: number;
  /** Whether agent stream is initially enabled. Default false. */
  streamEnabled?: boolean;
  /** Called for each new timeline entry — used by HQ publisher bridge. */
  onEntry?: ((entry: AgentTimelineEntry) => void) | undefined;
}

// ── Service ──────────────────────────────────────────────────────────────

export class AgentMonitorService {
  private _fleetBus: FleetBus | undefined;
  private readonly _events: EventBus;
  private readonly _sessionId: string | undefined;
  private readonly _transcriptsDir: string;
  private readonly _maxEntries: number;
  private _streamEnabled: boolean;
  private _onEntry: ((entry: AgentTimelineEntry) => void) | undefined;

  /** Per-subagent virtual sessions. */
  private readonly _sessions = new Map<string, AgentVirtualSession>();
  /**
   * Per-subagent OPEN streaming segment. Provider text/thinking deltas
   * arrive word-by-word; writing one transcript entry per delta fragments
   * every surface (ring, JSONL, HQ) into unreadable single-word lines.
   * Instead, consecutive same-kind/same-iteration deltas append into ONE
   * entry that is already in the ring (live views see it grow in place);
   * the JSONL line is written once, when the segment closes.
   */
  private readonly _openStreams = new Map<string, { entry: AgentTimelineEntry }>();
  /**
   * FIFO chain of in-flight transcript appends. Writes stay fire-and-forget so
   * a slow disk never stalls a subagent, but `close()` must be able to wait for
   * them: without this the process can exit between `stop()` flushing the open
   * segments and those appends reaching disk, losing exactly the text that was
   * on screen. Mirrors FleetManager.closeManifest()'s drain.
   */
  private readonly _writeQueue: Array<{ subagentId: string; line: string; bytes: number }> = [];
  private _writeQueueBytes = 0;
  /** Transcript dirs already created — avoids a mkdir syscall per append. */
  private readonly _ensuredDirs = new Set<string>();
  private _writeDrain: Promise<void> | null = null;
  private static readonly _MAX_QUEUED_WRITES = 1_000;
  private static readonly _MAX_QUEUED_WRITE_BYTES = 8 * 1024 * 1024;
  /** Disposers for FleetBus subscriptions, keyed by subagentId. */
  private readonly _subscriptions = new Map<string, () => void>();
  /** Generic fleet-wide subscription disposer. */
  private _fleetDisposer: (() => void) | undefined;
  /** Track whether service is running. */
  private _started = false;

  constructor(opts: AgentMonitorOptions) {
    this._fleetBus = opts.fleetBus;
    this._events = opts.events;
    this._sessionId = opts.sessionId;
    this._transcriptsDir = opts.transcriptsDir;
    this._maxEntries = opts.maxEntriesPerAgent ?? 500;
    this._streamEnabled = opts.streamEnabled ?? false;
    this._onEntry = opts.onEntry;
  }

  // ── Public API ────────────────────────────────────────────────────

  /** Set the FleetBus to listen on. Must be called before `start()`. */
  setFleetBus(bus: FleetBus): void {
    this._fleetBus = bus;
  }

  get streamEnabled(): boolean {
    return this._streamEnabled;
  }

  /** Enable/disable streaming agent conversations to the main chat timeline. */
  setStreamEnabled(enabled: boolean): void {
    this._streamEnabled = enabled;
  }

  /** Get a snapshot of all known agent sessions. */
  getAllSessions(): AgentVirtualSession[] {
    return Array.from(this._sessions.values());
  }

  /**
   * Rebuild the virtual sessions from the on-disk transcripts.
   *
   * The ring only holds what THIS process observed, so after a resume it is
   * empty and `getAllSessions()` reports no subagents even though every
   * transcript is sitting in `transcriptsDir`. This reads them back so a
   * resumed surface can show the prior run's subagent work.
   *
   * Entries already in the ring win: a live subagent's in-memory segment is
   * newer than its JSONL, which is only written when a segment closes.
   *
   * `only` restricts BOTH the disk scan and the returned set to a known list of
   * subagent ids. This is how a session gets ITS OWN subagents back: the
   * transcripts directory is shared by every session of the project, so the
   * unfiltered form hands each of four open tabs the union of all four tabs'
   * workers. The caller derives the list from the session's own journal
   * (`deriveSessionAgents`), which is the only record that says which agents
   * belong to which session.
   */
  async loadSessionsFromDisk(only?: readonly string[]): Promise<AgentVirtualSession[]> {
    const wanted = only === undefined ? undefined : new Set(only);
    if (wanted?.size === 0) return [];
    let subagentIds: string[];
    if (wanted) {
      // Named ids need no directory scan — a missing transcript simply yields
      // an entry-less row, which is the right answer for an agent that ran on
      // the parent-interleaved writer and never had a file of its own.
      subagentIds = [...wanted];
    } else {
      try {
        const dirents = await fs.readdir(this._transcriptsDir, { withFileTypes: true });
        subagentIds = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        return this.getAllSessions(); // no transcripts dir yet — nothing to restore
      }
    }

    for (const subagentId of subagentIds) {
      if (this._sessions.has(subagentId)) continue; // live ring is authoritative
      const transcript = await this._readTranscriptFile(subagentId);
      if (transcript.length === 0) continue;
      const first = expectDefined(transcript[0]);
      const last = expectDefined(transcript[transcript.length - 1]);
      this._sessions.set(subagentId, {
        subagentId,
        agentName: last.agentName || first.agentName || subagentId,
        createdAt: first.ts,
        // The run is over as far as this process is concerned; nothing on disk
        // says whether it finished or was killed mid-flight.
        status: 'restored',
        transcript: transcript.slice(-this._maxEntries),
      });
    }
    const all = this.getAllSessions();
    return wanted ? all.filter((session) => wanted.has(session.subagentId)) : all;
  }

  private async _readTranscriptFile(subagentId: string): Promise<AgentTimelineEntry[]> {
    const file = path.join(this._transcriptsDir, subagentId, 'transcript.jsonl');
    const accessible = await fs
      .access(file)
      .then(() => true)
      .catch(() => false);
    if (!accessible) return [];
    const out: AgentTimelineEntry[] = [];
    const input = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      for await (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          out.push(JSON.parse(trimmed) as AgentTimelineEntry);
          if (out.length > this._maxEntries) out.shift();
        } catch {
          // Skip a torn trailing line — the writer appends without fsync, so a
          // crash can leave a partial record.
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
    return out;
  }

  /** Get a specific agent's virtual session, or undefined. */
  getSession(subagentId: string): AgentVirtualSession | undefined {
    return this._sessions.get(subagentId);
  }

  /** Get transcript entries for a specific agent, newest first. */
  getTranscript(subagentId: string, limit = 50): AgentTimelineEntry[] {
    const session = this._sessions.get(subagentId);
    if (!session) return [];
    return session.transcript.slice(-limit).reverse();
  }

  /** Set a callback for each new timeline entry (HQ bridge). */
  setOnEntry(handler: ((entry: AgentTimelineEntry) => void) | undefined): void {
    this._onEntry = handler;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Start listening to FleetBus events. */
  start(): void {
    if (this._started) return;
    if (!this._fleetBus) {
      // FleetBus not set yet — start() will be called again after setFleetBus().
      this._started = true; // Mark as started so stop() works
      return;
    }
    this._started = true;

    // Subscribe to every FleetBus event and route to the appropriate handler.
    // FleetBus.any fires for ALL events from ALL subagents.
    this._fleetDisposer = this._fleetBus.onAny((event) => {
      this._routeEvent(event.subagentId, event.type, event.payload as Record<string, unknown>);
    });
  }

  /**
   * Stop listening and wait for every queued transcript write to reach disk.
   *
   * `stop()` alone only *starts* the flush of the open segments; the appends are
   * fire-and-forget, so a caller that exits right after it loses precisely the
   * text that was streaming. Shutdown paths should await this instead.
   *
   * A hard kill (SIGKILL, power loss) still loses the open segments — they live
   * only in the ring until a segment closes. Bounding that would mean writing
   * each delta, which fragments every reply into single-word JSONL lines.
   */
  async close(): Promise<void> {
    this.stop();
    for (;;) {
      if (this._writeQueue.length > 0) this._startWriteDrain();
      const drain = this._writeDrain;
      if (!drain) return;
      await drain;
    }
  }

  /** Stop listening and clean up all subscriptions. */
  stop(): void {
    if (!this._started) return;
    this._started = false;

    // Flush any still-open streaming segments to JSONL before detaching.
    for (const subagentId of [...this._openStreams.keys()]) {
      this._closeStream(subagentId);
    }

    if (this._fleetDisposer) {
      this._fleetDisposer();
      this._fleetDisposer = undefined;
    }
    for (const disposer of this._subscriptions.values()) {
      disposer();
    }
    this._subscriptions.clear();
  }

  /** Ensure a subagent is being tracked. Called when a subagent spawns. */
  trackSubagent(subagentId: string, agentName: string, task?: string): void {
    if (this._sessions.has(subagentId)) return;

    const now = new Date().toISOString();
    const session: AgentVirtualSession = {
      subagentId,
      agentName,
      createdAt: now,
      status: 'spawned',
      task,
      transcript: [],
    };
    this._sessions.set(subagentId, session);

    // Add a system entry for the spawn event.
    this._addEntry(subagentId, {
      id: this._uid(),
      subagentId,
      agentName,
      ts: now,
      kind: 'system',
      content: task ? `🎯 Spawned: ${task}` : '🤖 Agent spawned',
      iteration: 0,
    });

    // Emit status change.
    this._events.emit('agent.status_changed', {
      sessionId: this._sessionId,
      subagentId,
      agentName,
      status: 'spawned',
      ts: now,
      summary: task,
      task,
    });
  }

  /** Mark a subagent as completed/failed/etc. Called on subagent finish. */
  completeSubagent(
    subagentId: string,
    status: 'completed' | 'failed' | 'timeout' | 'stopped' | 'budget_exhausted',
    summary?: string,
  ): void {
    const session = this._sessions.get(subagentId);
    if (!session) return;

    const now = new Date().toISOString();
    session.status = status;

    this._addEntry(subagentId, {
      id: this._uid(),
      subagentId,
      agentName: session.agentName,
      ts: now,
      kind: 'status',
      content: summary ?? `Agent ${status}`,
      iteration: 999,
    });

    this._events.emit('agent.status_changed', {
      sessionId: this._sessionId,
      subagentId,
      agentName: session.agentName,
      status,
      ts: now,
      summary,
      task: session.task,
    });
  }

  /** Drop a retired subagent from every live in-memory monitor surface. */
  removeSubagent(subagentId: string): void {
    this._closeStream(subagentId);
    this._sessions.delete(subagentId);
    const dispose = this._subscriptions.get(subagentId);
    if (dispose) dispose();
    this._subscriptions.delete(subagentId);
  }

  // ── Internal ───────────────────────────────────────────────────────

  private _routeEvent(subagentId: string, type: string, payload: Record<string, unknown>): void {
    // Skip events from unknown subagents (we haven't called trackSubagent yet).
    const session = this._sessions.get(subagentId);
    if (!session) return;

    switch (type) {
      case 'provider.text_delta': {
        const text = payload.text as string | undefined;
        if (!text || text.length === 0) return;
        this._appendStreamDelta(
          subagentId,
          session,
          'text',
          text,
          (payload.iteration as number) ?? 0,
        );
        break;
      }
      case 'provider.thinking_delta': {
        const text = payload.text as string | undefined;
        if (!text || text.length === 0) return;
        this._appendStreamDelta(
          subagentId,
          session,
          'thinking',
          text,
          (payload.iteration as number) ?? 0,
        );
        break;
      }
      case 'tool.started': {
        const name = payload.name as string | undefined;
        if (!name) return;
        this._addEntry(subagentId, {
          id: this._uid(),
          subagentId,
          agentName: session.agentName,
          ts: new Date().toISOString(),
          kind: 'tool_use',
          content: this._formatToolUse(name, payload.input),
          iteration: (payload.iteration as number) ?? 0,
          toolName: name,
        });
        break;
      }
      case 'tool.executed': {
        const name = payload.name as string | undefined;
        const ok = payload.ok as boolean | undefined;
        const durationMs = payload.durationMs as number | undefined;
        const output = typeof payload.output === 'string' ? payload.output : '';
        const outputBytes =
          typeof payload.outputBytes === 'number' ? payload.outputBytes : undefined;
        if (!name) return;
        const duration = durationMs !== undefined ? ` (${durationMs}ms)` : '';
        const state = ok ? 'Completed' : 'Failed';
        this._addEntry(subagentId, {
          id: this._uid(),
          subagentId,
          agentName: session.agentName,
          ts: new Date().toISOString(),
          kind: 'tool_result',
          content: this._formatToolResult(`${state} ${name}${duration}`, output, outputBytes),
          iteration: (payload.iteration as number) ?? 0,
          toolName: name,
          toolOk: ok,
        });
        break;
      }
      case 'iteration.completed': {
        // Periodically emit a heartbeat so the timeline shows progress.
        const index = (payload.index as number) ?? 0;
        if (index > 0 && index % 5 === 0) {
          this._addEntry(subagentId, {
            id: this._uid(),
            subagentId,
            agentName: session.agentName,
            ts: new Date().toISOString(),
            kind: 'status',
            content: `🔄 Iteration ${index}`,
            iteration: index,
          });
        }
        break;
      }
    }
  }

  /** Max characters accumulated into one streaming segment before rolling over. */
  private static readonly _MAX_SEGMENT_CHARS = 20_000;

  /**
   * Fold a provider text/thinking delta into the subagent's open streaming
   * segment, or open a new one. A segment breaks on kind change, iteration
   * change, size cap, or any non-delta entry (see `_addEntry`). The entry
   * is pushed to the ring when the segment OPENS (live views poll the ring
   * and watch it grow in place); the JSONL line AND the timeline/HQ
   * announcement happen once, on close, with the COMPLETE segment — so
   * downstream consumers get one whole message instead of a word-per-event
   * firehose (or, worse, only the first word).
   */
  private _appendStreamDelta(
    subagentId: string,
    session: AgentVirtualSession,
    kind: 'text' | 'thinking',
    text: string,
    iteration: number,
  ): void {
    const open = this._openStreams.get(subagentId);
    if (
      open &&
      open.entry.kind === kind &&
      open.entry.iteration === iteration &&
      open.entry.content.length + text.length <= AgentMonitorService._MAX_SEGMENT_CHARS
    ) {
      open.entry.content += text;
      return;
    }
    this._closeStream(subagentId);

    const entry: AgentTimelineEntry = {
      id: this._uid(),
      subagentId,
      agentName: session.agentName,
      ts: new Date().toISOString(),
      kind,
      content: text,
      iteration,
    };
    this._openStreams.set(subagentId, { entry });

    // Ring only for now — JSONL + announcement wait for the close so both
    // carry the complete segment exactly once.
    session.transcript.push(entry);
    if (session.transcript.length > this._maxEntries) {
      session.transcript.splice(0, session.transcript.length - this._maxEntries);
    }
  }

  /**
   * Close the subagent's open streaming segment: persist it to JSONL and
   * announce the completed entry on the local bus + HQ callback.
   */
  private _closeStream(subagentId: string): void {
    const open = this._openStreams.get(subagentId);
    if (!open) return;
    this._openStreams.delete(subagentId);
    this._enqueueWrite(subagentId, open.entry);
    this._emitEntry(open.entry);
  }

  private _addEntry(subagentId: string, entry: AgentTimelineEntry): void {
    const session = this._sessions.get(subagentId);
    if (!session) return;

    // Any non-delta entry is a natural segment boundary: flush the open
    // streaming segment first so the JSONL keeps chronological order.
    this._closeStream(subagentId);

    // Add to in-memory ring buffer.
    session.transcript.push(entry);
    if (session.transcript.length > this._maxEntries) {
      session.transcript.splice(0, session.transcript.length - this._maxEntries);
    }

    // Write to JSONL file (async, fire-and-forget — but drainable via close()).
    this._enqueueWrite(subagentId, entry);

    this._emitEntry(entry);
  }

  /** Announce a transcript entry on the local bus + HQ callback. */
  private _emitEntry(entry: AgentTimelineEntry): void {
    // Emit local timeline event (for TUI/WebUI).
    this._events.emit('agent.timeline.message', {
      sessionId: this._sessionId,
      subagentId: entry.subagentId,
      agentName: entry.agentName,
      content: entry.content,
      kind: entry.kind,
      iteration: entry.iteration,
      ts: entry.ts,
      toolName: entry.toolName,
      toolOk: entry.toolOk,
      costUsd: entry.costUsd,
    });

    // Forward to HQ bridge callback.
    this._onEntry?.(entry);
  }

  /**
   * Queue a transcript append. Serialized so two entries for the same subagent
   * cannot interleave into a torn line, and retained on `_writeChain` so
   * `close()` can wait for them. Never rejects — a transcript write failing must
   * not take down the agent it is watching.
   */
  private _enqueueWrite(subagentId: string, entry: AgentTimelineEntry): void {
    const line = JSON.stringify(entry) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > AgentMonitorService._MAX_QUEUED_WRITE_BYTES) return;
    while (
      this._writeQueue.length >= AgentMonitorService._MAX_QUEUED_WRITES ||
      this._writeQueueBytes + bytes > AgentMonitorService._MAX_QUEUED_WRITE_BYTES
    ) {
      const dropped = this._writeQueue.shift();
      if (!dropped) break;
      this._writeQueueBytes = Math.max(0, this._writeQueueBytes - dropped.bytes);
    }
    this._writeQueue.push({ subagentId, line, bytes });
    this._writeQueueBytes += bytes;
    this._startWriteDrain();
  }

  private _startWriteDrain(): void {
    if (this._writeDrain) return;
    const drain = (async () => {
      while (this._writeQueue.length > 0) {
        const queued = this._writeQueue.shift();
        if (!queued) continue;
        this._writeQueueBytes = Math.max(0, this._writeQueueBytes - queued.bytes);
        await this._appendToFile(queued.subagentId, queued.line).catch(() => {
          // Best-effort transcript writes must never stop agent monitoring.
        });
      }
    })().finally(() => {
      if (this._writeDrain === drain) this._writeDrain = null;
      if (this._writeQueue.length > 0) this._startWriteDrain();
    });
    this._writeDrain = drain;
  }

  private async _appendToFile(subagentId: string, line: string): Promise<void> {
    const dir = path.join(this._transcriptsDir, subagentId);
    // One mkdir per subagent dir, not per append. If the dir is removed
    // mid-session the append's ENOENT clears the cache entry so the next
    // append recreates it.
    if (!this._ensuredDirs.has(dir)) {
      await fs.mkdir(dir, { recursive: true });
      this._ensuredDirs.add(dir);
    }
    const filePath = path.join(dir, 'transcript.jsonl');
    try {
      await fs.appendFile(filePath, line, { encoding: 'utf8', mode: SECRET_FILE_MODE });
    } catch (error) {
      this._ensuredDirs.delete(dir);
      throw error;
    }
  }

  private _uid(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  private _formatToolUse(name: string, input: unknown): string {
    if (input === undefined) return `${name}()`;
    const body = this._stringifyForTimeline(input);
    if (!body) return `${name}()`;
    // First line is a compact single-line call preview — one-line transcript
    // views (F3 pane, HQ list) show only the first line, and `name` alone
    // told the reader nothing about WHAT the tool ran on.
    const inline = body.replace(/\s+/g, ' ').trim();
    const head = inline.length <= 160 ? `${name}(${inline})` : `${name}(${inline.slice(0, 159)}…)`;
    return `${head}\n${body}`;
  }

  private _formatToolResult(
    summary: string,
    output: string,
    outputBytes: number | undefined,
  ): string {
    if (!output) return summary;
    const suffix =
      outputBytes && Buffer.byteLength(output, 'utf8') < outputBytes
        ? `\n\n... ${outputBytes.toLocaleString()} bytes total`
        : '';
    return `${summary}\n${output}${suffix}`;
  }

  private _stringifyForTimeline(value: unknown): string {
    try {
      if (typeof value === 'string') return this._capTimelineText(value);
      return this._capTimelineText(JSON.stringify(value, null, 2));
    } catch {
      return this._capTimelineText(String(value));
    }
  }

  private _capTimelineText(text: string, max = 20_000): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
  }
}

// ── Barrel export ────────────────────────────────────────────────────────

export function createAgentMonitorService(opts: AgentMonitorOptions): AgentMonitorService {
  return new AgentMonitorService(opts);
}
