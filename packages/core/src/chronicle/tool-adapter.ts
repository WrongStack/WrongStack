import { createHash } from 'node:crypto';
import type { EventBus, EventMap } from '../kernel/events.js';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type { ChronicleContext } from './context.js';
import type { ChronicleEventSink } from './sink.js';
import type { ChronicleEventInput, ChronicleResourceRef } from './types.js';

export interface ChronicleToolAdapterOptions {
  events: EventBus;
  journal: ChronicleEventSink;
  context: ChronicleContext | (() => ChronicleContext);
  scrubber: SecretScrubber;
  onPersistError?: ((error: unknown, event: ChronicleEventInput) => void) | undefined;
}

/** Maximum bytes of tool input/output text persisted as a preview. The hash
 *  and byte/token counts already capture identity; the full payload is
 *  redundant for analytics and dominated journal bytes for read-heavy tools. */
const PREVIEW_MAX_BYTES = 2048;

/** Persist the complete tool lifecycle. Resource edges discovered in results
 *  (files/symbols/commands touched) are windowed by rollup-adapter.ts instead
 *  of persisted raw here. */
export function wireToolsToChronicle(options: ChronicleToolAdapterOptions): () => void {
  const unsubs = [
    options.events.on('tool.started', (event) => {
      const input = scrubValue(options.scrubber, event.input);
      persist(options, event, {
        eventType: 'tool.started',
        outcome: 'started',
        attributes: {
          toolName: event.name,
          input: capPreview(input),
          inputHash: hashText(input),
          inputBytes: Buffer.byteLength(input),
        },
      });
    }),
    options.events.on('permission.evaluated', (event) => {
      persist(options, event, {
        eventType: 'permission.evaluated',
        outcome: event.effectiveDecision === 'deny' ? 'denied' : 'success',
        attributes: {
          toolName: event.name,
          inputHash: event.inputHash,
          policyDecision: event.policyDecision,
          effectiveDecision: event.effectiveDecision,
          decisionSource: event.decisionSource,
          reason: event.reason ? options.scrubber.scrub(event.reason) : undefined,
          riskTier: event.riskTier,
          yoloEnabled: event.yoloEnabled,
          boundaryDecision: event.boundaryDecision,
          boundaryReason: event.boundaryReason
            ? options.scrubber.scrub(event.boundaryReason)
            : undefined,
          capabilityDowngraded: event.capabilityDowngraded,
        },
      });
    }),
    options.events.on('tool.executed', (event) => {
      const output = options.scrubber.scrub(event.output ?? '');
      persist(options, event, {
        eventType: 'tool.executed',
        outcome: event.ok ? 'success' : 'failure',
        durationNs: millisecondsToNanoseconds(event.durationMs),
        attributes: {
          toolName: event.name,
          ok: event.ok,
          outputPreview: capPreview(output),
          outputHash: hashText(output),
          outputBytes: event.outputBytes,
          outputTokens: event.outputTokens,
          outputLines: event.outputLines,
          metadata: event.metadata,
        },
      });
    }),
    options.events.on('tool.failed', (event) => persist(options, event, {
      eventType: 'tool.failed',
      outcome: 'failure',
      durationNs: millisecondsToNanoseconds(event.durationMs),
      attributes: {
        toolName: event.name,
        category: event.category,
        retryable: event.retryable,
        detail: event.detail,
        errorCode: event.errorCode,
        errorSubsystem: event.errorSubsystem,
        errorSeverity: event.errorSeverity,
      },
    })),
    options.events.on('tool.progress', (event) => {
      if (event.event.type !== 'file_changed') return;
      const resource = progressResource(event);
      persist(options, event, {
        eventType: 'file.mutation.observed',
        outcome: 'started',
        ...(resource ? { resource } : {}),
        attributes: {
          toolName: event.name,
          progressType: event.event.type,
          text: capPreview(options.scrubber.scrub(event.event.text ?? '')),
          data: capPreview(scrubValue(options.scrubber, event.event.data)),
          operation: event.event.operation,
        },
      });
    }),
  ];
  return () => unsubs.forEach((unsubscribe) => { unsubscribe(); });
}

type ToolCorrelationEvent = {
  sessionId?: string | undefined;
  traceId?: string | undefined;
  logicalRequestId?: string | undefined;
  promptManifestId?: string | undefined;
  agentId?: string | undefined;
  id?: string | undefined;
  name: string;
  taskId?: string | undefined;
  boardId?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
};

function persist(
  options: ChronicleToolAdapterOptions,
  event: ToolCorrelationEvent,
  fields: Pick<ChronicleEventInput, 'eventType' | 'outcome'> &
    Partial<Pick<ChronicleEventInput, 'durationNs' | 'resource' | 'attributes'>>,
): void {
  const context = typeof options.context === 'function' ? options.context() : options.context;
  const input: ChronicleEventInput = {
    ...fields,
    scope: {
      ...context.scope,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      ...(event.agentId ? { agentId: event.agentId } : {}),
      ...(event.taskId ? { taskId: event.taskId } : {}),
      ...(event.boardId ? { kanbanBoardId: event.boardId } : {}),
    },
    correlation: {
      ...context.correlation,
      ...(event.traceId ? { traceId: event.traceId } : {}),
      ...(event.logicalRequestId ? { logicalRequestId: event.logicalRequestId } : {}),
      ...(event.promptManifestId ? { promptManifestId: event.promptManifestId } : {}),
      ...(event.id ? { toolCallId: event.id } : {}),
    },
    ...(event.provider || event.model
      ? {
          runtime: {
            ...(event.provider ? { providerId: event.provider } : {}),
            ...(event.model ? { modelId: event.model } : {}),
          },
        }
      : {}),
  };
  void options.journal.append(input).catch((error) => options.onPersistError?.(error, input));
}

function progressResource(event: EventMap['tool.progress']): ChronicleResourceRef | undefined {
  if (event.event.type !== 'file_changed' || !event.event.path) return undefined;
  return {
    kind: 'file',
    id: resourceId('file', event.event.path),
    path: event.event.path,
    ...(event.event.line !== undefined ? { lineStart: event.event.line } : {}),
    ...(event.event.endLine !== undefined ? { lineEnd: event.event.endLine } : {}),
  };
}

function scrubValue(scrubber: SecretScrubber, value: unknown): string {
  if (value === undefined) return '';
  try {
    return scrubber.scrub(JSON.stringify(value));
  } catch {
    return scrubber.scrub(String(value));
  }
}

function resourceId(kind: string, value: string): string {
  return `${kind}_${hashText(value).slice(0, 24)}`;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Return the string as-is when within the byte budget; otherwise return a
 *  `{ preview, truncated, totalBytes }` summary. The hash (always computed on
 *  the full value) preserves identity for large payloads. */
function capPreview(value: string): string | { preview: string; truncated: true; totalBytes: number } {
  // Fast path: short strings need only a cheap byteLength check for multibyte safety.
  if (value.length <= PREVIEW_MAX_BYTES) {
    if (Buffer.byteLength(value, 'utf8') <= PREVIEW_MAX_BYTES) return value;
  }
  // Over (or possibly over) budget: encode once — buf.length is the authoritative byte count.
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= PREVIEW_MAX_BYTES) return value;
  // Walk back to the nearest valid UTF-8 character boundary.
  let end = PREVIEW_MAX_BYTES;
  while (end > 0 && (buf[end]! & 0xC0) === 0x80) end--;
  return { preview: buf.subarray(0, end).toString('utf8'), truncated: true, totalBytes: buf.length };
}

function millisecondsToNanoseconds(durationMs: number): string {
  return Math.round(durationMs * 1_000_000).toString();
}
