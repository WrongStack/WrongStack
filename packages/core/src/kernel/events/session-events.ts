import type { AgentContext } from '../../types/context.js';
import type { Usage } from '../../types/provider.js';
import type { WorkspaceCheckpointRef } from '../../types/session.js';
import type { TrackedAgentSnapshot } from '../events.js';

export interface SessionEventMap {
  'session.started': { id: string; sessionId?: string | undefined };
  'session.ended': {
    id: string;
    sessionId?: string | undefined;
    usage: Usage;
    /**
     * Register asynchronous session-end producer work during the synchronous
     * `session.ended` callback. Cleanup waits for every registered promise to
     * settle (fulfilled or rejected) before draining review work and closing.
     * Calls made after the callback returns are outside the join contract.
     */
    waitUntil?: ((work: Promise<void>) => void) | undefined;
  };
  'session.damaged': { sessionId: string; detail: string };
  /**
   * Fired by AgentStatusTracker after every flush with the full agent list
   * (leader + subagents). In-process consumers (e.g. the HQ session-telemetry
   * bridge) read this to build live snapshots without re-reading the shared
   * session-registry file.
   */
  'session.agents_updated': {
    sessionId?: string | undefined;
    agents: readonly TrackedAgentSnapshot[];
  };
  'iteration.started': { sessionId?: string | undefined; ctx: AgentContext; index: number };
  'iteration.completed': { sessionId?: string | undefined; ctx: AgentContext; index: number };
  /**
   * Fired when the agent hits its iteration limit. Listeners (CLI/TUI) can
   * call `grant(extra)` to allow more iterations, or `deny()` to stop.
   * If no listener responds within 30s the run ends with 'max_iterations'.
   */
  'iteration.limit_reached': {
    sessionId?: string | undefined;
    currentIterations: number;
    currentLimit: number;
    grant: (extraIterations: number) => void;
    deny: () => void;
  };
  /**
   * Fired on every `iteration.completed`. UIs subscribe to render a live
   * context-window fill bar per agent (e.g. "67% ████████░░"). `load` is
   * clamped to 0..1 so every live surface renders at most 100%; diagnostics
   * can still detect over-budget states from `tokens > maxContext` or
   * `rawLoad`.
   */
  'ctx.pct': {
    sessionId?: string | undefined;
    /** Fraction of maxContext currently in use, clamped to 0..1 for display. */
    load: number;
    /** Unclamped fraction when available. Can exceed 1 when over budget. */
    rawLoad?: number | undefined;
    /** Estimated total tokens (system + tools + messages). */
    tokens: number;
    /** Provider's max context window. */
    maxContext: number;
  };
  /** Fired when the active model's resolved context window changes. */
  'ctx.max_context': {
    sessionId?: string | undefined;
    providerId: string;
    modelId: string;
    maxContext: number;
    /** Previous positive limit when this event represents a live change. */
    previousMaxContext?: number | undefined;
    /** Whether the value came from static resolution or a live provider probe. */
    source?: 'configured' | 'provider' | 'provider_overflow' | undefined;
    /** True when the positive limit decreased and UI should surface a warning. */
    decreased?: boolean | undefined;
  };
  'context.repaired': {
    sessionId?: string | undefined;
    ctx: AgentContext;
    changed: boolean;
    removedToolUses: string[];
    removedToolResults: string[];
    removedMessages: number;
  };
  'compaction.fired': {
    sessionId?: string | undefined;
    /** Threshold level that triggered compaction (warn / soft / hard). */
    level: 'warn' | 'soft' | 'hard';
    /** Tokens estimated before compaction ran. */
    tokens: number;
    /** Fraction of maxContext at the time compaction fired. */
    load: number;
    /** Provider's max context window in tokens. */
    maxContext: number;
    /** Budget snapshot used for the compaction decision. */
    budget?:
      | {
          maxContext: number;
          inputTokens: number;
          availableInputTokens: number;
          remainingInputTokens: number;
          reservedOutputTokens: number;
          reservedSafetyTokens: number;
          load: number;
          overflowTokens: number;
        }
      | undefined;
    /** Adaptive trigger signals observed alongside token pressure. */
    signals?: { repeatedReadCount?: number | undefined } | undefined;
    /** Full compaction report from the compactor. */
    report: { before: number; after: number; reductions: { phase: string; saved: number }[] };
    /** Whether aggressive (summary) mode was used. */
    aggressive: boolean;
  };
  /**
   * Fired when the auto-compaction middleware's compactor.compact() call
   * throws. Compaction is best-effort by design so we don't crash the agent
   * loop, but a persistent failure (misconfigured summarizer model, network
   * outage) means the next iteration may hit context overflow. Observability
   * layers / dashboards subscribe to this to surface the silent regression.
   */
  'compaction.failed': {
    sessionId?: string | undefined;
    err: Error;
    aggressive: boolean;
    level: 'warn' | 'soft' | 'hard';
    tokens: number;
    maxContext: number;
    budget?:
      | {
          maxContext: number;
          inputTokens: number;
          availableInputTokens: number;
          remainingInputTokens: number;
          reservedOutputTokens: number;
          reservedSafetyTokens: number;
          load: number;
          overflowTokens: number;
        }
      | undefined;
    signals?: { repeatedReadCount?: number | undefined } | undefined;
    load: number;
    fatal: boolean;
  };
  /**
   * Fired when the last-resort emergency trim runs — normal compaction left the
   * request above the hard threshold, so message content was head/tail
   * truncated (and, as a final step, oldest messages dropped) until it
   * structurally fit the window. This is the no-overflow guarantee in action;
   * `withinBudget: false` would indicate the impossible case where even a
   * fully-floored request exceeds the budget.
   */
  'compaction.emergency_trim': {
    sessionId?: string | undefined;
    level: 'warn' | 'soft' | 'hard';
    /** Estimated message tokens reclaimed by the trim. */
    saved: number;
    /** Content blocks elided or head/tail truncated. */
    trimmedBlocks: number;
    /** Whole messages dropped as the final pass. */
    droppedMessages: number;
    /** Full-request token estimate after the trim. */
    tokens: number;
    /** Fraction of the window occupied after the trim. */
    load: number;
    maxContext: number;
    budget?:
      | {
          maxContext: number;
          inputTokens: number;
          availableInputTokens: number;
          remainingInputTokens: number;
          reservedOutputTokens: number;
          reservedSafetyTokens: number;
          load: number;
          overflowTokens: number;
        }
      | undefined;
    /** True when the request fits the window after trimming (expected: always). */
    withinBudget: boolean;
  };
  /**
   * Fired when compaction trims further toward the active mode's targetLoad.
   * Unlike emergency_trim, this is policy-driven and may run below the hard
   * overflow threshold.
   */
  'compaction.target_trim': {
    sessionId?: string | undefined;
    level: 'warn' | 'soft' | 'hard';
    /** Target load that the mode requested after compaction. */
    targetLoad: number;
    /** Estimated message tokens reclaimed by the trim. */
    saved: number;
    /** Content blocks elided or head/tail truncated. */
    trimmedBlocks: number;
    /** Whole messages dropped as the final pass. */
    droppedMessages: number;
    /** Full-request token estimate after the trim. */
    tokens: number;
    /** Fraction of the window occupied after the trim. */
    load: number;
    maxContext: number;
    budget?:
      | {
          maxContext: number;
          inputTokens: number;
          availableInputTokens: number;
          remainingInputTokens: number;
          reservedOutputTokens: number;
          reservedSafetyTokens: number;
          load: number;
          overflowTokens: number;
        }
      | undefined;
    /** True when the request fits the target budget after trimming. */
    withinBudget: boolean;
  };
  /** Fired by SessionWriter.writeCheckpoint() after the checkpoint event is appended to JSONL. */
  'checkpoint.written': {
    sessionId?: string | undefined;
    promptIndex: number;
    promptPreview: string;
    ts: string;
    fileCount: number;
    /** Deterministic Git HEAD + dirty workspace identity, absent when capture failed. */
    workspaceCheckpoint?: WorkspaceCheckpointRef | undefined;
  };
  /**
   * Fired by SessionWriter.writeInFlightMarker() — the agent loop has
   * started a long-running operation. Pairs with `in_flight.ended`
   * on clean shutdown. A marker with no end indicates a crash.
   * (Idea #1 from IDEAS.md — Stateful Session Recovery.)
   */
  'in_flight.started': { sessionId?: string | undefined; context: string; ts: string };
  /** Fired by SessionWriter.clearInFlightMarker() — operation completed cleanly. */
  'in_flight.ended': {
    sessionId?: string | undefined;
    reason: 'clean' | 'aborted' | 'recovered';
    ts: string;
  };
  /**
   * Fired after a session rewind completes: files are reverted and the session
   * history is truncated. The TUI listens to this to update its checkpoint
   * list and clear history entries that are now invalid.
   */
  'session.rewound': {
    sessionId?: string | undefined;
    toPromptIndex: number;
    revertedFiles: string[];
    removedEvents: number;
  };
  /**
   * Auto-proceed countdown tick, emitted once per second by the REPL while
   * autonomy mode `auto` is counting down to self-driving the next suggestion.
   * `remaining` is the number of whole seconds left. Display-only: the TUI
   * StatusBar renders it as an "auto-proceed in Ns" chip; no consumer should
   * derive behavior from it (the REPL owns the actual timer).
   */
  'countdown.tick': { sessionId?: string | undefined; remaining: number };
  /**
   * Periodic self-observation sample from `startChronicleHealthMonitor`
   * (~every 30s per process). Windowed into a `metrics.rollup` event by
   * rollup-adapter.ts rather than persisted raw — this bus event only
   * exists so the rollup adapter (and any other in-process listener, e.g.
   * a live diagnostics panel) can observe it without depending on Chronicle.
   */
  'runtime.health.sampled': {
    sessionId?: string | undefined;
    uptimeSeconds: number;
    eventLoop: {
      utilization: number;
      activeMs: number;
      idleMs: number;
      delayMeanMs: number;
      delayP95Ms: number;
      delayMaxMs: number;
    };
    cpu: { userMicros: number; systemMicros: number };
    memory: {
      rssBytes: number;
      heapTotalBytes: number;
      heapUsedBytes: number;
      externalBytes: number;
      arrayBuffersBytes: number;
    };
    chronicle: unknown;
  };
  /**
   * Real-time client status event. Emitted by TUI/CLI/WebUI to report current
   * session stats (tool calls, tokens, model, mode, cost). Broadcast immediately
   * to all WebUI clients via setup-events.ts and written to status.json for
   * external watchers.
   */
  'client.status': {
    /** Active session represented by this client status update. */
    sessionId?: string | undefined;
    clientType: string;
    clientId: string;
    projectHash: string;
    agentCount: number;
    model: string;
    mode: string;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    costUsd: number;
    timestamp: number;
    projectSlug: string;
  };
  error: {
    sessionId?: string | undefined;
    err: Error;
    phase: string;
    _original?: Error | undefined;
  };
}
