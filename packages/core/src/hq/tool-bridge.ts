/**
 * ToolTelemetryBridge — forwards local tool execution events to the HQ
 * publisher as `tool.started` and `tool.completed` envelopes, so the command
 * center can surface live tool activity (what's running, durations, success
 * rates) across every connected machine.
 *
 * Sources:
 *  - `tool.started` (EventBus) → `tool.started` envelope. Raw tool input is
 *    shaped via {@link summarizeHqToolArgs} according to the active HQ policy.
 *  - `tool.executed` (EventBus) → `tool.completed` envelope (carries the
 *    richer post-execution signal: duration, ok/error, output bytes).
 *
 * All payload fields are plain serializable data — no closures. The
 * `tool.started.input` raw args follow the publisher redaction policy before
 * publishing.
 *
 * @module hq/tool-bridge
 */
import type { EventBus } from '../kernel/events.js';
import { type BridgeContextOptions, createBridgeContext } from './bridge-context.js';
import type {
  HqEventEnvelope,
  HqRedactionPolicy,
  HqToolCompletedPayload,
  HqToolStartedPayload,
} from './protocol.js';
import { HQ_TRANSCRIPT_TEXT_CAP } from './protocol.js';
import {
  resolveHqRedactionPolicy,
  scrubAndTruncateHqPreview,
  summarizeHqToolArgs,
} from './redaction.js';

export interface ToolTelemetryBridgeOptions extends BridgeContextOptions {
  /** Local EventBus emitting `tool.started` and `tool.executed` events. */
  events: EventBus;
  /** Project root for path redaction in tool input summaries. */
  projectRoot?: string;
}

interface ToolStartedEvent {
  sessionId?: string | undefined;
  name: string;
  id: string;
  input?: unknown | undefined;
}

interface ToolExecutedEvent {
  sessionId?: string | undefined;
  id?: string | undefined;
  name: string;
  durationMs: number;
  ok: boolean;
  input?: unknown | undefined;
  output?: string | undefined;
  outputBytes?: number | undefined;
}

/** Track in-flight tool calls so we can attach start info to completion. */
interface InFlightTool {
  name: string;
  startedAt: number;
}

/**
 * Start forwarding tool execution events to HQ. Returns a disposer that
 * unsubscribes all listeners — call on shutdown.
 */
export function startToolTelemetryBridge(opts: ToolTelemetryBridgeOptions): () => void {
  const { events, publisher } = opts;
  const ctx = createBridgeContext(opts);
  const inFlight = new Map<string, InFlightTool>();

  const offStarted = events.on('tool.started', (p: ToolStartedEvent) => {
    inFlight.set(p.id, { name: p.name, startedAt: Date.now() });
    const payload: HqToolStartedPayload = {
      toolName: p.name,
      ...(p.input !== undefined
        ? {
            inputSummary: summarizeHqToolArgs(p.input, {
              policy: publisher.redactionPolicy,
              ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
            }),
          }
        : {}),
    };
    ctx.safePublish({
      type: 'tool.started',
      payload,
      ...ctx.sessionIdTag(p.sessionId),
      timestamp: ctx.now(),
    });
  });

  const offExecuted = events.on('tool.executed', (p: ToolExecutedEvent) => {
    const id = p.id;
    if (id !== undefined) inFlight.delete(id);
    const payload: HqToolCompletedPayload = {
      toolName: p.name,
      status: p.ok ? 'success' : 'error',
      durationMs: p.durationMs,
      ...(p.output !== undefined && p.output.length > 0
        ? { outputSummary: truncateForSummary(p.output, publisher.redactionPolicy) }
        : {}),
    };
    ctx.safePublish({
      type: 'tool.completed',
      payload,
      ...ctx.sessionIdTag(p.sessionId),
      timestamp: ctx.now(),
    });
  });

  ctx.track(offStarted);
  ctx.track(offExecuted);
  return () => {
    ctx.dispose();
    inFlight.clear();
  };
}

function truncateForSummary(
  output: string,
  policy?: Partial<HqRedactionPolicy>,
  max = 280,
): unknown {
  const resolved = resolveHqRedactionPolicy(policy);
  // WS-007: `rawContent` widens how much is shown, never whether secrets are
  // stripped. The previous early return handed tool output through unscrubbed
  // whenever rawContent was set — which is the shipped default.
  const limit = resolved.rawContent ? Math.max(max, HQ_TRANSCRIPT_TEXT_CAP) : max;
  return scrubAndTruncateHqPreview(output, limit) ?? '';
}

/** Re-export for type-only consumers. */
export type { HqEventEnvelope };
