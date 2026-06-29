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
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus } from '../kernel/events.js';
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
  kind: 'text' | 'tool_use' | 'tool_result' | 'error' | 'status' | 'system';
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

  /** Stop listening and clean up all subscriptions. */
  stop(): void {
    if (!this._started) return;
    this._started = false;

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

  // ── Internal ───────────────────────────────────────────────────────

  private _routeEvent(subagentId: string, type: string, payload: Record<string, unknown>): void {
    // Skip events from unknown subagents (we haven't called trackSubagent yet).
    const session = this._sessions.get(subagentId);
    if (!session) return;

    switch (type) {
      case 'provider.text_delta': {
        const text = payload.text as string | undefined;
        if (!text || text.length === 0) return;
        const iteration = (payload.iteration as number) ?? 0;
        this._addEntry(subagentId, {
          id: this._uid(),
          subagentId,
          agentName: session.agentName,
          ts: new Date().toISOString(),
          kind: 'text',
          content: text,
          iteration,
        });
        break;
      }
      case 'provider.thinking_delta': {
        const text = payload.text as string | undefined;
        if (!text || text.length === 0) return;
        const iteration = (payload.iteration as number) ?? 0;
        this._addEntry(subagentId, {
          id: this._uid(),
          subagentId,
          agentName: session.agentName,
          ts: new Date().toISOString(),
          kind: 'text',
          content: `🧠 ${text}`,
          iteration,
        });
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
          content: `🔧 ${name}()`,
          iteration: (payload.iteration as number) ?? 0,
          toolName: name,
        });
        break;
      }
      case 'tool.executed': {
        const name = payload.name as string | undefined;
        const ok = payload.ok as boolean | undefined;
        const durationMs = payload.durationMs as number | undefined;
        if (!name) return;
        const statusIcon = ok ? '✅' : '❌';
        const duration = durationMs !== undefined ? ` (${durationMs}ms)` : '';
        this._addEntry(subagentId, {
          id: this._uid(),
          subagentId,
          agentName: session.agentName,
          ts: new Date().toISOString(),
          kind: 'tool_result',
          content: `${statusIcon} ${name}${duration}`,
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

  private _addEntry(subagentId: string, entry: AgentTimelineEntry): void {
    const session = this._sessions.get(subagentId);
    if (!session) return;

    // Add to in-memory ring buffer.
    session.transcript.push(entry);
    if (session.transcript.length > this._maxEntries) {
      session.transcript.splice(0, session.transcript.length - this._maxEntries);
    }

    // Write to JSONL file (async, fire-and-forget).
    this._appendToFile(subagentId, entry).catch(() => {
      // Best-effort file write — failures must never crash the agent.
    });

    // Emit local timeline event (for TUI/WebUI).
    this._events.emit('agent.timeline.message', {
      sessionId: this._sessionId,
      subagentId: entry.subagentId,
      agentName: entry.agentName,
      content: entry.content,
      kind: entry.kind === 'tool_result' ? 'tool_use' : entry.kind === 'system' ? 'status' : entry.kind,
      iteration: entry.iteration,
      ts: entry.ts,
      toolName: entry.toolName,
      costUsd: entry.costUsd,
    });

    // Forward to HQ bridge callback.
    this._onEntry?.(entry);
  }

  private async _appendToFile(subagentId: string, entry: AgentTimelineEntry): Promise<void> {
    const dir = path.join(this._transcriptsDir, subagentId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'transcript.jsonl');
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(filePath, line, { encoding: 'utf8' });
  }

  private _uid(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}

// ── Barrel export ────────────────────────────────────────────────────────

export function createAgentMonitorService(opts: AgentMonitorOptions): AgentMonitorService {
  return new AgentMonitorService(opts);
}
