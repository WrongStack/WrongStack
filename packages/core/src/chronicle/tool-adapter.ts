import { createHash } from 'node:crypto';
import type { EventBus, EventMap } from '../kernel/events.js';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type { ToolSettlement } from '../types/tool.js';
import type { ChronicleContext } from './context.js';
import { fileToolStats } from './file-tool-stats.js';
import type { ChronicleEventSink } from './sink.js';
import type { ChronicleEventInput, ChronicleOutcome, ChronicleResourceRef } from './types.js';

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

/**
 * Most files a failed call had changed on disk, persisted as evidence of
 * damage. A `patch` can name hundreds; without a bound one call could
 * dominate a journal record. The list is evidence, not a manifest, so
 * `modifiedPathsTruncated` records that files were dropped — a consumer must
 * never read the surviving entries as "these were the only files changed".
 */
const MODIFIED_PATHS_CAP = 64;

/**
 * Maximum bytes for any single persisted path. The count cap above bounds how
 * many files survive; this bounds how large one can be, so a single malformed or
 * pathological entry cannot dominate a record on its own. Real paths are far
 * shorter than this (Windows ~260 chars, POSIX `PATH_MAX` 4096 bytes), so 512
 * is generous while keeping 64 paths under ~32 KiB.
 */
const MODIFIED_PATH_MAX_BYTES = 512;

/** Appended to a path cut at the byte bound. A shortened entry is not a real
 *  path, and a consumer reading the journal must never take it for one — the
 *  same "never let partial evidence read as complete" rule the count cap obeys.
 *  Costs 3 UTF-8 bytes, reserved from the budget below. */
const TRUNCATED_PATH_MARKER = '…';

/**
 * A refused call is a `denied` fact and an aborted one `cancelled` — not the
 * same `failure` as a tool that ran and broke. Legacy events without a
 * settlement keep the old ok/failure split.
 */
function toolOutcome(ok: boolean, settlement: ToolSettlement | undefined): ChronicleOutcome {
  switch (settlement) {
    case 'denied_by_policy':
    case 'blocked_by_hook':
    case 'declined':
      return 'denied';
    case 'aborted':
      return 'cancelled';
    case 'completed':
      return 'success';
    case 'failed':
    case 'invalid_input':
    case 'unknown_tool':
      return 'failure';
    default:
      return ok ? 'success' : 'failure';
  }
}

/** Persist the complete tool lifecycle. Resource edges discovered in results
 *  (files/symbols/commands touched) are windowed by rollup-adapter.ts instead
 *  of persisted raw here. */
export function wireToolsToChronicle(options: ChronicleToolAdapterOptions): () => void {
  const unsubs = [
    options.events.on('tool.loop_detected', (event) => {
      persist(
        options,
        {
          sessionId: event.sessionId,
          agentId: event.ctx.agentId,
          provider: event.ctx.provider.id,
          model: event.ctx.model,
          name: 'loop_detector',
        },
        {
          eventType: 'tool.loop_detected',
          outcome: 'failure',
          attributes: {
            tools: event.tools,
            repeatCount: event.repeatCount,
            iteration: event.iteration,
            kind: event.kind,
            action: event.action,
            scope: event.scope,
          },
        },
      );
    }),
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
        outcome: toolOutcome(event.ok, event.settlement),
        durationNs: millisecondsToNanoseconds(event.durationMs),
        attributes: {
          toolName: event.name,
          ok: event.ok,
          ...(event.settlement ? { settlement: event.settlement } : {}),
          outputPreview: capPreview(output),
          outputHash: hashText(output),
          outputBytes: event.outputBytes,
          outputTokens: event.outputTokens,
          outputLines: event.outputLines,
          metadata: event.metadata,
          fileStats: event.ok
            ? scrubFileStatsPaths(options.scrubber, fileToolStats(event.name, output, event.input))
            : undefined,
        },
      });
    }),
    options.events.on('tool.failed', (event) =>
      persist(options, event, {
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
          // A failed call may still have written to disk. Persisted as its own
          // field (never parsed back out of `detail`) so a consumer can report
          // real damage as structure. Presence only — never line evidence.
          ...modifiedPathsAttribute(options.scrubber, event.modifiedPaths),
        },
      }),
    ),
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
  return () =>
    unsubs.forEach((unsubscribe) => {
      unsubscribe();
    });
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

/**
 * Cut `value` to `maxBytes` UTF-8 bytes and mark it as shortened.
 *
 * Walks the cut back one byte at a time until the prefix both decodes cleanly
 * and fits the budget. Dropping only trailing continuation bytes is not enough:
 * a cut that lands straight after a LEAD byte leaves an incomplete sequence,
 * which decodes to U+FFFD — and U+FFFD costs 3 bytes of its own, so the result
 * would sit back OVER budget even though the slice looked short.
 */
function boundPath(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(TRUNCATED_PATH_MARKER, 'utf8');
  const budget = Math.max(0, maxBytes - markerBytes);
  const bytes = Buffer.from(value, 'utf8');
  let end = Math.min(bytes.length, budget);
  let head = '';
  while (end > 0) {
    head = bytes.subarray(0, end).toString('utf8');
    if (!head.includes('\uFFFD') && Buffer.byteLength(head, 'utf8') <= budget) break;
    end -= 1;
  }
  return `${head}${TRUNCATED_PATH_MARKER}`;
}

/**
 * `patchFiles[].path` is parsed out of a unified diff the model supplied, so it
 * is untrusted text bound for a durable journal — the same treatment
 * `modifiedPaths` gets. Scrubbing happens AFTER the parse so the parser reads
 * the original diff and redaction can never shift its line offsets.
 */
function scrubFileStatsPaths(
  scrubber: SecretScrubber,
  stats: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const files = stats?.patchFiles;
  if (!Array.isArray(files)) return stats;
  return {
    ...stats,
    patchFiles: files.map((entry) => {
      const path =
        entry && typeof entry === 'object' ? (entry as { path?: unknown }).path : undefined;
      return typeof path === 'string' ? { ...entry, path: scrubber.scrub(path) } : entry;
    }),
  };
}

/**
 * Bound and scrub the files a failed call had changed on disk.
 *
 * Paths are operator-supplied text on their way into a durable journal, so they
 * go through the same scrubber as tool output. The list is capped so a `patch`
 * naming hundreds of files cannot dominate a single record, and dropping
 * entries is announced rather than silent — a truncated list must never be read
 * as "these were the only files changed".
 */
function modifiedPathsAttribute(
  scrubber: SecretScrubber,
  paths: string[] | undefined,
): Record<string, unknown> {
  if (!paths?.length) return {};
  const valid = paths.filter((path): path is string => typeof path === 'string' && path.length > 0);
  if (!valid.length) return {};
  const kept = valid.slice(0, MODIFIED_PATHS_CAP);
  // Scrub BEFORE bounding. Cutting first could split a secret across the byte
  // boundary, leaving a fragment the scrubber's pattern no longer matches — a
  // redacted path that still leaks. Scrubbing the whole string first means the
  // pattern always sees an intact secret.
  const scrubbed = kept.map((path) => scrubber.scrub(path));
  const bounded = scrubbed.map((path) => boundPath(path, MODIFIED_PATH_MAX_BYTES));
  return {
    modifiedPaths: bounded,
    ...(valid.length > MODIFIED_PATHS_CAP ? { modifiedPathsTruncated: true } : {}),
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
function capPreview(
  value: string,
): string | { preview: string; truncated: true; totalBytes: number } {
  // Fast path: short strings need only a cheap byteLength check for multibyte safety.
  if (value.length <= PREVIEW_MAX_BYTES) {
    if (Buffer.byteLength(value, 'utf8') <= PREVIEW_MAX_BYTES) return value;
  }
  // Over (or possibly over) budget: encode once — buf.length is the authoritative byte count.
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= PREVIEW_MAX_BYTES) return value;
  // Walk back to the nearest valid UTF-8 character boundary.
  let end = PREVIEW_MAX_BYTES;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return {
    preview: buf.subarray(0, end).toString('utf8'),
    truncated: true,
    totalBytes: buf.length,
  };
}

function millisecondsToNanoseconds(durationMs: number): string {
  return Math.round(durationMs * 1_000_000).toString();
}
